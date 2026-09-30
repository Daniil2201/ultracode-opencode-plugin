// UC-036 — гейт закрытия плана: все шаги done ≠ достигнутая цель.
// Чек чистый (evaluateGoal) и мутирующий (enforceGoal), вызывается из transitionStep.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createPlan, transitionStep, evaluateGoal, enforceGoal, GOAL_FAIL_STEP_ID } from "../lib/ultracode/plan.ts"
import { createEvidence, applyEvidence } from "../lib/ultracode/verification.ts"
import type { Evidence, Plan } from "../lib/ultracode/schema.ts"

function ev(command: string, exitCode: number, attempt?: number): Evidence {
  return { ...createEvidence(command, exitCode, exitCode === 0 ? "ok" : "", exitCode === 0 ? undefined : "err"), ...(attempt === undefined ? {} : { attempt }) }
}

// Честно закрытый шаг: evidence текущей попытки, команда совпадает с acceptance.
function doneWithOk(plan: Plan, id: string, command = "node --test"): void {
  const s = plan.steps.find((x) => x.id === id)
  assert.ok(s)
  s.status = "done"
  s.evidence = [ev(command, 0, s.attempts ?? 0)]
}

test("1. все шаги done с успехом текущей попытки и командой acceptance → план закрыт", () => {
  const p = createPlan("goal", ["a", "b"], "node --test")
  doneWithOk(p, "s1")
  doneWithOk(p, "s2")
  const v = evaluateGoal(p)
  assert.equal(v.reached, true)
  assert.deepEqual(v.violations, [])
  enforceGoal(p)
  assert.equal(p.status, "done")
  assert.equal(p.steps.find((s) => s.id === GOAL_FAIL_STEP_ID), undefined)
})

test("2. шаг done без evidence (дрейф стора) → gf добавлен, план не закрыт", () => {
  const p = createPlan("goal", ["a", "b"], "node --test")
  doneWithOk(p, "s1")
  const s2 = p.steps[1]!
  s2.status = "done"
  const v = enforceGoal(p)
  assert.equal(v.reached, false)
  assert.ok(v.violations.some((x) => x.includes("s2")), v.violations.join("; "))
  const gf = p.steps.find((s) => s.id === GOAL_FAIL_STEP_ID)!
  assert.ok(gf, "gf добавлен")
  assert.equal(gf.status, "todo")
  assert.ok(gf.text.startsWith("[GOAL_FAIL]"), gf.text)
  assert.equal(p.status, "active")
})

test("3. evidence другой команды при заданном acceptance → violation про несовпадение", () => {
  const p = createPlan("goal", ["a", "b"], "node --test")
  doneWithOk(p, "s1")
  doneWithOk(p, "s2", "pytest -q")
  const v = enforceGoal(p)
  assert.ok(v.violations.some((x) => x.includes("не совпадает с acceptance")), v.violations.join("; "))
  assert.ok(p.steps.find((s) => s.id === GOAL_FAIL_STEP_ID), "gf добавлен")
  // Тот же предикат, что в applyEvidence: команда — префикс acceptance, не ложное нарушение.
  const q = createPlan("goal", ["a", "b"], "node --test tests/goal-evaluator.test.ts")
  doneWithOk(q, "s1", "node --test")
  doneWithOk(q, "s2", "node --test")
  assert.equal(evaluateGoal(q).reached, true)
})

test("4. открытый блокер (status blocked) → gf даже при валидном evidence", () => {
  const p = createPlan("goal", ["a", "b"], "node --test")
  doneWithOk(p, "s1")
  doneWithOk(p, "s2")
  p.status = "blocked"
  const v = enforceGoal(p)
  assert.ok(v.violations.includes("открытый блокер"), v.violations.join("; "))
  assert.ok(p.steps.find((s) => s.id === GOAL_FAIL_STEP_ID), "gf добавлен")
  assert.equal(p.status, "active")
})

test("5. исторический блокер в blockers[] при status active не мешает закрытию", () => {
  const p = createPlan("goal", ["a", "b"], "node --test")
  doneWithOk(p, "s1")
  doneWithOk(p, "s2")
  p.blockers = ["s1: boom"]
  p.status = "active"
  const v = evaluateGoal(p)
  assert.equal(v.reached, true, v.violations.join("; "))
  enforceGoal(p)
  assert.equal(p.status, "done")
})

test("6. failed-шаг даёт violation с числом попыток", () => {
  const p = createPlan("goal", ["a", "b"], "node --test")
  doneWithOk(p, "s1")
  const s2 = p.steps[1]!
  s2.status = "failed"
  s2.attempts = 2
  const v = enforceGoal(p)
  assert.ok(v.violations.some((x) => x.includes("failed (attempts 2)")), v.violations.join("; "))
  assert.ok(p.steps.find((s) => s.id === GOAL_FAIL_STEP_ID), "gf добавлен")
})

test("7. повторный enforceGoal при gf в todo идемпотентен", () => {
  const p = createPlan("goal", ["a", "b"], "node --test")
  doneWithOk(p, "s1")
  p.steps[1]!.status = "done"
  enforceGoal(p)
  const first = p.steps.find((s) => s.id === GOAL_FAIL_STEP_ID)!.text
  // Нарушитель починен, но блокер открыт — текст gf обновляется, новый шаг не заводится.
  p.status = "blocked"
  enforceGoal(p)
  const n = p.steps.length
  assert.equal(n, 3)
  const gf = p.steps.find((s) => s.id === GOAL_FAIL_STEP_ID)!
  assert.equal(gf.status, "todo")
  assert.notEqual(gf.text, first)
  assert.ok(gf.text.includes("открытый блокер"), gf.text)
  assert.equal(p.status, "active")
})

