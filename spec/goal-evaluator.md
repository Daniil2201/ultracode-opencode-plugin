# spec: goal-evaluator

## Цель

Закрыть дыру в финальной точке плана: сейчас `transitionStep` закрывает план по
одному лишь факту «все шаги `done`» (`plan.ts:72`) — цель при этом никогда не
проверяется. Планы из рук-правок стора, из ослабевшего acceptance или с
забытым блокером закрываются как «выполнено».

После UC-036 закрытие плана проходит через детерминированный чек достижения цели.
Чек не прошёл — план **не закрывается**, добавляется шаг `[GOAL_FAIL]` с
перечислением нарушений, и цикл продолжает работу. Прошёл — `plan.status = "done"`.

Чек — чистая функция от состояния плана, без I/O и без запуска команд: тот же
принцип, что UC-007/UC-030 (плагин не исполняет shell, а сверяет записанное).

## Интерфейс

### Контракт

Всё в `.opencode/lib/ultracode/plan.ts` — новый модуль не нужен: гейт решает
`plan.status`, а это зона `transitionStep`. Отдельный файл создал бы цикл
импорта `plan.ts → goal.ts → plan.ts` (нужны `addBlocker` и предикат evidence).

```ts
// plan.ts — новые экспорты
export const GOAL_FAIL_STEP_ID = "gf"

export interface GoalVerdict {
  reached: boolean
  /** Тривиальный план: чек не выполнялся, закрытие не блокируется. */
  skipped: boolean
  violations: string[]
}

// Чистый чек: план достиг цели? Ничего не мутирует.
export function evaluateGoal(plan: Plan): GoalVerdict

// Гейт закрытия: вызывается из transitionStep вместо `plan.status = "done"`.
// Мутирует план и возвращает тот же вердикт.
export function enforceGoal(plan: Plan): GoalVerdict
```

**Про `skip` — решение по расхождению с исходным заданием.** Задание требовало
`status: "pass" | "fail" | "skip"`, но интерфейс `reached: boolean` менять нельзя
(он уже принят). Поэтому skip вынесен в отдельный флаг `skipped`, а не в строку:
`skipped: true` означает «чек не выполнялся, цель считается достигнутой,
закрытие не блокируется». Плагину на `:1516` это даёт все три сообщения
(`pass` / `fail` / `skip`), не переписывая форму вердикта.

**Skip-условия.** Чек возвращает `{ reached: true, skipped: true, violations: [] }`,
если **любое** из двух:

- `plan.steps.length <= 1` — тривиальная задача, нечего проверять;
- `plan.metadata?.trivial === true`.

`Plan` в `schema.ts` поля `metadata` не имеет, а `schema.ts` вне scope, поэтому
читается безопасно, без смены типа:

```ts
const meta = (plan as unknown as { metadata?: { trivial?: boolean } }).metadata
if (meta?.trivial === true) return { reached: true, skipped: true, violations: [] }
```

### Предикат успеха попытки — переиспользуется, не дублируется

`transitionStep` уже умеет проверять «успех текущей попытки» (UC-018, `plan.ts:69`).
Вынести в `hasCurrentSuccess(step: PlanStep): boolean` и звать из обоих мест —
иначе чек и гейт разъедутся.

### `evaluateGoal` — три условия, порядок нарушений фиксирован

1. **Открытый блокер** — `plan.status === "blocked"` → `"открытый блокер"`.
2. **Failed-шаги** — для каждого `s.status === "failed"` → `"<id>: failed (attempts N)"`.
3. **Acceptance** — для каждого оставшегося (не попавшего в п.2) шага:
   - `s.status !== "done"` → `"<id>: не done (<status>)"`;
   - нет успеха текущей попытки → `"<id>: нет успешного evidence текущей попытки"`;
   - `plan.acceptance.command` задан и не совпадает с командой успешного
     evidence → `"<id>: команда evidence не совпадает с acceptance"`.

