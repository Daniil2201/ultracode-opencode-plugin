# spec: evidence-gate

## Цель

Закрыть дыру доверия в evidence-гейте: `applyEvidence` больше не доверяет переданному
агенту `exitCode` и не пишет статус шага руками. Шаг закрывается только через
`transitionStep`, только из начатого состояния и только по команде, совпадающей с
`plan.acceptance.command`.

## Интерфейс

### Контракт

```ts
// verification.ts — сигнатура не меняется, меняется контракт
export function applyEvidence(plan: Plan, stepId: string, evidence: Evidence): void

// verification.ts — предикат получает жизнь (был мёртвым)
export function stepNeedsEvidence(plan: Plan, stepId: string): boolean

// plan.ts — удаляется (был мёртвым, вызовов 0)
export function claimStep(...): PlanStep   // удалить
```

Правила `applyEvidence` (порядок важен):

1. **Шаг найден** — иначе `unknown step: <id>` (как раньше).
2. **Шаг начат**: `stepNeedsEvidence(plan, stepId)` истинно только для
   `in_progress | verify_required`. Иначе `throw`, статус шага **не меняется**,
   evidence **не записывается**, план **не сохраняется**.
3. **Команда совпадает с acceptance**: если `plan.acceptance.command` задан,
   `evidence.command` должен совпадать с ним или быть его префиксом
   (`acceptance.startsWith(command)`). Иначе `throw`, ничего не пишется.
   Если `plan.acceptance` не задан (старые планы) — проверка пропускается.
4. **Evidence записывается** с текущим `attempt` (UC-018).
5. **Статус — только через `transitionStep`**:
   - `in_progress` → `verify_required` (если ещё не там);
   - `exitCode === 0` → `done` (transitionStep сам требует успешное evidence текущей попытки);
   - `exitCode !== 0` → `failed` + `attempts++`.
6. `plan.status = "done"` больше не выставляется вручную — это делает `transitionStep`.

### Мёртвый код

- `stepNeedsEvidence` — **подключается** как guard из `applyEvidence`; семантика
  меняется с «нужно ли evidence» на «принимает ли шаг evidence».
- `claimStep` (`plan.ts:98`) — **удаляется**: вызовов 0 во всём репозитории, тестов нет.
  Вернётся, когда появится пул воркеров; до тех пор мёртвый экспорт хуже его отсутствия.

### Затрагиваемые файлы

- `.opencode/lib/ultracode/verification.ts` — `applyEvidence`, `stepNeedsEvidence`.
- `.opencode/lib/ultracode/plan.ts` — удалить `claimStep`.
- `.opencode/plugin/ultracode.ts` — правок не требует: `applyEvidence` вызывается
  внутри `locked()` (`:1551`), `throw` уже превращается в ответ
  `ERR evidence rejected …` (`:1556`), а `updateStoreFileV3` не сохраняет план при throw.
  Проверяется тестом, что отклонённое evidence не персистится.
- `.opencode/tests/verification-gate.test.ts` — новый, unit-уровень.
- `.opencode/tests/runtime/evidence-runtime.test.ts` — тест «evidence exit 1 …» писал
  evidence в шаг из `todo`; добавить `plan_step in_progress`/`verify_required` перед ним.
  Проверяемое поведение (failed + attempts=1) не меняется.
- `.opencode/tests/adversarial/concurrency.test.ts` — тест «stale success …» держался
  на `done → evidence(exit 1) → failed`. При новом гейте `done` не принимает evidence,
  поэтому сценарий перестраивается на attempt 0 fail → claim → `plan_step done` отклонён;
  UC-018 отдельно покрывается unit-тестом.
- `.opencode/README.md` — строка про контракт гейта.

## Acceptance

1. `applyEvidence` на шаге в `todo` → `throw`, `status` остаётся `todo`,
   `evidence` пуст, `attempts` = 0.
2. `applyEvidence` на шаге в `done` → `throw` (закрытый шаг не переоткрывается).
3. `plan.acceptance.command = "node --test"`, `evidence.command = "rm -rf /"` →
   `throw`, evidence не записан.
4. `plan.acceptance.command = "node --test --run a.ts"`, `evidence.command =
   "node --test"` (префикс) → принимается.
5. `in_progress` + совпадающая команда + `exitCode 0` → шаг `done`
   (и `plan.status === "done"`, если это последний шаг).
6. `in_progress` + `exitCode 1` → `failed`, `attempts === 1`; затем
   `in_progress` → `verify_required` + `exitCode 0` → `done` (попытка 1 закрыта).
7. `stepNeedsEvidence` истинно только для `in_progress | verify_required`.
8. План без `acceptance` — evidence принимается (обратная совместимость).
9. **Runtime-путь (не юнит):** `ultracode_context action=evidence` для шага из `todo`
   возвращает `ERR … rejected`, и в `context.json` шаг остаётся `todo` без evidence.
10. `node --test .opencode/tests/verification-gate.test.ts` → exit 0.
11. Полный прогон: `ℹ fail 0`, `ℹ pass ≥ 245`, `skipped ≤ 3`.
12. `bash .opencode/tests/install-smoke.sh` → не хуже 50 OK / 1 MISS.

## Запреты

- **Не менять публичные подписи** `applyEvidence`, `createEvidence`,
  `validateEvidenceArgs`, `transitionStep`, `createPlan`.
- **Не трогать** `sentinel.ts`, `budget.ts`, `handoff.ts`, `tokens.ts`,
  `injection.ts`, `metrics.ts`, `confidential.ts` — вне scope.
- **Не запускать** произвольный shell: гейт по-прежнему доверяет агенту насчёт
  фактического выполнения команды (это осознанное решение UC-007), сверяется только
  соответствие команды acceptance.
- **Не удалять тесты** — только переводить на новый контракт, с указанием в отчёте,
  какой тест и почему изменён.
- **Не менять схему стора** (v3) и не добавлять полей в `PlanStep`/`Evidence`.
- Не трогать `farm/`, `my-manager`, глобальный `~/.config/opencode/opencode.json`.
- Не делать `plan.status = "done"` вручную — только через `transitionStep`.
