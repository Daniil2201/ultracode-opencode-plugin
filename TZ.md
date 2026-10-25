# ТЗ: ultracode

## Мета
- Версия: 1.2
- Дата: 2026-10-25
- Статус: draft (дополнение v1.2; ждёт решения по открытым вопросам)
- Автор: пользователь

## Что это

Ultracode — плагин-агент для opencode, который превращает работу ИИ в проверяемый
процесс: план с acceptance-критериями, evidence-gate, бюджет контекста, handoff при
сжатии, SDD (spec → bolt → verify) и AFD-порядок этапов. Он живёт как локальный
`.opencode/` внутри проекта и ставится глобально скриптом синхронизации.

Этот проект — усиление Ultracode через интеграцию внешних практик, а не новый продукт
и не ремастер. Существующие механизмы (бюджет и пороги, handoff, checkpoint, SDD,
AFD, evidence, метрики, инъекция контекста, лабораторная оценка) работают и не
переписываются. Разбираем три конкретные дыры, найденные разведкой 2026-09-30:

1. **Evidence-гейт доверяет агенту.** `applyEvidence` (`verification.ts:412-421`)
   ставит шагу `done`/`failed` напрямую по переданному `exitCode`, не вызывая
   `transitionStep`: не проверяется ни текущий статус шага, ни `dependsOn`, ни
   совпадение `command` с `plan.acceptance.command`. Шаг в статусе `todo`, который
   никто не начинал, получает `done`. Ни один `spawn` в ветке `action==="evidence"`
   (`plugin/ultracode.ts:1521-1550`) не выполняется — по замыслу автора
   (`verification.ts:2`: «Плагин НЕ запускает произвольный shell автоматически»).
2. **Sentinel pre-check отсутствует.** `rg -i "sentinel|precheck|pre_check"` по трём
   копиям — 0 совпадений в коде. Перед evidence нет ни синтаксической проверки, ни
   детекта ghost comments, ни детекта scope creep, ни проверки пустого шага.
3. **Skill-роутинг теряет скиллы без телеметрии.** Правило «Skills FIRST» живёт
   только в промпте агента (`agents/ultracode.md:14-21`). По БД сессий: 125 вызовов
   skill-тула за всю историю в 50 сессиях из 198 (~25%). Прямого счётчика «правило
   сработало» нет ни в логе, ни в сторе. Роустер раздут: 109 глобальных скиллов
   против 44 профильных в my-manager; в самом проекте локальных скиллов 0.

Дополнительно вскрыт мёртвый код: `autonomy.ts` (8 экспортов, 0 импортов плагином),
`stepNeedsEvidence` (`verification.ts:423`, 0 вызовов), `claimStep` (`plan.ts:98`,
0 вызовов). Они покрыты тестами, но в рантайме не участвуют.

## Отношение к существующему коду

**Частичная переработка.** Ядро остаётся: 26 модулей `lib/ultracode/` и
`plugin/ultracode.ts` совпадают побайтово с `my-manager` и `~/.config/opencode`
(SHA-256, проверено 2026-09-30). Ни один существующий модуль не переписывается с нуля.

Добавляется:
- `lib/ultracode/sentinel.ts` — новый модуль, 4+1 чека, чистые функции, без I/O в стор.
- Правки в `verification.ts` — `applyEvidence` начинает ходить через `transitionStep`
  и сверять команду с acceptance.
- Правки в `plan.ts` — точка вызова sentinel (без изменения существующих переходов).
- Правки в `plugin/ultracode.ts` — вызов sentinel в ветке `action==="evidence"`.
- Новый тест `tests/sentinel.test.ts` в существующий стиль `node:test`.

## Что переносится из существующего проекта

Всё существующее переносится **да**, копированием, без изменений:

- Код ядра (`plugin/`, `lib/`) — да, побайтово.
- `tests/` — да, 40 `.test.ts` + фикстуры + `install-smoke.sh`.
- `scripts/` — да, 5 скриптов в корень проекта (`evaluate-ultracode.sh` и др.).
- `agents/` (5) и `commands/` (13) — да, в plural-каталоги, как требует обвязка.
- `skills/` — да, 44 локальных скилла.
- `README.md`, `templates/tz.md`, `.opencode/package.json` — да.