Один шаг даёт **не более одного** нарушения (п.2 исключает шаг из п.3) — иначе
`gf` получает дубли вида «failed» + «нет evidence» на одном шаге.
`reached = violations.length === 0`. Пустой `plan.steps` → `reached: true`
(закрывать нечего, `createPlan` всё равно не даёт пустой план).

**Про блокеры — важно.** Проверяется **статус**, а не массив `plan.blockers[]`.
Массив — журнал, а не флаг: `addBlocker` пишет запись и ставит `blocked`, а
`transitionStep → in_progress` возвращает `active` (resume), и запись остаётся
навсегда. Скан массива заклинил бы план навсегда: блокер был, работу
перезапустили, шаги закрылись — и чек вечно требовал бы новый `gf`. Статус —
единственный признак «блокер ещё не разрешён». Fail-closed: `blocked` без
записи в массиве тоже считается открытым.

### `enforceGoal` — что происходит при провале

| Состояние плана | Действие |
|---|---|
| чек прошёл | `plan.status = "done"`, ничего не добавлять |
| провал, шага `gf` нет | добавить шаг `gf`: `status: "todo"`, `attempts: 0`, текст `` `[GOAL_FAIL] цель не достигнута: <violations.join("; ")>` `` (срез 200 символов, как в `createPlan`) |
| провал, `gf` в `todo` | обновить **текст** `gf`, новый шаг не заводить (идемпотентно) |
| провал, `gf` не в `todo` (`done`/`failed`/`in_progress`) | нового шага не заводить: `blockers.push("GOAL_FAIL: …")` + `plan.status = "blocked"` |

**При провале `plan.status` принудительно не `done`**: в первых двух ветках
ставится `active`, в терминальной — `blocked`. Прямой вызов `enforceGoal` на
уже закрытом плане, который чек не проходит, иначе оставил бы `done` при
недостигнутой цели — тот же класс дыры, что и UC-030.

Последняя строка — терминальность. Без неё цикл `gf → done → чек → gf` крутился
бы вечно. `gf` даётся **один раз на план**; повторные нарушения уходят в
`blockers`, а не в новые шаги.

**План при провале остаётся `active`** — значит `planResumable` истинно и
`nextBatch` отдаёт `gf` следующим батчем. `gf` без `dependsOn` → `depsDone`
истинно сразу, ограничения зависимостей не мешают.

**Выход из тупика** (не требует кода): `gf` закрыт, чек снова упал → `blocked`
и blocker. Агент чинит исходный шаг через уже существующий переход
`transitionStep(plan, id, "todo")` (единственный путь без guard) →
`in_progress` → evidence → `done`; `in_progress` возвращает `active`, и
следующее закрытие проходит гейт. Новый план не нужен.

`gf` после успешного восстановления остаётся в плане как `done` — честная
запись о цикле goal-fail. Удаление не делаем (YAGNI: нет запроса).

### Затрагиваемые файлы

- `.opencode/lib/ultracode/plan.ts` — `hasCurrentSuccess`, `evaluateGoal`,
  `enforceGoal`, `GOAL_FAIL_STEP_ID`; в `transitionStep` строка
  `if (plan.steps.every(...)) plan.status = "done"` заменяется на
  `if (plan.steps.every(...)) enforceGoal(plan)`. Логика `addBlocker`
  (3 строки) инлайнится в `enforceGoal` — импорт создал бы цикл.
- `.opencode/plugin/ultracode.ts:1516` — `if (p.steps.every((s) => s.status === "done"))`
  перед knowledge-записью «план завершён» меняется на проверку **вердикта чека**,
  а не на `p.status === "done"`. Причина: все шаги `done` — необходимое, но не
  достаточное условие; после гейта это ложь (шаги зелёные, гейт не прошёл, `gf`
  добавлен — а лог говорит «завершён»). Сообщения различают все три исхода:
  - `reached && !skipped` → `план "<title>" завершён` (текущее поведение);
  - `!reached` → `план "<title>" не закрыт: <violations.join("; ")>`, `kind: "blocker"`;
  - `skipped` → `план "<title>" закрыт (тривиальный, чек цели пропущен)`.
