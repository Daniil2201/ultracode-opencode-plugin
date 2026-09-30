# spec: context-pruner

## Цель

Динамическое сжатие истории сообщений перед отправкой в LLM через хук
`experimental.chat.messages.transform`. Три уровня по бюджету: **soft** — dedupe +
purge errors, **hard** — + supersede writes + collapse bash, **emergency** — +
truncate старых tool outputs. Оригиналы не теряются: они уходят в отдельный стор и
возвращаются тулой `recall_pruned(messageId)`.

Транскрипт opencode на диске не трогаем. Сжатие идёт **по эпохам** (не чаще раза в
`pruneEpochTurns` ходов), чтобы не инвалидировать prompt cache на каждом ходу.

## Проверенные факты (решают дизайн)

Проверено по `.opencode/node_modules/@opencode-ai/plugin@1.18.27/dist/index.d.ts`,
типам SDK и дизассемблированному бинарю opencode 1.18.31 (`strings`):

| Факт | Следствие в дизайне |
|---|---|
| Хук объявлен как `(input: {}, output: { messages: { info: Message; parts: Part[] }[] }) => Promise<void>` | `input` **пустой** — sessionID в хук не приходит |
| Единственная точка вызова в главном пути: `trigger("experimental.chat.messages.transform", {}, { messages: C })`, затем `toModelMessagesEffect(C, Z)` — читается **локальная переменная `C`**, не `output.messages` | `output.messages = [...]` **не сработает**. Только мутация на месте: `splice` / замена элементов |
| Мост `Plugin.trigger` (`Plugin` service) передаёт `output` **как есть**, без Proxy и без копии | Ин-центральная мутация массива видна вызывающему |
| Внутри `trigger` хуки идут `for..of` c `yield*` — строго последовательно | Мутации одного плагина видны следующему; порядок стабилен |
| `Plugin.trigger` оборачивает хук в `Effect.promise` **без** `catch`; на сайте вызова нет обработчика | **Бросок из хука валит run.** Тело хука обязано быть в `try/catch` |
| Тот же хук зовётся на пути компактации: `experimental.session.compacting` → `structuredClone(head)` → `trigger(..., {messages: xe})` → `xe.map(pd)` | На пути компактации сжимать нельзя: ухудшаем саммари и дублируем стор. Нужен флаг-детектор |
| `info.sessionID` есть и у user-, и у assistant-сообщений | sessionID берём из `output.messages.at(-1).info.sessionID` |
| Массив `C` каждый ход пересобирается заново из полного транскрипта (`filterCompactedEffect`) | Сжатие должно быть **чистой детерминированной функцией** от `(messages, level)`, а не накопительным состоянием массива |
| Нативный prune opencode (`SessionCompaction.prune`) уже есть: пропускает 2 последних user-сообщения, имеет свой список неприкасаемых `Id.includes(tool)` | Прецедент: последние ходы не трогать, у неприкасаемых тулов свой список |

## Интерфейс

### Уровни

```ts
// .opencode/lib/ultracode/pruner.ts
export type PruneLevel = "off" | "soft" | "hard" | "emergency"
export const PROTECTED_TOOLS: readonly string[]   // ["task", "skill", "ultracode_context"]

export interface PruneAction {
  kind: "dedupe" | "purge-error" | "supersede" | "collapse-bash" | "truncate"
  messageID: string
  partID: string
  tool: string
  charsBefore: number
  charsAfter: number
}

export interface PruneReport {
  level: PruneLevel
  actions: PruneAction[]
  charsBefore: number
  charsAfter: number
}

// чистая функция. Ни I/O, ни времени, ни случайности.
export function planPrune(
  messages: readonly PrunableMessage[],
  level: PruneLevel,
  opts?: { pinned?: ReadonlySet<string>; protectRecent?: number },
): { messages: PrunableMessage[]; report: PruneReport }

// мутация на месте — единственный способ пробрать результат в opencode
export function applyPrune(output: { messages: unknown[] }, result: { messages: PrunableMessage[] }): void
```

