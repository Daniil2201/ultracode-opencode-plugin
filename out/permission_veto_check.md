# Permission veto: работает или нет

Дата: 2026-10-01. Прогон: `opencode serve --port 4322 --pure`, opencode 1.18.31,
модель `opencode/space-bunny-free`. Конфиг не менялся — permission задан через
`OPENCODE_CONFIG_CONTENT`. Сервер убит.

## SDK

**Тип `Permission`** (`.d.ts`, `export type Permission`):
```ts
{ id, type, pattern?: string|string[], sessionID, messageID,
  callID?: string, title, metadata, time: { created: number } }
```

**Три endpoint'а ответа** — все с одинаковой семантикой:

| Метод | Путь | Body |
|---|---|---|
| POST | `/permission/{requestID}/reply` | `{reply: "once"\|"always"\|"reject", message?: string}` |
| POST | `/session/{sessionID}/permissions/{permissionID}` | `{response: "once"\|"always"\|"reject"}` |
| POST | `/api/session/{sessionID}/permission/{requestID}/reply` | `{reply: PermissionV2Reply, message?}` |

**Действия: `once` / `always` / `reject`.** Не `deny` — именно `reject`.
Поле `message` передаётся модели как feedback.

## Эксперимент

| Шаг | Результат |
|---|---|
| Сервер поднялся с `OPENCODE_CONFIG_CONTENT` | **да**, лог `listening on http://127.0.0.1:4321` |
| Конфиг применился | **да**: `GET /config` → `permission: {"bash": {"*": "ask"}}` |
| Prompt отправлен | **да**: `POST /session/{id}/message`, `opencode/space-bunny-free` |
| Permission-событие получено | **да**: `permission.asked`, id `per_0f67fb89e001SJDWikN7VXZZdG` |
| Deny отправлен | **да**: `POST /permission/{id}/reply` `{"reply":"reject","message":"veto из эксперимента"}` → HTTP 200, тело `true` |
| Результат проверен | **да** (ниже) |

### Хронология по SSE

```
1. tool pending          {tool: bash, callID: call_function_tvbxzyy56ezo_1}
2. tool running          {command: "ls -la /tmp/permission-probe-dir"}   ← time.start
3. permission.asked      {id: per_…SJDWikN7VXZZdG, permission: "bash",
                          patterns: ["ls -la /tmp/permission-probe-dir"],
                          metadata: {command: …}, always: ["ls *"],
                          tool: {messageID, callID}}
   ← opencode ЖДЁТ. Никакого output у tool.
4. permission.replied    (после нашего reject)
5. tool error            {status: "error",
                          error: "The user rejected permission to use this
                                  specific tool call with the following
                                  feedback: veto из эксперимента"}
6. текст агента: «Команда не выполнена — вызов отклонён (veto).
                   Ничего не делал дальше.»
```

**Ключевое доказательство: `output` у tool-part — 0 вхождений во всём потоке.**
Команда не выполнялась вообще. Пометка `running` на шаге 2 означает «начал
обрабатывать», а не «выполнил» — до `permission.asked` она зависает.

### Что видит модель при отказе

Модель получает **и отказ, и причину**: `"veto из эксперимента"` попал в текст
ошибки и в её ответ. То есть можно строить не просто запрет, а обратную связь
контроллера → модель (запрещено правилом X, вот почему).

## Вердикт

**Veto работает: ДА, полноценно.**

Цепочка целостна: `permission.asked` → ожидание ответа → `reject` → tool в
`error`, команда не выполнена, модель получила причину. Значит:

**Controller может строить firewall на лету.** Алгоритм:

1. `GET /event` (SSE), подписаться на `permission.asked` (в v2 — `permission.v2.asked`).
2. Взять `metadata` / `patterns` — там уже разобранная команда, не сырой текст.
3. Решить: `once` (разрешить) или `reject` + `message` (запретить с причиной).
4. Ничего не исполнится раньше ответа.

Отдельно: `tool.input.ended` приходит **до** `permission.asked` — значит у
контроллера есть и сами аргументы до исполнения, если понадобится валидация
содержимого, а не только имени команды.

## Что требует внимания

1. **Действие называется `reject`, не `deny`.** В задании — `{"action":"deny"}`;
   такого поля нет, сервер бы вернул ошибку валидации. Правильно:
   `{"reply": "reject", "message": "…"}`.
2. **Три endpoint'а с разными именами поля** (`reply` / `response`) и без
   общего префикса. Для controller'а проще выбрать один и зафиксировать.
3. **`permission.asked` приходит после `tool.state: "running"`.** Если строить
   файрвол по `status`, «running» ≠ «исполняется» — нельзя считать, что начало
   работы означает начало выполнения. Ориентироваться на `permission.asked`.
4. **`--pure` отключает плагины, но не permission.** Проверено: `permission`
   из `OPENCODE_CONFIG_CONTENT` работает при чистом запуске — то есть механизм
   не зависит от нашей обвязки.

## Заодно

- Плагин Ultracode в этом прогоне **не участвовал** (`--pure`), но permission
  и veto отработали штатно. Значит файрвол поверх opencode не зависит от
  Ultracode — его можно строить голым.
- Маркер `/tmp/permission-probe-dir/marker.txt` создан **до** reject, чтобы
  отличить «выполнилось, но не показало» от «не выполнилось». Проверка по
  отсутствию `output` в SSE надёжнее чтения ФС.