- `.opencode/tests/goal-evaluator.test.ts` — новый, unit-уровень (16 тестов).
- `.opencode/tests/runtime/goal-runtime.test.ts` — 2 кейса на настоящем
  tool-path: закрытие через `evidence` и через `plan_step`.

Правок **не требуют** (проверено чтением):

- `plan_show` (`plugin:1461`) — считает `done/total`; с добавленным `gf` это 3/4,
  не «100%», а сам `gf` печатается со списком нарушений. Правка вводила бы
  второе представление статуса.
- `renderPlans` (`injection.ts:233`) — уже печатает `p.status`, после гейта
  покажет честное `active`/`blocked`/`done`.
- `migrateStep` (`schema.ts:220`) — `gf` это обычный шаг: произвольный `id`,
  произвольный `text`, `todo` без evidence мигрируется без изменений.
- Схема стора (v3), `PlanStep`, `Plan`, `Evidence` — новых полей нет.

## Решения по открытым вопросам

Задача оставила три вопроса без ответа. Решены здесь, до реализации.

1. **Планы без `acceptance`.** Пропускать проверку acceptance, **не** `fail`.
   Причина: обратная совместимость — планы, созданные до UC-036 и ручные
   `plan_new`, не имеют команды acceptance, и fail сделал бы их незакрываемыми.
   В этом случае проверяются только «все шаги `done`» и «нет открытого блокера»,
   а чек evidence (п.3 ниже) сводится к наличию успеха текущей попытки.

2. **Ручные планы (созданные `plan_new` вручную, не из ТЗ).** Обрабатываются
   ровно как автоматические. Разницы нет: чек — чистая функция от состояния
   плана и не различает происхождение. Иначе ручной план стал бы лазейкой,
   обходящей гейт.

3. **Куда писать `[GOAL_FAIL]`-шаг.** В `plan.steps`, с фиксированным id `gf`
   (`GOAL_FAIL_STEP_ID`), а не в отдельное поле `plan.goalFailures`. Причины:
   `nextBatch` отдаёт только `plan.steps`, поэтому шаг в массиве автоматически
   попадает в работу без новой точки интеграции; отдельное поле потребовало бы
   отдельного пути в оркестраторе, `plan_show` и `renderPlans`.
   **Правило терминальности:** `gf` создаётся **один раз на план**. Если после
   `gf` план снова доходит до чека и снова падает, новый шаг не заводится —
   `plan.status` становится `blocked` с записью в `plan.blockers`, и требуется
   вмешательство пользователя. Выход из тупика описан выше
   (`transitionStep(plan, id, "todo")` на исходном шаге).

## Acceptance

Юниты (`goal-evaluator.test.ts`):

1. Все шаги `done` с успешным evidence текущей попытки, команда = acceptance →
   `reached: true`, `violations: []`, `plan.status === "done"`, шага `gf` нет.
2. Шаг `done` **без** evidence (дрейф стора) → `reached: false`, violation содержит
   его id; `gf` добавлен, `status: "todo"`, текст начинается с `[GOAL_FAIL]`,
   `plan.status !== "done"`.
3. `plan.acceptance.command = "node --test"`, evidence другой команды с `exit 0` →
   violation про несовпадение, `gf` добавлен.
4. `plan.status = "blocked"` → violation «открытый блокер», `gf` добавлен **даже
   при валидном evidence на всех шагах**.
5. `blockers: ["s1: boom"]` + `status: "active"` (resume) → `reached: true`:
   исторический блокер не мешает закрытию.
6. Один шаг `failed`, остальные `done` → violation именно про `failed` с числом
   попыток, `gf` добавлен.
7. Повторный `enforceGoal` при `gf` в `todo` → число шагов не выросло, текст `gf`
   обновлён, `plan.status` не `done`.
8. `gf` в `done` + цель всё ещё не достигнута → нового шага нет,
   `plan.status === "blocked"`, `blockers` содержит `GOAL_FAIL`.
9. Путь `transitionStep`: два шага, у последнего `done` без evidence →
   `gf` добавлен, `plan.status !== "done"` (гейт вызывается из точки закрытия).