`PrunableMessage` / `PrunablePart` — локальные минимальные структурные типы в
`pruner.ts` (никаких импортов из SDK: `lib/ultracode/` не зависит от
`@opencode-ai/*`, см. остальные модули). Нужны только `info.id`, `info.role`,
`info.sessionID`, `parts[].type/id/callID/tool/state.status/error/output/input.title`
и `parts[].text`.

### Пять преобразований

Уровень задаёт, какие правила включены; каждое правило — чистая функция от сообщения.

| kind | Уровень | Что делает | Инвариант |
|---|---|---|---|
| `dedupe` | soft | Если два tool-part с одинаковыми `tool` + `state.input` (deep-equal по JSON) — все, кроме последнего, заменяются плейсхолдером | tool-part **не удаляется**, остаётся tool_result для своего tool_use |
| `purge-error` | soft | `state.status === "error"`: `error` → `""`, в плейсхолдер только имя тула | то же |
| `supersede` | hard | Несколько записей одного и того же пути (`write`/`edit`/`patch`/`bash` — из `state.input.filePath` / `path` / `patch` / `command`): все, кроме последней, → плейсхолдер + строка «Актуальная версия: <tool> в partId="<id>» | то же |
| `collapse-bash` | hard | Вывод `bash`/`shell`/`Bash`: первые `KEEP_HEAD` (800) + последние `KEEP_TAIL` (800) символов, между ними маркер elision | то же |
| `truncate` | emergency | Tool-output **старше** последних `protectRecent` (2) ходов: первые `TRUNCATE_HEAD` (400) символов + строка плейсхолдера (без неё модель не знает, что хвост в сторе) | то же |

Правила каскадные: на `hard` применяются soft-правила, на `emergency` — все.
Два исключения из каскада, оба намеренные:

- `collapse-bash` **не** каскадит в `emergency` — там `truncate` (400) и строже, и
  дешевле; каскад дал бы бессмысленную элизию поверх обрезанного вывода.
- На `emergency` `supersede`/`dedupe`/`purge-error` по-прежнему идут **до**
  `truncate`: placeholder (200 симв.) не перерезается, а part, уже сжатый
  мягким правилом, не трогается вторым.

`off` → массив возвращается без изменений, `report.actions` пуст.

### Приоритет правил на одном part

Один part сжимается ровно одним правилом — первым, которое сработало, в порядке
`purge-error → dedupe → supersede → collapse-bash → truncate`. Поэтому
плейсхолдер никогда не перерезается и не заменяется поверх другого плейсхолдера.

### Плейсхолдер

Единый формат, детерминированный (без времени, без хешей от времени):

```
[pruned <kind>: <tool>] <charsBefore>→<charsAfter> симв. Оригинал: recall_pruned messageId="<id>" partId="<id>"
```

Модель должна видеть, что контент **существует** и как его вернуть — иначе она
начинает гадать и переспрашивать. Плейсхолдер пишется в **новый** part
(`{ ...part, state: { ...state, output: placeholder, metadata: { ...metadata, ultracodePruned: <kind> } } }`),
исходный part-объект не мутируется.

`messageId`/`partId` в плейсхолдере — **всегда та пара, для которой в стор лёг
оригинал**. `supersede` дополнительно дописывает строкой, где актуальная версия
(`recall` по ней нечего возвращать — она и так в контексте). Обратное тоже верно:
на каждое действие из `report.actions` в `pruned/<sid>.jsonl` есть ровно одна
запись `original` — иначе плейсхолдер обещал бы recall, которого не будет.
`charsAfter` = сколько символов **контента** осталось (0 = содержимое убрано,
осталась только строка плейсхолдера).

### Стор оригиналов

Отдельный файл, **не** `context.json` (схема v3 не трогается):

```
<storeRoot()>/projects/<projectSlug(projectRoot)>/pruned/<sessionID>.jsonl
```

Append-only JSONL, два вида записей:

```ts
type PruneRecord =
  | { kind: "original"; messageID: string; partID: string; tool: string;
      content: string; ts: string }
  | { kind: "pin"; messageID: string; ts: string }
```

- `original` пишется **один раз** на пару `(messageID, partID)`: ключ держится в
  in-memory `Set` на сессию (файл на сессию не перечитывается на каждом ходу).
  Без дедупа один и тот же оригинал дописывался бы каждый ход.
