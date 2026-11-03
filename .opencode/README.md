# Ultracode — универсальный оркестратор

Плагин OpenCode: ведёт большие задачи от цели до проверяемого результата —
исследует, планирует, делегирует саб-агентам, реализует, тестирует и чинит
ошибки сам. Хранит кросс-сессионную память, считает токены, скрывает секреты
и выставляет себе лабораторную оценку.

Связанные документы: `ULTRACODE-V2-ISSUES.md` (бэклог UC-001…UC-022, EV-001…EV-007),
`ULTRACODE-EVALUATION.md` (протокол лабораторной оценки).

## Состав

Состав проекта генерируется из кода — см. блок ниже (обновляется
`bash scripts/build-docs.sh`). Правь исходники, не этот список.

Глобальная установка (`~/.config/opencode/`) — скриптом `scripts/sync-ultracode.sh`:
он копирует только plugin/lib/agents/commands/skills/templates и **не трогает**
`opencode.json`, `mcp.*` и ферму. **После любых правок нужен рестарт OpenCode** —
плагин грузится один раз при старте.

<!-- AUTO:inventory -->

```text
.opencode/
  plugin/
    agentmemory-capture.ts    [233 строк]
    guardrails.ts             [45 строк]
    ultracode.ts             # ядро: хуки, инъекция, инструмент ultracode_context  [1580 строк]
  lib/ultracode/   # чистая логика (stdlib only, покрыта тестами)
    autonomy.ts              32 строк  UC-013 — policy автономности. ЕДИНСТВЕННЫЙ источник текста, кото
    budget.ts                99 строк  Budget Manager: снимок usage на сессию + пороги. Чистые функции,
    checkpoint.ts            28 строк  UC-010 — checkpoint при compaction: только компактный summary, б
    classifier.ts            98 строк  UC-005 — классификатор сложности. Чистый hint, без сайд-эффектов
    confidential.ts         166 строк  UC-021 — confidential-data firewall: модель видит вёрстку/структ
    debug.ts                109 строк  UC-022 — debugger workflow: reproduce → isolate → hypothesize → 
    design.ts                42 строк  UC-009 — явный Open Design workflow. Никакого авто-запуска по сл
    handoff.ts               50 строк  Handoff сброса контекста: писатель/читатель. Запись — через upda
    injection.ts            262 строк  UC-003 — идемпотентная инъекция + раздельные бюджеты.
    metrics.ts              150 строк  UC-004 — session-scoped метрики + корректные ошибки + bounded me
    orchestrator.ts          69 строк  UC-006 + UC-014 — оркестрация: готовые шаги, батчи, ретраи.
    plan.ts                 189 строк  UC-002 — модель плана и безопасные переходы статусов.
    prune-store.ts          202 строк  Стор оригиналов context-pruner. Отдельный append-only jsonl рядо
    pruner.ts               396 строк  context-pruner: сжатие истории сообщений перед отправкой в LLM.
    report-verify.ts        117 строк  UC-report-verify — детерминированная верификация отчетов агента.
    runtime-contract.ts     168 строк  UC-017 — runtime-контракт tool `ultracode_context`: единый источ
    schema.ts               352 строк  Ultracode v3 — схема хранилища. Только типы + чистая миграция, б
    sentinel.ts             221 строк  UC-029 — Sentinel: дешёвые advisory-проверки шага плана перед фи
    skill-router.ts         271 строк  UC-032 — skill-router: дешёвый детерминированный роутер по скилл
    stack-contract.ts       221 строк  UC-025 — единый контракт «работающий проект»: один интерфейс,
    stack-detect.ts         218 строк  UC-023 — автоопределение стека проекта для acceptance по умолчан
    store.ts                146 строк  UC-001 — надёжное хранилище v3: per-project файлы + atomic save 
    tokens.ts               105 строк  Токены: реальный cl100k_base (js-tiktoken, CJS) + fallback-эврис
    verification.ts         447 строк  UC-007 — evidence-gated verification. Шаг закрывается только evi
    evaluation/            7 модулей
  agents/          # 5: ultracode, ultracode-designer, ultracode-executor, ultracode-planner, ultracode-reviewer
  commands/        # 13: bolt, checkpoint, debug, design, evaluate, goal, spec, status, tz-check, tz-init, tz-refine, ultracode-help, verify
  skills/          # 55 скиллов
```

<!-- /AUTO:inventory -->
## Как работает

### Хуки (`plugin/ultracode.ts`)