10. `enforceGoal` на плане с `status: "done"` и нарушением → `status` **не**
    остаётся `done` (защита прямого вызова, см. таблицу `enforceGoal`).
11. Текст `gf` содержит id нарушителя и помечен `[GOAL_FAIL]`, длина ≤ 200.
12. На один нарушившийся шаг — ровно одно нарушение (нет дублей failed + acceptance).
13. `plan.steps.length === 1` (даже с нарушением) → `{ reached: true, skipped: true,
    violations: [] }`, гейт закрывает план, `gf` не добавляется.
14. `metadata.trivial === true` при нескольких шагах → то же: `skipped: true`,
    закрытие не блокируется.
15. План без `acceptance.command` со всеми `done` + успешным evidence →
    `reached: true` (решение №1: чек acceptance пропускается, не fail).
16. `enforceGoal` при `skipped: true` → `plan.status = "done"`, шага `gf` нет.

Runtime (`goal-runtime.test.ts`, настоящий tool-path):

13. Сид стора: 2 шага, `s1` = `done` с evidence `attempt 0` при `attempts: 1`
    (stale), `s2` = `verify_required`. `evidence` для `s2` `exit 0` →
    в ответе есть признак `GOAL_FAIL`, в `context.json` есть шаг `gf` с
    `todo`, `plans[...].status !== "done"`.
14. Тот же сид, но закрытие через `plan_step s2 done` (у `s2` валидный evidence
    текущей попытки) → в `context.json` `status !== "done"`, шаг `gf` есть, и в
    `knowledge` **нет** записи `план "…" завершён` (регресс на `plugin:1516`).

Общие:

15. `node --test .opencode/tests/goal-evaluator.test.ts` → exit 0, 16 pass.
16. Полный прогон `node --test` из `.opencode/` → `ℹ fail 0`, `ℹ pass ≥ 312`,
    `skipped ≤ 3`. **Ни один существующий тест не падает**: Blast radius = 0,
    проверен чтением — `verification-gate.test.ts:101` идёт честным evidence-путём
    (гейт проходит), `orchestrator.test.ts:37` и `autonomous-goal.test.ts` ставят
    `status` руками минуя `transitionStep`, `concurrency.test.ts:99` и
    `evidence-runtime.test.ts:85` отклоняются ещё на `transitionStep`/`applyEvidence`
    (UC-018/UC-030) и до гейта не доходят.
17. `bash .opencode/tests/install-smoke.sh` → не хуже 53 OK, 0 MISS.
18. Ни одна существующая подпись не меняется: `createPlan`, `transitionStep`,
    `applyEvidence`, `createEvidence`, `validateEvidenceArgs`, `savePlan`,
    `getPlan`, `loadPlan`, `activePlan`, `addBlocker` — как были.

## Запреты

- **Не менять** публичные подписи существующих экспортов (п.17). `enforceGoal`
  вызывается **только** из `transitionStep`; второго вызова не заводить.
- **Не сканировать** `plan.blockers[]` как признак открытости (см. блок
  «Про блокеры») — это заклинивает план после resume.
- **Не добавлять** новый tool-action (`goal_check`), команду `/goal-eval`, поля в
  `Plan`/`PlanStep`/`Evidence`, версию схемы. Причины нарушений видны в тексте
  `gf` и в `plan_show`.
- **Не запускать** acceptance-команду из гейта: чек читает записанное evidence,
  как UC-007. Это defense-in-depth против дрейфа стора, а не второй раннер.
- **Не трогать** `sentinel.ts`, `budget.ts`, `handoff.ts`, `tokens.ts`,
  `injection.ts`, `metrics.ts`, `confidential.ts`, `skill-router.ts`,
  `evaluation/`, `design.ts` — вне scope.
- **Не удалять и не ослаблять тесты.** Правки существующих тестов — только с
  указанием в отчёте, какой тест и почему изменён (ожидается: ни одного).
- Не трогать `farm/`, глобальный `~/.config/opencode/opencode.json`.
- Не делать `plan.status = "done"` нигде, кроме `enforceGoal` (включая плагин).