- `pin` — сообщение закреплено (`recall_pruned`), pruner больше его не жмёт.
- Секреты: `content` проходит через `redactConfidential` из `./confidential.ts`
  перед записью.

### Модули

- `.opencode/lib/ultracode/pruner.ts` — **новый, чистый**: уровни, `PROTECTED_TOOLS`,
  `planPrune`, `applyPrune`, формат плейсхолдера. Зависимости: только `./budget.ts`
  (тип `BudgetLevel`) и `./confidential.ts`.
- `.opencode/lib/ultracode/prune-store.ts` — **новый, I/O**: `prunedFileFor(sessionID)`,
  `appendOriginal`, `appendPin`, `loadPins`. Зависимости: `node:fs`, `node:path`,
  `./store.ts` (`storeRoot`, `projectSlug`), `./confidential.ts`.
- `.opencode/tests/pruner.test.ts` — **новый**, `node:test`.
- `.opencode/plugin/ultracode.ts` — регистрация хука, состояние, тула. +~70 строк.
- `.opencode/README.md` — строка в карте модулей.

### Интеграция

Хук в `plugin/ultracode.ts`:

```ts
"experimental.chat.messages.transform": async (_input: any, output: any) => {
  try {
    const messages = output?.messages
    // sid из последнего сообщения; для пустого массива — "default".
    const sid = (Array.isArray(messages) && messages.length > 0
      ? messages.at(-1)?.info?.sessionID
      : undefined) || "default"

    // Путь компактации: жмём нельзя (портим саммари, дублируем стор).
    // Флаг снимается ДО проверки на пустой массив — иначе пустой transform
    // оставил бы флаг висеть и отключил prune на этом sid.
    if (compactionPending.has(sid)) { compactionPending.delete(sid); return }
    if (!Array.isArray(messages) || messages.length === 0) return

    const usage = usageFor(usageBySession, sid)
    const mod = sessionModel.get(sid)
    const verdict = evaluateBudgetV3(
      usage,
      resolveLimitV3(store.config.modelLimit, limitsCache, mod?.providerID, mod?.modelID),
      thresholdsFromV3(store.config),
    )
    const level = levelFor(verdict.level)          // ok → "off"
    const st = pruneStateFor(sid)
    if (level === "off") { st.lastLevel = "off"; return }
    st.turns++

    // Эпоха + защита кеша.
    if (st.lastPruneTurn > 0 && st.turns - st.lastPruneTurn < epochTurns()) return
    if (level === st.lastLevel) return

    const pins = loadPins(prunedFileFor(projectPath, sid))
    const { messages: pruned, report } = planPrune(messages, level, { pinned: pins })
    if (report.actions.length === 0) return
    // Оригиналы не записались -> prune не применяем (плейсхолдер без оригинала
    // обещает recall, которого не будет). Уровень/счётчик намеренно не тронуты.
    const failed = report.actions.filter((a) =>
      appendOriginal(file, a, originalContentOf(messages, a)) === "failed")
    if (failed.length) { debugLog(`prune skipped: ${failed.length} originals unwritable`); return }
    st.lastLevel = level
    st.lastPruneTurn = st.turns
    if (report.actions.length) {
      applyPrune(output, { messages: pruned })     // splice, НЕ переприсваивание
      debugLog(`prune ${level} ${sid.slice(0, 8)}: ${report.actions.length} parts, ${report.charsBefore}→${report.charsAfter}`)
    }
  } catch (e) {
    // Хук не имеет права бросать: исключение здесь валит run.
    // Текст ошибки через firewall, и он не падает на `throw null`.
    debugLog(`context-pruner failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`)
  }
}
```

`st.lastLevel`/`st.lastPruneTurn` ставятся **после** того, как выяснилось, что
есть что сжимать. Иначе первый не-`off` ход с пустой историей «съел» бы уровень:
второй проход на том же уровне запрещён, а бюджет так и остался бы не сжатым.
Первый не-`off` ход жмёт сразу (не ждём эпоху) — `lastPruneTurn` начинается с 0.

`appendOriginal` различает `stored` / `duplicate` / `failed`: «дубль» (уже
записан) — норма, «отказ» — повод не сжимать вовсе.

