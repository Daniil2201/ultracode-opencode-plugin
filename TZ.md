# ТЗ: ultracode

## Мета
- Версия: 1.1
- Дата: 2026-09-30
- Статус: draft (заполнено, ждёт согласования)
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

TypeScript (ESM, `.ts`-импорты с расширением), Node.js ≥ 22 (проверено на v24.20.0),
opencode 1.18.27+ (бинарь 1.18.31), `@opencode-ai/plugin` 1.18.27, `js-tiktoken` 1.0.21
(реальный `cl100k_base` для бюджета), `node:test` как раннер (без vitest/jest/bun),
bash для обвязки (`scripts/*.sh`, `tests/install-smoke.sh`). Зависимостей не добавляем:
всё на stdlib. Фреймворков нет — плагин, а не приложение.

## Нефункциональные требования

- **Регресс-гейт:** 229 существующих тестов (`node --test .opencode/tests/*.test.ts
  .opencode/tests/runtime/*.test.ts .opencode/tests/adversarial/*.test.ts`) не должны
  падать; baseline — 225 pass / 4 fail, где 4 падения принадлежат `farm/` (см. открытые
  вопросы).
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
9. Полный прогон: `ℹ pass 225` и `ℹ fail 4` (без роста fail), либо 229 при переносе
   `farm/`.
10. `bash .opencode/tests/install-smoke.sh` → не хуже 50 OK / 1 MISS (MISS — `farm.ts`,
    ферма вне scope).

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

## Открытые вопросы

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
