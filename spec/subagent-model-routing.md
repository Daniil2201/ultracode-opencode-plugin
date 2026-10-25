# Spec: выбор модели и делегация subagent-задач

## Статус и границы

- Статус: draft, только спецификация; код не менялся.
- Scope: Ultracode plugin в репозитории `Ultracode`, OpenCode `v2.0.32`, локальные `@opencode-ai/plugin` и `@opencode-ai/sdk` `1.18.27`.
- Цель: дать основному Ultracode per-invocation выбор роли и модели при запуске дочерней сессии, сохранив текущие plan/evidence правила. Модель выбирает родитель; child не выбирает себе другой provider.
- Не цель: смена OpenCode API поколения, новый provider/key/платный tier, сохранение выбора модели в store, UI, публичный HTTP API или замена всех OpenCode subagent-функций.

## Наблюдаемое состояние

1. Инструкции `/goal` сейчас называют встроенный инструмент `task`; `.opencode/plugin/ultracode.ts` не регистрирует dispatcher. V2 docs используют имя `subagent`; model-aware workflows не должны зависеть от alias встроенного инструмента.
2. В `@opencode-ai/sdk@1.18.27` `SubtaskPartInput` содержит `prompt`, `description`, `agent`, но не `model` (`.opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:1263-1269`). Поэтому штатный `task` не даёт документированного per-call model override.
3. Плагин использует legacy `PluginInput.client` (`.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts:36-46`), а не V2 `ctx.session` из текущей документации.
4. Установленный клиент содержит нужные типизированные операции: `SessionCreateData.body.parentID` (`.opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:1811-1821`) и `SessionPromptData.body.agent/model/parts`, причём `SessionPromptData.model` имеет форму `{ providerID, modelID }` (`.opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:2244-2268`). Ответ — `AssistantMessage` плюс parts (`.opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:2281-2290`).
5. Значит первый вариант не требует зависимости или изменения storage schema: создать linked child с `parentID`, затем передать роль и модель конкретному `session.prompt`. Форма V2 SDK из web docs не копируется в этот legacy client.
6. Tool API даёт `ToolContext.sessionID` и `ToolContext.abort` (`.opencode/node_modules/@opencode-ai/plugin/dist/tool.d.ts:2-17`); клиентские request options поддерживают `signal` (`.opencode/node_modules/@opencode-ai/sdk/dist/gen/client/types.gen.d.ts:6-17`). SDK также имеет `session.abort({path:{id}})` (`.opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:2059-2068`).
7. `.opencode/lib/ultracode/orchestrator.ts:41-69` — helper, не подключённый к plugin; `runAutonomousGoal` выполняет батч последовательно. Сейчас параллельный dispatch задан инструкциями основному агенту, а не гарантирован этим helper.

