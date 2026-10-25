# Transport: разведка — годится ли `opencode serve`

Дата: 2026-10-01. Прогон: `opencode serve --port 4321 --pure`, opencode 1.18.31,
SDK `@opencode-ai/sdk` 1.18.27. Сервер убит, конфиги не тронуты.

## Transport: разведка

### opencode serve

| Вопрос | Ответ | Источник |
|---|---|---|
| Endpoints | **162 пути**, два API: v1 `/session/...` и v2 `/api/session/...` | `GET /doc` → OpenAPI 3.1.0, 479 КБ |
| **Tool loop со своими tools** | **НЕТ** | `POST /api/session/{id}/prompt` → `PromptInput = {text, files, agents}`. В v1 `POST /session/{id}/message` поле `tools` имеет тип `{[key]: boolean}` — это вкл/выкл **встроенных** tools, не схемы |
| **Stateless** | **НЕТ** | Все prompt-эндпоинты требуют `sessionID` в пути. Эндпоинта «POST messages[] → ответ» нет |
| Streaming | **SSE** (`/event`) | Живая проверка: `data: {"type":"server.connected",…}` |
| MCP | да | `/mcp`, `/mcp/{name}/connect`, `/mcp/{name}/auth/*` |
| Авторизация | **Basic auth обязательна** | Без `OPENCODE_SERVER_PASSWORD` — `401` на всех путях, `WWW-Authenticate: Basic realm="Secure Area"` |

### Прогон
- serve поднялся: **да** (лог: `opencode server listening on http://127.0.0.1:4321`)
- HTTP отвечает: **да**
- OpenAPI доступен: **да, но не там где ожидаешь** — `/openapi.json` отдаёт HTML-заглушку (2884 байта). Настоящая схема на **`/doc`**

## Ключевая находка: tool-call приходит ДО исполнения

Несмотря на отсутствие своих tools, **наблюдаемость инструментов полная**. В OpenAPI есть события:

```
session.next.tool.input.started   ← начало генерации аргументов
session.next.tool.input.delta     ← поток аргументов
session.next.tool.input.ended     ← аргументы готовы
session.next.tool.called          ← вызов (provider.executed!)
session.next.tool.progress / .success / .failed
session.next.text.delta / .reasoning.delta
permission.v2.asked  question.v2.asked
```

`tool.called` несёт `callID`, `tool`, `input`, `provider.executed`, а `.input.ended` —
полный текст аргументов **до** того, как opencode что-то выполнит.

**Это значит: файрвол на лету строится.** Можно слушать `/event`, на
`tool.input.ended` валидировать аргументы и решать: исполнить или
`POST /api/session/{id}/permission/{requestID}/reply` с `once|always|reject`.

Но это файрвол **над встроенными** tools opencode — не над вашими.

### Что можно, а что нет

| | opencode serve |
|---|---|
| Свои схемы tools | ❌ принимает только `{[name]: boolean}` |
| Свой tool loop | ❌ loop внутри opencode, свои tools туда не вставить |
| Отмена tool до исполнения | ⚠️ только через permission-reply, и только для встроенных |
| Полный LLM-контур (свои tools) | ❌ |

### Transport'ы в наличии

| transport | установлен | tool loop | streaming | MCP | провайдеры | ключи | цена работы |
|---|---|---|---|---|---|---|---|
| **opencode serve** | да (1.18.31) | ❌ только свои | SSE | да | все подключённые | через `~/.local/share/opencode/auth.json` | средняя (обвязка сессий) |
| **@anthropic-ai/sdk** | **нет** | ✅ | ✅ | нет (писать самому) | только Claude | нужен свой `ANTHROPIC_API_KEY` | высокая (свой loop + MCP-клиент) |
| **Vercel AI SDK** | **нет** | ✅ | ✅ | нет | любые | любые | средняя-высокая |
| **Anthropic API напрямую** | — | ✅ | SSE | нет | только Claude | нужен ключ | низкая для прототипа |

В `~/.config/opencode/node_modules/` есть `effect` (46 МБ), `zod`, `fast-check`,
`js-tiktoken` — но ни `@anthropic-ai/sdk`, ни `ai`.

### Open Design как референс

`~/.config/opencode/od-mcp-proxy.py` (53 строки) — **тонкий MCP-прокси**, фильтрующий
`notifications/*`, которые OD-bridge не понимает. Вся остальная работа прокси
прозрачная: спавнит `Open Design Helper` + `daemon-cli.mjs mcp` и перекладывает stdin↔stdout.

**Вывод:** Open Design — отдельное Electron-приложение со **своим LLM-контуром
внутри**. opencode тут только MCP-клиент, вызывающий OD-инструменты. Это НЕ
«opencode как transport» — это ровно противоположный подход.

Применимо у нас:
1. **Прокси-фильтр между транспортом и потребителем — рабочая схема.** Ровно то,
   что делает OD, но дешевле: 53 строки на весь фильтр.
2. **Свой LLM-контур — проверенный на рынке путь.** Если нужны свои tools,
   это единственный путь: свой loop + прямой API.
3. Фильтрация на уровне JSON-RPC позволяет резать поток **до** того, как модель
   увидит результат — дешевле, чем post-hoc откат.

### Вердикт

**`opencode serve` как transport — НЕ годится.** Причина одна, но блокирующая:
нельзя передать свои схемы tools. Всё остальное (SSE, MCP, файловое хранилище,
PTY, плагины) — богато и пригодно, но это API *агента*, а не *LLM-транспорта*.

Развилка «либо адаптироваться, либо другой transport» разрешается в пользу второго:
цикл придётся писать самому в любом случае.

**Альтернативы по цене:**

| Путь | Цена | Что получаем |
|---|---|---|
| **Anthropic API напрямую** | низкая | нужен `ANTHROPIC_API_KEY`; SSE + tools из коробки; минимум слоёв |
| `@anthropic-ai/sdk` | высокая | тот же API, но типизированный и с ретраями; MCP-клиент пишем сами |
| **Vercel AI SDK** | средняя | любые провайдеры одним API; MCP-клиент тоже сами |
| opencode serve + свои tools через MCP | средняя, но хрупко | свои tools регистрируются как MCP-сервер, но агент остаётся opencode — теряем контроль над loop |

### Что требует внимания

1. **Ключ Anthropic.** Ни в `~/.config/opencode/auth.json`, ни в env его нет для
   прямого доступа — opencode ходит через свои провайдеры. Для своего транспорта
   ключ надо завести отдельно: **ТРЕБУЕТСЯ: решение, какой провайдер оплачиваем.**
2. **`/doc`, а не `/openapi.json`.** Если планируете свой кодген поверх OpenAPI —
   берите `/doc`; `/openapi.json` молча отдаёт HTML, и это потратит час на
   ложную диагностику.
3. **Basic auth на всём.** `OPENCODE_SERVER_PASSWORD` обязателен даже на
   `127.0.0.1`. Для локального TUI это лишний слой, но не блокер.
