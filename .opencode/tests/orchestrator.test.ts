// UC-006 — независимые шаги параллельно, зависимые ждут, max 3 попытки, resume.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createPlan } from "../lib/ultracode/plan.ts"
import { buildStepPrompt, nextBatch, readySteps, shouldRetryStep, planResumable, MAX_PARALLEL } from "../lib/ultracode/orchestrator.ts"

test("step prompt carries planId+stepId+goal", () => {
  const p = buildStepPrompt("plan-1", "s2", "сделать X")
  assert.ok(p.includes("planId=plan-1"))
  assert.ok(p.includes("stepId=s2"))
  assert.ok(p.includes("сделать X"))
})

test("independent steps run in parallel batch (cap 3)", () => {
  const p = createPlan("goal", ["a", "b", "c", "d", "e"])
  assert.equal(MAX_PARALLEL, 3)
  assert.equal(readySteps(p).length, 5)
  assert.equal(nextBatch(p).length, 3)
})

test("dependent step waits for dependency", () => {
  const p = createPlan("goal", ["a", "b"])
  p.steps[1]!.dependsOn = ["s1"]
  assert.equal(readySteps(p).map((s) => s.id).join(","), "s1")
})

test("failed step gets max 3 attempts", () => {
  const p = createPlan("goal", ["a"])
  const s = p.steps[0]!
  s.status = "failed"
  s.attempts = 0
  assert.equal(shouldRetryStep(s), true)
  s.attempts = 3
  assert.equal(shouldRetryStep(s), false)
})

test("plan resumes after restart", () => {
  const p = createPlan("goal", ["a", "b"])
  assert.equal(planResumable(p), true)
  p.steps[0]!.status = "done"
  p.steps[0]!.evidence = [{ command: "c", exitCode: 0, ts: new Date().toISOString() }]
  p.steps[1]!.status = "done"
  p.steps[1]!.evidence = [{ command: "c", exitCode: 0, ts: new Date().toISOString() }]
  p.status = "done"
  assert.equal(planResumable(p), false)
})