Источники: [OpenCode v2 Agents](https://opencode.ai/v2/docs/agents), [Tools/Subagent](https://opencode.ai/v2/docs/tools), [Plugin API](https://opencode.ai/v2/docs/build/plugins), [Session API](https://opencode.ai/v2/docs/api), [Claude Code model selection](https://code.claude.com/docs/en/sub-agents#choose-a-model). OpenCode задаёт модель в профиле агента, но штатный `subagent` tool не документирует model-параметр на один вызов; Claude Code документирует per-invocation `model`.

## Требования (EARS)

**FR-001 — per-call override.** Когда основной Ultracode делегирует подзадачу через новый `ultracode_delegate`, tool SHALL принимать назначение `agent` и опциональные `providerID/modelID` для этой конкретной child-сессии.

**FR-002 — allowlist моделей.** Если передана модель, plugin SHALL сверять пару provider/model с каталогом моделей уже настроенных в OpenCode провайдеров до создания child-сессии. Каталог подтверждает конфигурацию, не доступность/health самого провайдера. Если каталог не читается, вызов SHALL завершаться retryable ошибкой до создания child; если provider request после запуска child завершается ошибкой, она SHALL быть возвращена без тихого fallback. Plugin SHALL NOT подключать provider или подменять модель.

**FR-003 — ограниченные роли и caller.** Tool SHALL принимать вызов только от primary agent `ultracode` и разрешать только проектные subagent-роли `ultracode-planner`, `ultracode-executor`, `ultracode-reviewer`, `ultracode-designer`; вызовы из child-роли, primary ID в качестве child и неизвестные agent ID SHALL быть запрещены для предотвращения рекурсивной делегации и обхода ролей.

**FR-004 — linked child.** При валидных аргументах plugin SHALL создать child session с `parentID = context.sessionID`, затем отправить prompt с выбранными `agent` и `model` через установленный SDK `client.session.prompt`.

**FR-005 — fallback.** Если model override не передан, plugin SHALL не подставлять произвольный provider/model; он SHALL оставить разрешение модели OpenCode для выбранного профиля/сессии. В ответе должен быть показан фактически использованный `providerID/modelID` из assistant message.

**FR-006 — результат и ошибки.** Tool SHALL корректно разобрать SDK `RequestResult` envelope (`data`/`error`), проверить `AssistantMessage.error` и вернуть ограниченный, redacted текстовый результат только при успешном ответе. Ошибка create/prompt/model SHALL быть видна основному агенту и не должна выглядеть как пустой успешный результат.

**FR-007 — отмена.** Когда OpenCode отменяет tool-вызов, plugin SHALL передать `ToolContext.abort` в запрос и best-effort прервать работающую child-сессию через session abort; child-сессия не удаляется.

**FR-008 — concurrency.** В рамках одного plugin runtime для одной parent-сессии SHALL выполняться не более `MAX_PARALLEL = 3` child-вызовов одновременно; четвёртый SHALL получить явную временную ошибку/указание дождаться слота. Этот cap process-local; до проверки Q5 он не является distributed limit между дублированными plugin instances.

**FR-009 — plan/evidence.** Когда вызов относится к плану, основной агент SHALL передавать `planId`, `stepId`, цель и текст шага в prompt дочерней задачи; он SHALL не делегировать шаг до выполнения его `dependsOn`, а retry ограничить текущими 3 попытками. Tool SHALL NOT менять `PlanStep.status`, не записывать evidence и не закрывать план. Per-step acceptance — только `acceptance.command` с exit code; file/line check исключён. Шаг `done` возможен только через существующий successful evidence-gate.

**FR-010 — телеметрия.** При регистрации делегации SHALL сохраняться только `sessionId`, `agent`, `providerID/modelID`, `durationMs` и outcome в существующий bounded `metrics.jsonl`. Prompt, stdout и ответ child в метрики не записываются.

**FR-011 — схема стора.** В первой версии route-specific override SHALL быть временным параметром вызова и не записываться в `PlanStep` или другое поле `context.json` (существующий `config.modelLimit` не меняется). После resume модель выбирается повторно; сохранение выбора требует отдельной версии store и миграции.

## Минимальный поток

1. Основной агент выбирает одну из разрешённых ролей и, если нужно, модель из уже настроенных OpenCode моделей.
2. `ultracode_delegate` валидирует role/model и лимит активных вызовов до SDK-вызова. Каталог моделей должен быть успешно прочитан; это не проверка доступности provider endpoint.
3. Plugin делает `client.session.create({ body: { parentID: context.sessionID } })`.
4. Plugin делает `client.session.prompt({ path: { id: child.id }, body: { agent, model?, parts: [{ type: "text", text: prompt }] }})`; при `model` передаётся `{ providerID, modelID }` по типу SDK 1.18.27. Обрабатываются `RequestResult.error` и `AssistantMessage.error`, даже если HTTP-запрос завершился успешно.
5. Plugin извлекает text parts, sanitizes/clips результат и возвращает его основному агенту вместе с фактической моделью.
6. Родитель самостоятельно проверяет результат, запускает acceptance и отправляет evidence. Dispatcher не выполняет shell и не подменяет evidence.

## Изменения реализации (если spec будет одобрен)

- `.opencode/plugin/ultracode.ts` — один новый tool и минимальный in-flight лимитер; использовать уже внедрённый `client` и `tool` API.
- `.opencode/agents/ultracode.md`, `.opencode/commands/goal.md`, `.opencode/commands/bolt.md` — направить все Ultracode plan-step dispatch через `ultracode_delegate`; не использовать встроенный `task/subagent` как скрытый fallback в этих workflows.
- `.opencode/lib/ultracode/metrics.ts` — минимально расширить существующую JSONL-строку только полями dispatch; отдельный файл/зависимость не добавлять.
- `.opencode/tests/runtime/` и unit tests — mock SDK, проверка делегации/ошибок/concurrency/cancel.
- Не подключать `runAutonomousGoal` как runtime scheduler в этой версии: его последовательный loop и resume-контракт сначала должны быть исправлены отдельным пунктом аудита.

## Acceptance

1. Unit test: валидная модель проверяется по provider inventory; неизвестная модель и ошибка чтения каталога отклоняются до `session.create`.
2. Runtime fake-client test: `session.create` получает `parentID`; `session.prompt` получает правильные `agent`, `providerID`, `modelID` и полный prompt.
3. Runtime test: без model override в `session.prompt` поле `model` отсутствует.
4. Runtime test: результат содержит текст child и фактическую модель из `AssistantMessage`; текст ограничен и проходит redaction.
5. Runtime test: ошибки SDK envelope и `AssistantMessage.error` возвращаются как ошибки, не как `done`; evidence и статус плана остаются без автоматической мутации.
6. Runtime test: abort parent request приводит к abort child; child session не удаляется.
7. Authorization test: вызов не от primary `ultracode`, child agent `ultracode` и неизвестный child agent отвергаются до `session.create`.
8. Command contract test: plan-step инструкции в `/goal` и `/bolt` требуют `ultracode_delegate` и не оставляют native `task/subagent` fallback.
9. Concurrency test: три параллельных вызова в одном plugin runtime допускаются, четвёртый не начинает child-запрос до освобождения слота.
10. Metrics test: dispatch outcome записан без prompt/output/secret полей; старые строки `metrics.jsonl` продолжают читаться.
11. **Go/no-go до реализации:** в disposable copy сначала проверить на `opencode v2.0.32` с установленными SDK/plugin `1.18.27` загрузку plugin, создание linked child, принятие `agent/model` и получение завершённого assistant response. Проверка включает `RequestResult.data/error` и `AssistantMessage.error`; один только typecheck не закрывает этот гейт. Если runtime не поддерживает v1 вызов, остановиться и запросить решение о переходе на V2 plugin API/dependency; не писать код против предполагаемой сигнатуры.
11a. **Read-only проверка глобального конфига:** прочитать `~/.config/opencode/opencode.json` (только read, без write/patch), определить наличие дублирующих plugin-записей. Если файл нечитаем/повреждён — вернуть ошибка, не чинить.
11b. **Эксперимент перезаписи package.json:** в disposable copy (`mktemp -d`) скопировать `.opencode`, запустить opencode, зафиксировать, изменился ли `.opencode/package.json`. Не запускать в рабочем дереве проекта.
12. Полный прогон текущего suite не хуже baseline `346 pass / 0 fail / 3 skip`.
13. Plan integration test подтверждает, что prompt несёт `planId/stepId/goal/step`, dependent step не запускается раньше зависимости, dispatcher не меняет статусы/evidence, а родитель соблюдает retry ≤ 3.
14. Persistence test: store остаётся version 3; после dispatch в `context.json` не появляется per-task `providerID/modelID/agent` metadata ни в плане, ни в иных полях (допустима только отдельная строка dispatch в `metrics.jsonl`); после resume модель выбирается повторно.
15. Live provider call в проверках не запускается без предварительного согласования возможных расходов; unit/runtime tests используют fake client или локальный провайдер.

## Ограничения и риск

- Сессии создаются через текущий v1 SDK, модель задаётся на `session.prompt`, а не в `session.create`; это отличается от V2 Plugin API из документации.
- В SDK 1.18.27 prompt model не содержит `variant`; первая версия маршрутизирует только пару `{providerID, modelID}`.
- Процессный лимитер не переживает перезапуск. Это приемлемо: незавершённые child-сессии остаются видимыми в OpenCode; распределённый semaphore не нужен, пока не доказана необходимость нескольких plugin runtimes на один проект.
- Несколько одновременно загруженных экземпляров plugin могут иметь отдельные process-local лимитеры; это связано с открытым Q5 о global/project registration и требует runtime smoke в обычной конфигурации.
- Параметр model может менять стоимость вызова; разрешены только уже настроенные модели, новые провайдеры/tiers не добавляются.
- Model override не переживает resume плана. Это осознанное упрощение без миграции store v3; сохранять выбор — отдельное решение и отдельный migration spec.

## Неопределённости и решения

- **Runtime compatibility не доказана до acceptance-gate 11.** Реализацию не начинать до smoke в disposable copy. Если gate падает, зафиксировать точную ошибку и остановиться; смена SDK/API — отдельное расширение scope с решением пользователя.
- **Решение v1.2:** выбор модели не сохраняется для resume; это минимальный вариант без изменения storage schema v3. Сохранять модель в плане можно только по отдельному запросу и с migration spec.
- **Решение v1.2:** per-step acceptance — только `acceptance.command` (exit code). Любая проверка строки/паттерна упаковывается в команду вроде `grep -q 'pattern' file.txt`.

## КРИТИЧЕСКОЕ ОБНОВЛЕНИЕ: V1 → V2 Plugin Incompatibility (2026-10-25)

### Результат runtime smoke test

OpenCode v2.0.32 **не загружает** плагины в формате V1 (`export default (async (ctx) => {...})`). Все V1-плагины отклоняются:

```
Plugin must export a default definition with an id and an effect or setup function.
(cause: SchemaError(Expected object at ["default"]))
```

Дополнительно, opencode v2.0.32 требует, чтобы пути в конфиге `plugin` указывали на **директории**, а не на файлы:

```
configured plugin path must be a directory
```

### Влияние на реализацию

1. **V2 Plugin API** предоставляет `ctx.session.create({parentID, agent, model})` — модель передаётся при создании сессии, а не при prompt. Это **лучше** для dispatcher'а.
2. **V2 Plugin API** предоставляет `ctx.session.prompt({sessionID, text})`, `ctx.session.wait({sessionID})`, `ctx.session.context({sessionID})`, `ctx.session.interrupt({sessionID})`.
3. **Весь Ultracode plugin** должен быть мигрирован с V1-формата (`Plugin = (input) => Promise<Hooks>`) на V2-формат (`Plugin.define({ id, setup })`).
4. **Все P1 дефекты** из `plugin-error-audit.md` должны реализовываться через V2 hooks (`ctx.session.hook`, `ctx.session.transform` и т.д.), а не V1 hooks.
5. **Go/No-Go gate 11** пересматривается: сначала миграция на V2, затем smoke.

### Рекомендация

Переход на V2 Plugin API (`ctx.session.*`) вместо legacy `ctx.client`. Это упрощает реализацию dispatcher'а и устраняет зависимость от `client.session.prompt({model})`.

Полный отчёт: `out/runtime-smoke-v2.0.32.md`.
