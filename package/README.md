# ultracode-plugin

Плагин оркестратора для [opencode](https://opencode.ai). Ставится локально,
автоматически подхватывается из `~/.config/opencode/plugin/`.

```
"plugin": ["./plugin/ultracode.ts", "./plugin/farm.ts", …]
```

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

```bash
cd ~/.config/opencode
bash ~/Desktop/Project/Ultracode/scripts/sync-ultracode.sh
```

Скрипт копирует `plugin/`, `lib/`, `agents/`, `commands/`, `skills/`,
`templates/`. **Не трогает** `opencode.json`, `mcp.*` и ферму.

Проверка:

```bash
bash ~/Desktop/Project/Ultracode/scripts/sync-ultracode.sh --status
# identical=N  diff=0
```

**После правок нужен рестарт opencode** — плагин грузится один раз при старте.

## Проверка

```bash
cd ~/Desktop/Project/Ultracode
node --test .opencode/tests/*.test.ts .opencode/tests/runtime/*.test.ts \
             .opencode/tests/adversarial/*.test.ts
# 349 tests / 346 pass / 0 fail / 3 skipped

bash .opencode/tests/install-smoke.sh   # 53 OK / 0 MISS
bash scripts/skill-router-bench.sh      # качество роутинга
```

## Зависимости

- `@opencode-ai/plugin` — SDK хуков (пин, не `^`)
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

CI (2026-10-01): **346 pass / 0 fail / 3 skip**
всего тестов: 349 · `install-smoke.sh`: 53 OK / 0 MISS

Плагин: `plugin/ultracode.ts` · SDK `@opencode-ai/plugin`.
Сгенерировано `scripts/build-docs.sh` — правь руками не числа, а код.

<!-- /AUTO:facts -->