Не переносится: `farm/` (Rust MCP tg-manager) и `plugin/farm.ts`,
`plugin/guardrails.ts`, `plugin/agentmemory-capture.ts` — они принадлежат my-manager.
`my-manager` не трогаем.

Конфликтов при переносе не было: `plugin/ultracode.ts` и все 19 модулей `lib/`
идентичны во всех трёх копиях. Единственное выравнивание — версия
`@opencode-ai/plugin` в `.opencode/package.json` приведена к 1.18.27 (как в my-manager).

## Функциональность

- [must] **Evidence-гейт не доверяет агенту.** `applyEvidence` принимает шаг только из
  `in_progress | verify_required`, сверяет `evidence.command` с
  `plan.acceptance.command` (расхождение → `failed` с внятной причиной), вызывает
  `transitionStep` вместо прямой записи статуса. Ветка `todo → done` больше невозможна.
- [must] **Sentinel pre-check.** 5 проверок перед evidence: syntax/lint, ghost comments,
  changelog, task-to-file match, empty step. Результат — advisory-отчёт, без spawn
  произвольного shell, без записи в стор, без блокировки.
- [must] **Судьба мёртвого кода.** `autonomy.ts`, `stepNeedsEvidence`, `claimStep` —
  либо подключить к рантайму с тестами, либо удалить. Мёртвый код с зелёными тестами
  хуже отсутствия кода: он создаёт ложное покрытие.
- [should] **Skill-роутинг.** Чистка роустера до 40–50 профильных скиллов, точечные
  deny-паттерны в `permission.skill` для мусорных имён, телеметрия выбора скилла
  (иначе «0–2 из 7» останется недоказуемым).
- [could] **Headroom** (`headroom-opencode` 0.39.1, нужен Python-прокси на :8787) —
  только после того, как измерена доля расхода контекста на API-JSON против роустера
  скиллов и инъекций.