| Хук | Что делает |
|---|---|
| `experimental.chat.system.transform` | Инжектит ponytail/skills/autonomy-теги, ранжированные знания в токен-бюджете, уроки, farm-state; пишет `lastInjection` |
| `experimental.session.compacting` | Кладёт checkpoint плана + выжимку стора, без переписывания истории |
| `tool.execute.after` | Метрики по `sessionID`, лог `skill()`-вызовов, firewall на `output.output`, ошибки → blocker+lesson |
| `chat.message` | Авто-извлечение решений по маркерам, счётчик сообщений |
| `event(session.idle)` | Факт завершения сессии |

### Память (store v3)

- Per-project файлы `projects/<slug-hash>/context.json` (legacy global — только fallback-миграция).
- Записи как issues: `kind` (decision/fact/progress/blocker/digest), `labels`, `source` (файл:строка/URL), `status`, треды.
- Atomic save (`tmp+rename`) + lockfile против last-writer-wins; битый JSON → fresh store.
- Бюджеты инъекции: knowledge 2000 tok (настраивается `budget`), lessons 600; лимиты 200 знаний / 80 уроков, digest старше 30 дней.
- Git-история стора: `history` / `diff`.

### Автономность (bounded autonomy)

- Внутри цели: исследование, `task`-делегация, MCP-read, правки, тесты, сборка, retry до 3 раз — **без спроса**.
- Уточняющие вопросы — только при blocking ambiguity (макс. 3 за раз), иначе safe default + допущение.
- Подтверждение — только перед необратимым/внешним: удаление, публикация, секреты, миграции, массовые изменения, Open Design run.
- «Стоп» останавливает план. Scope не расширяется на несвязанные баги.

### Skills FIRST

Никакая разработка без загруженного скилла: агент сканирует `available_skills`,
грузит профильный через `skill("имя")` до кода и называет его в ответе.
Каждый вызов `skill()` логируется в стор (`#skill`).

### Оркестрация (`/goal`)

```text
/goal <цель> → plan_new → parallel task (planId+stepId, maxParallel=3)
→ verify_required → /verify (evidence exit 0) → done | failed → retry×3 → blocker
```

Статусы шагов: `todo → in_progress → verify_required → done|failed`.
`done` без успешного evidence невозможен; stale evidence чужой попытки не закрывает шаг.
Зависимые шаги ждут `dependsOn`; план переживает рестарт (`plan_show`).

### Стек проекта (`stack-detect.ts`)

На старте сессии плагин смотрит манифесты (`package.json`, `Cargo.toml`,
`pyproject.toml`, `go.mod`, `composer.json` — корень + 1 уровень для монорепо),
`Makefile`/`justfile` target `test`, `.github/workflows` и пишет стек в стор.
Агент видит строку `<ultracode-stack stack=rust dir=farm test="cargo test" ...>`,
а `plan_new` без явного `acceptanceCommand` подставляет test-команду стека
(с пометкой `auto:` — явная команда всегда важнее). Нет манифестов — дефолта
нет, acceptance остаётся ручным: не выдумываем.

### Контракт «работающий проект» (`stack-contract.ts`)

Один интерфейс, реализации на стек (Strategy + Factory):

```ts
detectContract(root) // → StackContract | null, никогда не бросает
contract.test()      // npm test | cargo test | pytest | ...
contract.build()     // cargo build | go build ./... | null
contract.lint()      // cargo clippy | null
contract.typecheck() // cargo check | go vet ./... | null
contract.run()       // null, пока нет честного способа отличить бинарь
```

Правила честности: `test()` наследует разрешённую UC-023 команду (включая
`Makefile`-entrypoint); остальное возвращается, только если подтверждено
проектом (скрипт в манифесте / конвенция стека), иначе `null`.
Python/Php обещают только `test` — универсальных build/lint/run нет, и это
зафиксировано, а не оставлено на угадайку. Агент спрашивает через
`ultracode_context` → `contract` (JSON таблицы).

### Confidential firewall (`confidential.ts`)

Модель видит структуру, секретов — никогда. Режется на 5 границах
(storage, evidence, metrics, tool output — рекурсивно любой формы, farm-инъекции):

- `.env`/конфиги/логи/JSON/YAML: `KEY=VALUE`, `"KEY": "VALUE"`, `KEY => VALUE`,
  camelCase (`apiKey`), dotted (`api.key`), spaced (`api key =`), составные
  (`secret_key`, `password_hash`, `token_secret`), короткие (`pass=`);
- Bearer/Basic (включая `Bearer:`, короткие токены, plaintext `user:pass`),
  `sk-/sk_live_/gh*/github_pat_/xox*/AKIA*/AIza*`, `bot<id>:<hash>`, JWT,
  private-key блоки, credential-URL (`https/ssh/redis/postgres/mysql/mongodb`);