`experimental.session.compacting` — одна строка в самом начале, **до** проверки
`output.context`: opencode компактит и при не-массиве, а флаг нужен всегда.

Тула:

```ts
recall_pruned: tool({
  description: "Вернуть оригинал сообщения, сжатого context-pruner (по messageId).",
  args: { messageID: tool.schema.string().describe("id сообщения из плейсхолдера"),
          partID: tool.schema.string().optional() },
  // sid — из контекста тула. Выдача режется по MAX_RECALL_CHARS (4000) с
  // маркером «ещё N симв. в pruned/<sessionID>.jsonl»: recall возвращает в
  // контекст ровно то, что pruner вынул, и не должен съесть бюджет сам.
  async execute(args) { /* → оригинал(и) + pin на будущее */ },
})
```

## Решения по эпохам

`epochTurns` = `store.config.pruneEpochTurns ?? 5`. Своих порогов сжатия не заводим:
уровень приходит из `evaluate()` (дефолт `balanced` = 40/60/75, как в
`THRESHOLD_PROFILES`), профиль — из `thresholdsFrom(store.config)`.

Условия прохода (все три):
1. `level !== "off"` — то есть `evaluate()` дал `soft`/`hard`/`emergency`.
2. `turns - lastPruneTurn >= epochTurns` — эпохи. Первое срабатывание проходит
   без ожидания (`lastPruneTurn` инициализируется нулём): ждать 5 ходов при уже
   переполненном бюджете незачем.
3. `level !== lastLevel` — на том же уровне второй проход бесполезен (правила уже
   применены, а транскрипт каждый ход пересобирается заново). Условия 2 и 3
   обновляются **только если что-то реально сжали** — иначе пустая история
   «съела» бы уровень, и при росте бюджета pruner больше не включился бы.
   При откате в `ok` `lastLevel` сбрасывается в `"off"`: после возврата выше
   порога pruner должен снова сработать.

Условие 3 — не микрооптимизация, а защита кеша: без него прыжок `emergency → soft`
после смены модели (`usage.total` падает) гонял бы prune каждые N ходов вхолостую.

## Acceptance

1. `node --test .opencode/tests/pruner.test.ts` → exit 0.
2. **In-place обязателен:** тест зовёт `applyPrune` на реальном массиве и проверяет,
   что **тот же объект массива** изменился (`assert.strictEqual` на ссылку до/после
   отсутствует, длина изменилась). Отдельный тест: `output.messages = other` не
   влияет — фиксирует контракт из таблицы фактов.
3. **Уровень из `evaluate()`:** `planPrune` на `soft` не трогает `write`/`bash`
   (кроме dedupe/purge-error), на `hard` — трогает, на `emergency` — плюс `truncate`.
   Тест строит историю с bash-выводом в 50k символов и проверяет, что на `soft`
   символы те же, на `hard` — урезаны.
4. **Защищённые тулы:** история с `task`/`skill`/`ultracode_context` на `emergency`
   → `report.actions` не содержит их `partID`, `output` побайтово тот же.
5. **Инвариант tool_result:** для каждого tool-part с `callID` до и после prune
   существует ровно один part с тем же `callID`. Ни один tool-part не удалён,
   ни один `callID` не исчез.
6. **Последние ходы целы:** `protectRecent: 2` — tool-part из последних двух
   user-сообщений не тронут ни на одном уровне.
7. **Детерминизм:** два прогона `planPrune` на одном входе дают
   `JSON.stringify` отчётов, равный побайтово; запуск через 10 мс даёт тот же
   результат (никаких `Date.now()` в выводе).
8. **Эпоха:** состояние `plan_new`-like — прогон гейта: 3 хода при `soft` → prune
   ровно один раз; принудительный `lastLevel = level` → следующие `epochTurns - 1`
   ходов prune не вызывается.
9. **Стор не тронут:** `context.json` до и после prune-хока побайтово идентичен;
   prune пишет только в `pruned/<sessionID>.jsonl`.
10. **Дедуп записи:** два хода подряд на одном уровне с одним и тем же оригиналом →
    в `pruned/<sessionID>.jsonl` **одна** запись `original` на `(messageID, partID)`.
