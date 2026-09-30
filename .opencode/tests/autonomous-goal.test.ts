// UC-014 — автономный loop: goal->plan->tasks->evidence/blocker, retry<=3, resume.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createPlan } from "../lib/ultracode/plan.ts"
import { runAutonomousGoal, planResumable } from "../lib/ultracode/orchestrator.ts"
import { createEvidence, applyEvidence } from "../lib/ultracode/verification.ts"

test("goal creates and executes plan without per-step confirmation", async () => {
  const plan = createPlan("реализуй X, тесты и документацию", ["код", "тесты", "доки"])
  let calls = 0
  await runAutonomousGoal(plan, async (step) => {
    calls++
    step.status = "verify_required"
    applyEvidence(plan, step.id, createEvidence("node --test", 0, "ok"))
  })
  assert.equal(calls, 3)
  assert.equal(plan.steps.every((s) => s.status === "done"), true)
})

test("errors retry up to 3 then blocker", async () => {
  const plan = createPlan("goal", ["flaky"])
  let n = 0
  await runAutonomousGoal(plan, async () => {
    n++
    throw new Error("boom")
  }, { maxIter: 5 })
  const step = plan.steps[0]!
  // после 3 попыток — blocked с blocker-записью
  assert.ok((step.attempts ?? 0) >= 3)
  assert.equal(plan.status, "blocked")
  assert.ok((plan.blockers ?? []).length > 0)
  void n
})

test("plan finishes only with evidence or explicit blocker", () => {
  const plan = createPlan("goal", ["a"])
  assert.equal(planResumable(plan), true)
  plan.steps[0]!.status = "verify_required"
  assert.equal(planResumable(plan), true) // без evidence всё ещё resumable
})
