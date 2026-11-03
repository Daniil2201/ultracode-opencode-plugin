# ultracode-plugin

Плагин оркестратора для [OpenCode v2](https://opencode.ai/v2/docs). Локальные
плагины автоматически подхватываются из `~/.config/opencode/plugins/`.

## Что делает

Оборачивает opencode в рабочий контур: считает контекст, рулит скиллами,
не даёт закрыть план с незакрытой целью, сжимает историю и прячет секреты.

| Механизм | Суть |
|---|---|
| **Бюджет контекста** | Реальный подсчёт токенов (`cl100k_base`) + пороги 40/60/75 и 3 профиля. На soft инъекция ужимается, на hard пишется handoff. |
| **Skill-router** | Вырезает `<available_skills>` из промпта (−14k токенов/сообщение), ставит `<skill_hint>` с топ-3. Алиасы стека + приоритет стека проекта. |
| **Evidence-гейт** | Шаг закрывается только с успешным evidence текущей попытки, команда сверяется с `plan.acceptance.command`. |
| **Idle Evaluator** | Evidence-гейт закрывает **шаги**, Idle Evaluator закрывает **план**. Цель не достигнута → шаг `gf`, дальше терминально `blocked`. |
| **Context Pruner** | Сжатие истории: dedupe, purge-errors, supersede, collapse-bash, truncate. Работает по эпохам, чтобы не инвалидировать prompt cache. Оригинал вернуть через `recall_pruned`. |
| **Файрвол секретов** | Fail-closed редакция токенов и ключей. Типы в коде не портит. Фаззер 1000×60 — 0 утечек. |
| **Sentinel** | Advisory pre-check перед вердиктом: синтаксис, ghost comments, changelog, scope creep. |
| **Handoff** | Состояние между сессиями; единый стор для TUI и `opencode run`. |

Инструмент один: `ultracode_context` — знания, уроки, планы, evidence, бюджет.

## Установка

Из корня клонированного репозитория:

```bash
npm ci
bash scripts/sync-ultracode.sh
```

Скрипт копирует `plugin/`, `lib/`, `agents/`, `commands/`, `skills/`,
`templates/`. **Не трогает** `opencode.json`, `mcp.*` и ферму.

Проверка:

```bash
bash scripts/sync-ultracode.sh --status
# identical=N  diff=0  missing_in_dst=0
```

**После правок нужен рестарт opencode** — плагин грузится один раз при старте.

## Проверка

```bash
npm test
npm run check:install

bash scripts/skill-router-bench.sh      # качество роутинга
```

## Зависимости

- `@opencode/plugin` — SDK OpenCode v2 (пин, не `^`)
- `js-tiktoken` — реальный токенайзер, с fallback-эвристикой при сбое

## Почему не npm-пакет

opencode ставит npm-плагины **из реестра**: кладёт в
`~/.cache/opencode/packages/<имя>@latest/` и грузит оттуда. Локальный
`npm install` этого не делает — проверил: с удалённым `plugin/ultracode.ts`
ни `node_modules/ultracode-plugin`, ни ручная копия в кэше не подхватывались,
`ultracode_context` пропадал из тулов. Поэтому плагин едет файлом, а
`sync-ultracode.sh` — единственный источник правды.

## Известные ограничения

- **Flaky-тесты:** ~1 прогон из 3 падает на `tests/runtime/` — гонка за
  общий `XDG_DATA_HOME` в `fixtures.ts` при параллельном запуске. В изоляции
  стабильно.
- `PRUNE_EPOCH_TURNS = 5` не измерен на живой сессии.
- `metadata.trivial` в плане не переживает `migratePlan`.

Подробности: `CHANGELOG.md`, спеки в `spec/`.

<!-- AUTO:facts -->

CI (2026-11-03): **394 pass / 0 fail / 0 skip**
всего тестов: 394 · `install-smoke.sh`: 53 OK / 0 MISS

Плагин: `plugin/ultracode.ts` · SDK `@opencode/plugin`.
Сгенерировано `scripts/build-docs.sh` — правь руками не числа, а код.

<!-- /AUTO:facts -->
