# Runtime Smoke Test: OpenCode v2.0.32

Дата: 2026-10-25
Среда: macOS Darwin, OpenCode v2.0.32
Установленные пакеты: `@opencode-ai/plugin` 1.18.27, `@opencode-ai/sdk` 1.18.27

## Disposable copy

Создана через `mktemp -d`: `/var/folders/jx/tr_k_8qn23l94jqm690gxrxh0000gn/T/tmp.X03CC2yFw5`
Скопирован `.opencode` из `/Users/daniil/Desktop/Project/Ultracode/.opencode`.
Добавлен тестовый плагин `smoke-test.ts` (создание linked child session, передача agent/model, получение ответа).

## Результат: NO-GO

### Критическая несовместимость: V1 plugins не загружаются в OpenCode v2.0.32

Все плагины в формате V1 (single `.ts` файл с `export default (async (ctx) => {...})`) **отклоняются** при загрузке:

```
Plugin must export a default definition with an id and an effect or setup function.
(cause: SchemaError(Expected object at ["default"]))
```

Это касается **всех** плагинов:
- `~/.config/opencode/plugin/ultracode.ts` — failed
- `~/.config/opencode/plugin/farm.ts` — failed
- `~/.config/opencode/plugin/guardrails.ts` — failed
- `~/.config/opencode/plugin/agentmemory-capture.ts` — failed
- Disposable copy `ultracode.ts` — failed
- Disposable copy `smoke-test.ts` — failed

Дополнительно, opencode v2.0.32 требует, чтобы пути в конфиге `plugin` указывали на **директории**, а не на файлы:

```
configured plugin path must be a directory
```

### Что это означает

1. **V1 плагин-формат не поддерживается.** OpenCode v2.0.32 ожидает V2-формат: `Plugin.define({ id, setup })` (см. [Plugin API](https://opencode.ai/v2/docs/build/plugins)). Установленный `@opencode-ai/plugin` 1.18.27 экспортирует V1-тип `Plugin = (input, options) => Promise<Hooks>`, который больше не совместим.

2. **V2 Plugin API отличается.** V2 предоставляет `ctx.session.create({parentID, agent, model})`, `ctx.session.prompt({sessionID, text})`, `ctx.session.wait({sessionID})`, `ctx.session.context({sessionID})` — модель передаётся при **создании** сессии, а не при prompt. Это **лучше** для нашей задачи, чем V1-подход с `client.session.prompt({model})`.

3. **Ultracode plugin не загружается в v2.0.32.** Весь функционал (контекст-хранилище, бюджет, pruner, sentinel, evidence-gate) недоступен в текущей версии OpenCode.

### Вывод: NO-GO для текущего плана

Тест 11 (проверка `client.session.create` + `client.session.prompt` с model override) **не может быть выполнен**, потому что плагин не загружается в v2.0.32 вообще. Это не проблема SDK-типов — это несовместимость формата плагина.

### Требуемое решение

Перед реализацией P1 дефектов и dispatcher'а необходимо:

1. **Мигрировать Ultracode plugin на V2-формат** (`Plugin.define({ id, setup })`), либо
2. **Откатиться на совместимую версию OpenCode** (где V1 plugins работают), либо
3. **Использовать V2 Plugin API** (`ctx.session.*`) вместо `ctx.client` (legacy SDK), что может потребовать обновления `@opencode-ai/plugin` до V2-совместимой версии.

Вариант 3 предпочтителен, так как V2 API предоставляет `session.create({parentID, agent, model})` — модель передаётся при создании, что упрощает реализацию dispatcher'а и устраняет зависимость от `client.session.prompt({model})`.

### Влияние на spec/subagent-model-routing.md

- FR-004/FR-005 требуют пересмотра: в V2 API модель передаётся в `session.create`, а не в `session.prompt`.
- FR-007 (abort): V2 предоставляет `session.interrupt({sessionID})` и `session.wait({sessionID})`.
- FR-008 (concurrency): V2 session API может иметь свои ограничения.
- Go/No-Go gate 11 пересматривается: сначала нужна миграция на V2, затем smoke.

### Влияние на spec/plugin-error-audit.md

Все P1 дефекты (SEC-01..03, DATA-01..03, BUDGET-01, PLAN-01) остаются актуальными, но их реализация должна использовать V2 Plugin API вместо V1 hooks (`experimental.chat.system.transform`, `tool.execute.after`, `event`, etc.).

### Очистка

Disposable copy удалена. Рабочее дерево проекта не изменено (только `out/runtime-smoke-v2.0.32.md` добавлен).