11. **`recall_pruned`:** после prune `recall_pruned(messageID)` возвращает исходный
    `output` символ в символ; повторный вызов после `planPrune` на том же сообщении
    не сжимает его снова (pin работает, переживает перезапуск процесса — pin
    читается из файла).
12. **Хук не бросает:** `planPrune` на мусорном входе (`messages: [{}]`,
    `parts: undefined`, `state: null`) → хук завершается без throw. Тест зовёт
    хук-функцию с такими входами и проверяет отсутствие исключения.
13. **Хук не вызывается на пути компактации:** после `session.compacting` для sid
    transform на том же sid → `applyPrune` не вызван, `pruned/` пуст.
14. **Экономия измерима:** на истории с 50k bash-выводом `emergency` даёт
    `charsAfter < charsBefore / 2`, и `tokens()` на результате меньше, чем на входе.
15. Регресс-гейт:
    `node --test .opencode/tests/*.test.ts .opencode/tests/runtime/*.test.ts .opencode/tests/adversarial/*.test.ts`
    → не хуже baseline `ℹ pass 225` / `ℹ fail 4` (4 падения — `farm/`, вне scope).
16. `bash .opencode/tests/install-smoke.sh` → не хуже 50 OK / 1 MISS.

## Запреты

- **Не переприсваивать `output.messages`.** Только `splice`/`length`/замена
  элементов. Причина — верифицированный контракт моста: вызывающий читает локальную
  переменную, а `output` — тот же объект без Proxy.
- **Не бросать из хука.** Любое исключение валит run (`Effect.promise` без catch).
  Тело хука целиком в `try/catch`, `catch` — только `debugLog`.
- **Не трогать транскрипт opencode на диске.** Ни `client.session.*`, ни
  `updatePart`, ни `state.time.compacted` (это делает нативный prune — не наша
  территория). Мы работаем только с переданным массивом.
- **Не удалять tool-part целиком.** Нарушение tool_use/tool_result-контракта
  ломает запрос у провайдера. Только замена содержимого.
- **Не заводить свои пороги.** Уровень — только из `budget.evaluate()`,
  профиль — из `thresholdsFrom()`. Числа 40/60/75 в коде pruner'а не встречаются.
- **Не сжимать `task`, `skill`, `ultracode_context`** ни на одном уровне, включая
  dedupe (их вызовы — это запись решений, повторов не бывает).
- **Не сжимать последние `protectRecent` ходов.**
- **Не сжимать то, чей оригинал не записался.** `appendOriginal` вернул `failed`
  → prune не применяется вовсе. Смысл всей конструкции — «оригиналы не теряются»;
  плейсхолдер без записи в сторе хуже, чем лишние 200k символов.
- **Не обещать recall, которого не будет.** `messageId`/`partId` в плейсхолдере
  всегда та пара, для которой в `pruned/<sid>.jsonl` есть запись `original`.
- **Не менять схему стора v3** и не добавлять поля в существующие структуры.
  Оригиналы — отдельный jsonl рядом.
- **Не печатать секреты.** `content` в jsonl идёт через `redactConfidential`;
  `debugLog`/`log` пишут только агрегаты (`N parts, charsBefore→charsAfter`), а
  текст исключения в `catch` — тоже через firewall.
- **Не трогать `farm/`, `my-manager`, глобальный `~/.config/opencode`.**
- **Не добавлять зависимостей** — только node: stdlib.
- **Не вызывать pruner из `chat.message`/`system.transform`** — только из
  `messages.transform`, иначе он начнёт жечь контекст до того, как собран запрос.

## Открытые вопросы

1. **Дефолт `pruneEpochTurns = 5`** — не измерен. Требует замера на реальной
   сессии: сколько ходов реально живёт кеш между prune'ами. Пока не измерено —
   conservative-значение; после замера правится одним числом в схеме конфига.
2. **`pruneEpochTurns` и `pruneEnabled` в `schema.ts`** — это новые поля в
   `config`, то есть изменение схемы v3, которую TZ запрещает менять без миграции.
   Нужно решение: (а) поля с дефолтами, читаемые через `as` без миграции,
   (б) отдельный файл `prune.json` по образцу `metrics.jsonl`, (в) без конфига
   вообще — константа. По умолчанию берём (в), он дешевле всех и соответствует
   «не заводить своего».