- [won't] **Jev** (`opencode-jev` 0.1.0) — платный, биллится за каждую классификацию;
  чинит выбор скилла, но не дубли имён. **opencode-skills** — помечен DEPRECATED,
  конфликтует с нативным `permission.skill`. **opencode-jev-router** — unpublished
  2026-09-29, 404. **@robertn702/opencode-jev-router** — требует OpenCode V2.

## Границы (что НЕ входит)

- Не переписывать ядро: 26 модулей `lib/ultracode/` и `plugin/ultracode.ts` правятся
  точечно, рефакторинг «на вкус» — вне scope.
- Sentinel не spawn'ит произвольный shell. Разрешён только фиксированный read-only
  `git status --porcelain` (прецедент есть: `plugin/ultracode.ts:230`) и разбор уже
  записанного evidence. Allowlist-spawn (`php -l`, `tsc --noEmit`) — отдельное
  решение, не в этой версии.
- Не трогать `my-manager` — ни файлов, ни тестов, ни запуска фермы.
- Не интегрировать внешние компоненты, пока не закрыты свои дыры (evidence, sentinel,
  мёртвый код).
- Не добавлять spawn в `applyEvidence`: гейт остаётся «доверительным», но
  **проверяемым** (команда, статус, зависимости сверяются), а не «исполняющим».
- Не менять формат стора (`context.json`, схема v3) и не добавлять полей в
  существующие структуры без миграции.
- Не трогать игровые песочницы.

## Технологический стек

Baseline v1.1 зафиксирован 2026-09-30; активные runtime-версии на 2026-10-25 указаны отдельно:

TypeScript (ESM, `.ts`-импорты с расширением), Node.js ≥ 22 (проверено на v24.20.0),
opencode 1.18.27+ (бинарь v1.18.31 на дату исходного ТЗ), `@opencode-ai/plugin` 1.18.27, `js-tiktoken` 1.0.21
(реальный `cl100k_base` для бюджета), `node:test` как раннер (без vitest/jest/bun),
bash для обвязки (`scripts/*.sh`, `tests/install-smoke.sh`). Зависимостей не добавляем:
всё на stdlib. Фреймворков нет — плагин, а не приложение.

Текущая проверенная среда v1.2: `opencode v2.0.32`, `@opencode-ai/plugin` и SDK `1.18.27`.

## Нефункциональные требования

- **Регресс-гейт:** полный suite (`node --test .opencode/tests/*.test.ts
  .opencode/tests/runtime/*.test.ts .opencode/tests/adversarial/*.test.ts`) не должен
  ухудшать актуальный baseline 349 total / 346 pass / 0 fail / 3 skip
  (проверен 2026-10-25; skip — отсутствующий farm binary). Исторический baseline
  225 pass / 4 fail superseded.
- **Скорость sentinel:** < 2 сек на шаг на проекте до 10k файлов; только fs + фиксированный git.
- **Откат:** каждое изменение — отдельный обратимый diff; затрагивать store нельзя,
  иначе откат ломает данные.
- **Секреты:** sentinel не выводит содержимое файлов и окружение; `redactConfidential`
  применяется к любому тексту, попадающему в отчёт.
- **Детерминизм:** одинаковый вход (шаг + evidence + состояние git) → одинаковый
  `SentinelResult`, без времени и случайности в решениях.

## Acceptance Criteria

1. Evidence не закрывает шаг из `todo`: `applyEvidence` на шаге в статусе `todo`
   бросает/возвращает `failed`, статус остаётся `todo`. Проверяется тестом.
2. `command` не совпадает с `plan.acceptance.command` → `failed` с внятной причиной.
   Проверяется тестом.
3. Sentinel ловит `php -l` ошибку: evidence со строкой `PHP Parse error` (или
   `syntax error, unexpected`) → check `syntax` = `fail`.
4. Sentinel ловит ghost comments: файл из шага с `TODO`/`FIXME`/`HACK` → check
   `ghost-comments` = `fail`.
5. Файл вне плана → `warn`, не `fail` (расширение scope не блокирует, а сигналит).
6. Пустой шаг (нет цели, нет acceptance, нет файлов) → check `empty-step` = `fail`.
7. Sentinel ничего не пишет: снимок `context.json` до и после `sentinelCheck` побайтово
   идентичен.
8. `node --test .opencode/tests/sentinel.test.ts` → exit 0.
9. Полный прогон: 349 total / `ℹ pass 346` / `ℹ fail 0` / `ℹ skipped 3`
   (проверено 2026-10-25; историческое `225/4` superseded, `farm/` не переносится).
10. `bash .opencode/tests/install-smoke.sh` → пройти; прежнее ожидание 50 OK / 1 MISS
    является историческим и должно быть перепроверено перед реализацией.

## Этапы (AFD)

AFD применим: сначала tools для агента, потом API, потом UI (UI нет — это плагин).

1. **Tools — чинка слоя доверия.** Этап 1 (ТЗ): закрыть дыру evidence-гейта —
   `verification.ts` + `plan.ts` + тесты. Это фундамент: пока гейт доверяет агенту,
   всё, что построено поверх (sentinel, spec, AFD), держится на честности модели.
2. **Tools — Sentinel.** Этап 2 (ТЗ): `lib/ultracode/sentinel.ts` — 5 чистых чеков,
   тест `sentinel.test.ts`. Валидация: прогон на реальных шагах этого проекта.
3. **Интеграция.** Этап 3: точка вызова в `plugin/ultracode.ts` (ветка `evidence`),
   advisory-отчёт в summary. Доказательство: `ultracode_context action=evidence` на
   шаге с расхождением command/acceptance даёт внятный отчёт.
4. **Чистка.** Этап 4: судьба мёртвого кода (`autonomy.ts`, `stepNeedsEvidence`,
   `claimStep`) — подключить или удалить, с обновлением тестов.
5. **Skill-роутинг.** Этап 5: чистка роустера, `permission.skill` deny-паттерны,
   телеметрия выбора скилла. Независим от этапов 1–4, можно параллельно.
6. **Headroom** — вне плана, только после замера расхода контекста.

## Открытые вопросы v1.1 (исторический список; актуальные статусы ниже)

Вопросы ниже были открыты в исходном draft 2026-09-30; таблица «Сверка открытых вопросов v1.1» ниже фиксирует, что уже закрыто и что ещё требует решения.

1. **Sentinel: advisory или allowlist-spawn?** Check `syntax/lint` без spawn ловит
   только ошибки, уже попавшие в вывод acceptance-команды. Настоящий `php -l` /
   `tsc --noEmit` требует запуска. Нужен ли фиксированный allowlist (как у `/evaluate`)
   или advisory достаточно?
2. **Телеметрия скиллов: `metrics.jsonl` или отдельный поток?** `metrics.jsonl`
   уже пишется на сессию; новый вид событий — расширение схемы или новый файл.
3. **4 упавших теста.** `tests/runtime/mcp-runtime.test.ts` спавнит
   `farm/target/debug/tg-manager-mcp`, которого в этом проекте нет by design. Что
   честнее: оставить падающим (229/225 с видимым объяснением), перенести `farm/`
   сюда, или научить тест пропускать отсутствующий бинарь (`t.skip`)?
4. **`install-farm.sh` в новом доме.** Скрипт — установщик *фермы*: он делает
   `cd farm && cargo build --release -p mcp` (`install-farm.sh:38`) и переписывает
   путь `mcp.tg-manager` в глобальном конфиге на `$ROOT/farm/target/release/...`
   (`:104-110`). Запускать его из `Ultracode/` нельзя: `farm/` нет → `set -e` валит
   скрипт на строке 38, а с затычкой он сломал бы ферму во всех проектах. Нужна
   ли отдельная утилита синхронизации ultracode-части (`scripts/sync-ultracode.sh`)
   без ферменной логики?
5. **Дубль плагина в merged-конфиге.** Глобальная запись `./plugin/ultracode.ts`
   плюс авто-discovery проекта дают два инстанса одного плагина. Синхронизация
   (`install-farm.sh:112`) добавляет глобальную запись обратно.
6. **Версия `@opencode-ai/plugin`.** opencode при старте переписывает
   `.opencode/package.json` на свою (1.18.31). Выравнивание на 1.18.27 может быть
   перезаписано — нужно ли это учитывать в CI?

## Сверка открытых вопросов v1.1 (2026-10-25)

| № | Статус | Основание / решение для текущего обновления |
|---|---|---|
| 1 | Решён | Sentinel остаётся advisory; произвольный shell не запускает, разрешён только фиксированный `git status --porcelain`. См. `spec/sentinel.md` и `lib/ultracode/sentinel.ts`. |
| 2 | Решён для v1.2 | Основной поток метрик уже `metrics.jsonl`; имя skill сейчас сохраняется в knowledge-сторе. Для телеметрии делегации используем существующий `metrics.jsonl`, отдельный поток не добавляем. Отдельная расширенная телеметрия скиллов вне scope этого обновления. |
| 3 | Решён | Тесты farm явно пропускаются без бинаря. Проверенный прогон 2026-10-25: 346 pass / 0 fail / 3 skip; старый baseline 225/4 устарел. |
| 4 | Решён | `scripts/sync-ultracode.sh` существует и синхронизирует только Ultracode-часть; `install-farm.sh` из этого проекта не запускается. |
| 5 | Решён для v1.2 | Read-only проверка `~/.config/opencode/opencode.json` на дубликаты plugin-записей — read-only, без записи. Если файл нечитаем или повреждён, вернуть ошибку и остановиться. Запускать эксперимент только в disposable copy, не в рабочем дереве. |
| 6 | Решён для v1.2 | Эксперимент по перезаписи `.opencode/package.json` — в disposable copy: скопировать `.opencode` во временную директорию, запустить opencode, зафиксировать, изменился ли package.json. Не запускать в рабочем дереве проекта. |

## Дополнение к ТЗ v1.2: выбор модели для подзадач и надёжность плагина

- **Статус:** draft; исходная спецификация v1.1 сохранена как история. Это дополнение не разрешает начинать реализацию без отдельного `/bolt` или `/goal`.
- **Цель:** дать Ultracode per-call выбор уже настроенной модели для subagent-задачи и добавить в обновление устранение подтверждённых дефектов из `spec/plugin-error-audit.md`.
- **Текущий контракт:** встроенный OpenCode `task`/subagent не принимает модель на отдельный вызов; роли задаются в `.opencode/agents/`. Установленный SDK 1.18.27 умеет связать child через `session.create(parentID)` и передать `agent`/`model` в `session.prompt`. Модель не добавляется в `PlanStep` и не сохраняется между resume в этой версии.
- **Обязательное:** новый plugin tool делегирования принимает роль и опциональные `providerID/modelID`, проверяет модель по уже настроенным провайдерам, возвращает ответ ребёнка с фактически использованной моделью; не добавляет provider/key/tier, не меняет текущий evidence-gate и не закрывает шаг автоматически.
- **Обязательное:** исправить P1 из `spec/plugin-error-audit.md`: исполнение команд для внешнего `evaluate --target` без отдельного trust gate; чтение `farm-state` через symlink; fail-open redaction; lost update/ложное подтверждение `learn`; handoff без retry после ошибки записи; падение `system.transform` на malformed persisted thread; постоянный отказ Budget Manager после transient provider error; потерю per-step acceptance при создании плана. Dispatcher не меняет evidence-gate; отдельная PLAN-01 работа может изменить producer/consumer per-step acceptance.
- **Acceptance только через команды.** `PlanStep.check` в v1.2 — только shell-команда с детерминированным exit code (0 = pass, 1 = fail). Любая «проверка строки/паттерна» должна быть упакована в команду (например, `grep -q 'pattern' file.txt`). File/line verifier исключён: языковые модели галлюцинируют, exit code — детерминированный факт. Изменить `commands/bolt.md` соответственно.
- **Требования к оркестрации:** сохранить зависимости шагов, не более 3 параллельных делегаций, retry до 3 попыток и текущий контракт `planId/stepId` + evidence. Новая диспетчеризация не должна опираться на `runAutonomousGoal`, пока его фактическая последовательность/resume не исправлены; текущий `/goal` dispatch задан инструкциями проекта и ещё не подтверждён в runtime v2.0.32.
- **Рекомендуемое:** синхронизировать поля/имена между `/bolt`, `ultracode-help`, `recall_pruned` и runtime tool; исправить скрытые ошибки recall; убрать неоднозначные `kind` для knowledge; выбрать активный план в `plan_show`; валидировать конечность usage; записывать исключения pruner в уже существующий диагностический лог; освобождать session-scoped state.
- **Ограничения:** никаких правок глобального OpenCode-конфига, `my-manager`, `farm/`, `EventKind`, новых зависимостей или нового публичного HTTP API. Не менять storage schema v3 ради временного model override. Если позже потребуется сохранять модель в плане, это отдельная миграция.
- **Обязательное (Q5/Q6):** read-only проверка `~/.config/opencode/opencode.json` на дубликаты plugin-записей (read-only, без write/patch; файл нечитаем → вернуть ошибку, не чинить); эксперимент перезаписи `.opencode/package.json` в disposable copy (mktemp -d, скопировать .opencode, запустить opencode, зафиксировать изменение). Не запускать эксперимент в рабочем дереве.
- **Acceptance только через команды:** `PlanStep.check` = shell-команда с exit code (0/1). Проверки строк/паттернов упаковываются в команду (`grep -q 'pattern' file.txt`). File/line verifier исключён — языковые модели галлюцинируют, exit code детерминирован.
- **AFD:** 1) plugin tool + корневые исправления (Tools); 2) unit/runtime-проверка на fake client и установленном SDK (Validation); 3) проверка совместимости внутреннего OpenCode session API на v2.0.32 без нового публичного API; 4) UI отсутствует.
- **Acceptance:** `spec/subagent-model-routing.md` и `spec/plugin-error-audit.md` являются источником требований; каждая P1 имеет регрессионный тест; полный suite не хуже 346 pass / 0 fail / 3 skip; тест запускается против реальной формы SDK 1.18.27, а model-routing smoke — на OpenCode v2.0.32. Успешный dispatcher не может сам переводить шаг в `done`.
- **Решённое открытые вопросы:** (1) read-only проверка глобального конфига разрешена — только чтение, без write/patch, ошибка чтения = стоп; (2) эксперимент перезаписи `.opencode/package.json` включён в acceptance, только в disposable copy; (3) per-step acceptance — только команды с exit code, file/line verifier исключён.

## Критическая находка runtime smoke (2026-10-25)

OpenCode v2.0.32 **не загружает** V1-плагины (`export default (async (ctx) => {...})`). Все V1-плагины отклоняются:
`Plugin must export a default definition with an id and an effect or setup function.`

Это означает:
1. Весь Ultracode plugin должен быть мигрирован на V2-формат (`Plugin.define({ id, setup })`).
2. V2 Plugin API предоставляет `ctx.session.create({parentID, agent, model})` — модель при создании сессии.
3. Все P1 дефекты должны реализовываться через V2 hooks, а не V1.
4. Go/No-Go gate 11 пересматривается: сначала миграция, затем smoke.

Полный отчёт: `out/runtime-smoke-v2.0.32.md`.