- куки `PHPSESSID/JSESSIONID/ASPSESSIONID/sid/Auth` (и `sid:`, код `getId()` не трогаем);
- hidden/password инпуты в любом порядке/регистре, `<textarea>`, `data-*`;
- email (включая кириллицу и `%40`), телефоны (10–15 цифр, fullwidth тоже);
- URL-encoded (`%3D`), перенесённые (`=\` + newline) секреты.
- Обычный текст, числовые id, версии, `sessionId` в коде — не трогаются.
- Остаточный риск (зафиксирован): жёсткий перенос строго внутри значения,
  голые секреты вообще без формы опознать нельзя — это вне скоупа firewall.

### Дебаг (`/debug`)

Системный цикл `debug.ts`: reproduce → isolate → гипотезы строго по одной →
fix → **регресс-тест обязателен** (`resolveDebug` без него бросает) → verify.
Все гипотезы опровергнуты → `stuck`, а не молчаливое закрытие.

### Лабораторная оценка (`/evaluate [smoke|all]`)

Взвешенный скоринг (`evaluation/cli.ts` → `evaluateProject()`), не счёт гейтов:

| Критерий | Баллы |
|---|---:|
| correctness / tests / runtime / security / reliability / architecture / performance / docs | 30 / 20 / 15 / 15 / 10 / 5 / 3 / 2 |

13 gates: compile, unit, runtime, security, concurrency, mcp-test/clippy/fmt/release,
farm-health, install-status/smoke, repro (двойной прогон). Уровни:
`junior <60 / middle 60–79 / senior 80–94 / staff 95+`. Hard gates режут score
при compile-red, helper-only, secrets/data-loss. Performance меряет p95 gate-latency
(SLO 120s). Отчёт: `.opencode/eval-last.json` + `.md`. CI: `.github/workflows/ultracode-eval.yml`.

### Portable-оценка чужого кода (`/evaluate all --target <path>`, UC-026)

Гейты выводятся из `stack-contract` target (preflight/stack/build/test/lint/typecheck),
а не из lab-матрицы. Исходы: `pass` / `fail` / `blocked` (нет рантайма) /
`no-tests` (N/A — тестов нет, не fail) / `skipped` (команда неизвестна).
Score — только по применимым гейтам; portable-score НЕ сравним с lab 0–100.
Дробный score (1 знак), веса гейтов test=3/build=2/typecheck=1/lint=1,
взвешенные падения (code 1.0 → flaky 0.1, K=20), потолок senior при красных
тестах, cold/warm-маркер сборки. Заголовок: `Score / Tests: N/M / Gates: X/Y`.
Отчёты: `.opencode/eval-portable.json` + `.md` (у себя; target read-only).

### Open Design (`/design`)

`get_active_context` → `collect_brief` → показать brief → `confirm_brief` →
`start_run` → `get_run` → manifest → файлы строго внутри project root.
Без активного контекста — понятный blocker. MCP `open-design` ходит через
`~/.config/opencode/od-mcp-proxy.py` (фильтр `notifications/*`).

### Ферма (L1–L3)

`plugin/farm.ts` логирует вызовы tg-manager MCP в `farm/knowledge/state.md`.
MCP `tg-manager` (Rust, `farm/crates/mcp`): `generate_post` (+`fast`), `quality_check`,
`publish`, `learn_channel`, `learn_style`, `fetch_history` (default 20, cap 50,
`max_chars` cap 50 000, `truncated`), `get_knowledge` (`summary|full`).
Команды: `/generate /check /publish /fetch /learn /farm`, скилл `quality-gate`.

## Инструмент `ultracode_context`

Память: `list add search view history diff close thread compact farm` ·
метрики: `stats tokens budget anim` · планы: `plan_new plan_show plan_step` ·
проверки: `evidence evaluate` · обучение: `learn lessons`.

## Проверки

```bash
node --test .opencode/tests/*.test.ts .opencode/tests/runtime/*.test.ts .opencode/tests/adversarial/*.test.ts
./scripts/sync-ultracode.sh --status   # что в проекте, что в ~/.config/opencode, где расхождения
./scripts/evaluate-ultracode.sh --all   # 13 gates + weighted score (3 гейта требуют farm/)
../my-manager/scripts/farm-health.sh && ../my-manager/scripts/install-farm.sh --status   # скрипты фермы живут в my-manager, отсюда и относительный путь
```

Эталонное состояние — в блоке «Состояние» ниже (генерируется из прогона CI).
Правило приёмки: задача готова при зелёном acceptance **и** ревью без блокеров;
«компилируется» — не финиш.

## Состояние

Закрыто: Sentinel (сбор фактов перед вердиктом), evidence-гейт (шаг не закрыт без
успешного прогона), skill-router (алиасы + приоритет стека проекта), файрвол
секретов (fail-closed, фаззер 1000×60), autonomy (ограниченная автономия).

Ключевые числа: 14 256 токенов экономии на сообщение; skill-router top-1 26.7%,
top-3 35.6% на 345 исторических запросах (45 меток) — пересчитать
`bash scripts/skill-router-bench.sh`.

Отложено: Headroom (не нужен), Jev (не нужен), TF-IDF (не нужен), чистка скиллов.

Не проверено: живые прогоны у провайдера — `space-bunny-free` был недоступен,
проверка на реальном API не выполнена.

## Жёсткие правила

Унаследованы от `AGENTS.md`: не читать/править `config.toml`; не удалять файлы
без разрешения; не печатать секреты; не трогать `[userbot]`.

<!-- AUTO:inventory -->

```text
.opencode/
  plugin/
    agentmemory-capture.ts    [250 строк]
    guardrails.ts             [107 строк]
    ultracode.ts             # ядро: хуки, инъекция, инструмент ultracode_context  [1861 строк]
  lib/ultracode/   # чистая логика (stdlib only, покрыта тестами)
    autonomy.ts              32 строк  UC-013 — policy автономности. ЕДИНСТВЕННЫЙ источник текста, кото
    budget.ts                99 строк  Budget Manager: снимок usage на сессию + пороги. Чистые функции,
    checkpoint.ts            28 строк  UC-010 — checkpoint при compaction: только компактный summary, б
    classifier.ts            98 строк  UC-005 — классификатор сложности. Чистый hint, без сайд-эффектов
    confidential.ts         156 строк  UC-021 — confidential-data firewall: модель видит вёрстку/структ
    debug.ts                109 строк  UC-022 — debugger workflow: reproduce → isolate → hypothesize → 
    design.ts                42 строк  UC-009 — явный Open Design workflow. Никакого авто-запуска по сл
    handoff.ts               43 строк  Handoff сброса контекста: писатель/читатель. Запись — через upda
    injection.ts            262 строк  UC-003 — идемпотентная инъекция + раздельные бюджеты.
    metrics.ts              141 строк  UC-004 — session-scoped метрики + корректные ошибки + bounded me
    orchestrator.ts          69 строк  UC-006 + UC-014 — оркестрация: готовые шаги, батчи, ретраи.
    plan.ts                 189 строк  UC-002 — модель плана и безопасные переходы статусов.
    prune-store.ts          202 строк  Стор оригиналов context-pruner. Отдельный append-only jsonl рядо
    pruner.ts               396 строк  context-pruner: сжатие истории сообщений перед отправкой в LLM.
    runtime-contract.ts     151 строк  UC-017 — runtime-контракт tool `ultracode_context`: единый источ
    schema.ts               345 строк  Ultracode v3 — схема хранилища. Только типы + чистая миграция, б
    sentinel.ts             221 строк  UC-029 — Sentinel: дешёвые advisory-проверки шага плана перед фи
    skill-router.ts         267 строк  UC-032 — skill-router: дешёвый детерминированный роутер по скилл
    stack-contract.ts       221 строк  UC-025 — единый контракт «работающий проект»: один интерфейс,
    stack-detect.ts         218 строк  UC-023 — автоопределение стека проекта для acceptance по умолчан
    store.ts                146 строк  UC-001 — надёжное хранилище v3: per-project файлы + atomic save 
    tokens.ts               105 строк  Токены: реальный cl100k_base (js-tiktoken, CJS) + fallback-эврис
    verification.ts         446 строк  UC-007 — evidence-gated verification. Шаг закрывается только evi
    evaluation/            7 модулей
  agents/          # 5: ultracode, ultracode-designer, ultracode-executor, ultracode-planner, ultracode-reviewer
  commands/        # 13: bolt, checkpoint, debug, design, evaluate, goal, spec, status, tz-check, tz-init, tz-refine, ultracode-help, verify
  skills/          # 44 скиллов
```

<!-- /AUTO:inventory -->

<!-- AUTO:facts -->

CI (2026-11-03): **394 pass / 0 fail / 0 skip**
всего тестов: 394 · `install-smoke.sh`: 53 OK / 0 MISS

Плагин: `plugin/ultracode.ts` · SDK `@opencode/plugin`.
Сгенерировано `scripts/build-docs.sh` — правь руками не числа, а код.

<!-- /AUTO:facts -->