test("8. gf в done + цель всё ещё не достигнута → шага не добавляем, план blocked", () => {
  const p = createPlan("goal", ["a", "b"], "node --test")
  doneWithOk(p, "s1")
  p.steps[1]!.status = "done"
  enforceGoal(p)
  const gf = p.steps.find((s) => s.id === GOAL_FAIL_STEP_ID)!
  gf.status = "done"
  const n = p.steps.length
  enforceGoal(p)
  assert.equal(p.steps.length, n, "новый шаг не заводится")
  assert.equal(p.status, "blocked")
  assert.ok((p.blockers ?? []).some((b) => b.includes("GOAL_FAIL")), JSON.stringify(p.blockers))
})

test("9. гейт срабатывает из точки закрытия transitionStep", () => {
  const p = createPlan("goal", ["a", "b"], "node --test")
  // s1 — дрейф стора: done без evidence текущей попытки.
  p.steps[0]!.status = "done"
  const s2 = p.steps[1]!
  s2.status = "in_progress"
  applyEvidence(p, "s2", createEvidence("node --test", 0, "ok"))
  assert.equal(s2.status, "done")
  assert.notEqual(p.status, "done", "все шаги done, но гейт не прошёл")
  assert.ok(p.steps.find((s) => s.id === GOAL_FAIL_STEP_ID), "gf добавлен")
})

test("10. прямой enforceGoal на закрытом плане с нарушением снимает done", () => {
  const p = createPlan("goal", ["a", "b"], "node --test")
  doneWithOk(p, "s1")
  p.steps[1]!.status = "done"
  enforceGoal(p)
  assert.equal(p.status, "active")
  // План закрыт в обход гейта, затем чек снова падает.
  p.status = "done"
  const v = enforceGoal(p)
  assert.equal(v.reached, false)
  assert.equal(p.status, "active")
})

test("11. текст gf помечен [GOAL_FAIL], содержит id нарушителя, длина ≤ 200", () => {
  const p = createPlan("goal", ["a", "b"], "node --test")
  doneWithOk(p, "s1")
  p.steps[1]!.status = "todo"
  enforceGoal(p)
  const gf = p.steps.find((s) => s.id === GOAL_FAIL_STEP_ID)!
  assert.ok(gf.text.startsWith("[GOAL_FAIL]"), gf.text)
  assert.ok(gf.text.includes("s2"), gf.text)
  assert.ok(gf.text.length <= 200, `длина ${gf.text.length}`)
})

test("12. на один нарушившийся шаг — ровно одно нарушение", () => {
  const p = createPlan("goal", ["a", "b", "c"], "node --test")
  doneWithOk(p, "s1")
  const s2 = p.steps[1]!
  s2.status = "failed"
  s2.attempts = 3
  s2.evidence = [ev("pytest -q", 0, 3)]
  const s3 = p.steps[2]!
  s3.status = "done"
  s3.attempts = 1
  s3.evidence = [ev("node --test", 0, 0)]
  const v = evaluateGoal(p)
  const about2 = v.violations.filter((x) => x.startsWith("s2"))
  assert.equal(about2.length, 1, v.violations.join("; "))
  const about3 = v.violations.filter((x) => x.startsWith("s3"))
  assert.equal(about3.length, 1, v.violations.join("; "))
  assert.ok(about3[0]?.includes("нет успешного evidence"), v.violations.join("; "))
})

test("13. план из одного шага — чек пропущен, закрытие не блокируется", () => {
  const p = createPlan("goal", ["a"], "node --test")
  p.steps[0]!.status = "done"
  const v = enforceGoal(p)
  assert.equal(v.reached, true)
  assert.equal(v.skipped, true)
  assert.deepEqual(v.violations, [])
  assert.equal(p.status, "done")
  assert.equal(p.steps.length, 1, "gf не добавляется")
})

test("14. metadata.trivial при нескольких шагах — тоже skip", () => {
  const p = createPlan("goal", ["a", "b"], "node --test")
  ;(p as unknown as { metadata?: { trivial?: boolean } }).metadata = { trivial: true }
  p.steps[1]!.status = "failed"
  const v = enforceGoal(p)
  assert.equal(v.reached, true)
  assert.equal(v.skipped, true)
  assert.equal(p.status, "done")
  assert.equal(p.steps.length, 2, "gf не добавляется")
})

test("15. план без acceptance.command: проверка команды пропускается, не fail", () => {
  const p = createPlan("goal", ["a", "b"])
  doneWithOk(p, "s1", "любая команда")
  doneWithOk(p, "s2", "любая команда")
  const v = enforceGoal(p)
  assert.equal(v.reached, true, v.violations.join("; "))
  assert.equal(v.skipped, false)
  assert.equal(p.status, "done")
})

test("16. честный путь: evidence exit 0 закрывает последний шаг, план done", () => {
  const p = createPlan("goal", ["a", "b"], "node --test")
  for (const id of ["s1", "s2"]) {
    transitionStep(p, id, "in_progress")
    applyEvidence(p, id, createEvidence("node --test", 0, "ok"))
  }
  const v = evaluateGoal(p)
  assert.equal(v.reached, true, v.violations.join("; "))
  assert.equal(p.status, "done")
  assert.equal(p.steps.length, 2)
})
