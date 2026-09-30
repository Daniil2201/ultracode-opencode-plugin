// UC-030 — evidence-gate: шаг закрывается только из начатого состояния, по команде
// acceptance и только через transitionStep.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createPlan, transitionStep } from "../lib/ultracode/plan.ts"
import { applyEvidence, createEvidence, stepNeedsEvidence } from "../lib/ultracode/verification.ts"

test("evidence для шага из todo отклоняется, статус не меняется", () => {
  const p = createPlan("goal", ["a"], "node --test")
  assert.throws(() => applyEvidence(p, "s1", createEvidence("node --test", 0, "ok")), /rejected.*todo/)
  assert.equal(p.steps[0]?.status, "todo")
  assert.equal((p.steps[0]?.evidence ?? []).length, 0)
  assert.equal(p.steps[0]?.attempts, 0)
})

test("evidence для закрытого шага отклоняется", () => {
  const p = createPlan("goal", ["a"], "node --test")
  transitionStep(p, "s1", "in_progress")
  applyEvidence(p, "s1", createEvidence("node --test", 0, "ok"))
  assert.equal(p.steps[0]?.status, "done")
  assert.throws(() => applyEvidence(p, "s1", createEvidence("node --test", 1, "", "boom")), /rejected.*done/)
  assert.equal(p.steps[0]?.status, "done")
})

test("команда не совпадает с acceptance — evidence не принимается", () => {
  const p = createPlan("goal", ["a"], "node --test")
  transitionStep(p, "s1", "in_progress")
  assert.throws(() => applyEvidence(p, "s1", createEvidence("rm -rf /", 0, "ok")), /does not match plan acceptance/)
  assert.equal(p.steps[0]?.status, "in_progress")
  assert.equal((p.steps[0]?.evidence ?? []).length, 0)
})

test("команда-префикс acceptance принимается", () => {
  const p = createPlan("goal", ["a"], "node --test --run a.ts")
  transitionStep(p, "s1", "in_progress")
  applyEvidence(p, "s1", createEvidence("node --test", 0, "ok"))
  assert.equal(p.steps[0]?.status, "done")
})

test("in_progress + совпадающая команда + exit 0 → done", () => {
  const p = createPlan("goal", ["a"], "node --test")
  transitionStep(p, "s1", "in_progress")
  applyEvidence(p, "s1", createEvidence("node --test", 0, "ok"))
  assert.equal(p.steps[0]?.status, "done")
  assert.equal(p.status, "done")
  assert.equal(p.steps[0]?.evidence?.[0]?.attempt, 0)
})

test("exit 1 → failed + attempts, затем успешная попытка закрывает шаг", () => {
  const p = createPlan("goal", ["a"], "node --test")
  transitionStep(p, "s1", "in_progress")
  applyEvidence(p, "s1", createEvidence("node --test", 1, "", "boom"))
  assert.equal(p.steps[0]?.status, "failed")
  assert.equal(p.steps[0]?.attempts, 1)
  // retry: failed → in_progress → verify_required → успех текущей попытки
  transitionStep(p, "s1", "in_progress")
  transitionStep(p, "s1", "verify_required")
  applyEvidence(p, "s1", createEvidence("node --test", 0, "ok"))
  assert.equal(p.steps[0]?.status, "done")
  assert.equal(p.steps[0]?.evidence?.[1]?.attempt, 1)
})

test("stepNeedsEvidence истинно только для in_progress|verify_required", () => {
  const p = createPlan("goal", ["a"], "node --test")
  assert.equal(stepNeedsEvidence(p, "s1"), false)
  transitionStep(p, "s1", "in_progress")
  assert.equal(stepNeedsEvidence(p, "s1"), true)
  transitionStep(p, "s1", "verify_required")
  assert.equal(stepNeedsEvidence(p, "s1"), true)
  applyEvidence(p, "s1", createEvidence("node --test", 0, "ok"))
  assert.equal(stepNeedsEvidence(p, "s1"), false)
  assert.throws(() => stepNeedsEvidence(p, "nope"), /unknown step/)
})

test("план без acceptance: сверка команды пропускается (обратная совместимость)", () => {
  const p = createPlan("goal", ["a"])
  assert.equal(p.acceptance, undefined)
  transitionStep(p, "s1", "in_progress")
  applyEvidence(p, "s1", createEvidence("любая команда", 0, "ok"))
  assert.equal(p.steps[0]?.status, "done")
})

test("stale success не закрывает новую попытку (UC-018)", () => {
  const p = createPlan("goal", ["a"], "node --test")
  transitionStep(p, "s1", "in_progress")
  transitionStep(p, "s1", "verify_required")
  // Успех попытки 0 записан вручную, попытка сдвинута на 1.
  p.steps[0]!.evidence = [{ ...createEvidence("node --test", 0, "old"), attempt: 0 }]
  p.steps[0]!.attempts = 1
  assert.throws(() => transitionStep(p, "s1", "done"), /without successful evidence for attempt 1/)
})

test("зависимость не выполнена — шаг нельзя начать и закрыть", () => {
  const p = createPlan("goal", ["a", "b"], "node --test")
  p.steps[1]!.dependsOn = ["s1"]
  assert.throws(() => transitionStep(p, "s2", "in_progress"), /dependencies/)
  assert.throws(() => applyEvidence(p, "s2", createEvidence("node --test", 0, "ok")), /rejected.*todo/)
  assert.equal(p.steps[1]?.status, "todo")
})

test("все шаги закрыты → plan.status done через transitionStep", () => {
  const p = createPlan("goal", ["a", "b"], "node --test")
  for (const id of ["s1", "s2"]) {
    transitionStep(p, id, "in_progress")
    applyEvidence(p, id, createEvidence("node --test", 0, "ok"))
  }
  assert.equal(p.steps.every((s) => s.status === "done"), true)
  assert.equal(p.status, "done")
})
