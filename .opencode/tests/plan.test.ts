// UC-002 — план: verify_required/failed, dependsOn, evidence-gate.
import { test } from "node:test"
import assert from "node:assert/strict"
import { freshStore } from "../lib/ultracode/schema.ts"
import { createPlan, findStep, savePlan, loadPlan, transitionStep, depsDone } from "../lib/ultracode/plan.ts"
import { createEvidence, applyEvidence } from "../lib/ultracode/verification.ts"

test("unknown stepId throws", () => {
  const store = freshStore()
  const p = createPlan("goal", ["a", "b"])
  savePlan(store, p)
  assert.throws(() => transitionStep(p, "s99", "in_progress"), /unknown step/)
  assert.throws(() => findStep(p, "nope"), /unknown step/)
})

test("done without evidence is impossible", () => {
  const p = createPlan("goal", ["a"])
  transitionStep(p, "s1", "in_progress")
  transitionStep(p, "s1", "verify_required")
  assert.throws(() => transitionStep(p, "s1", "done"), /evidence/)
})

test("evidence exit 0 -> done, exit 1 -> failed", () => {
  const p = createPlan("goal", ["a"])
  transitionStep(p, "s1", "in_progress")
  transitionStep(p, "s1", "verify_required")
  applyEvidence(p, "s1", createEvidence("node -e 1", 0, "ok"))
  assert.equal(p.steps[0]?.status, "done")
  const q = createPlan("goal", ["a"])
  transitionStep(q, "s1", "in_progress")
  transitionStep(q, "s1", "verify_required")
  applyEvidence(q, "s1", createEvidence("node -e 1", 1, "", "err"))
  assert.equal(q.steps[0]?.status, "failed")
})

test("dependent step cannot start before dependency", () => {
  const p = createPlan("goal", ["a", "b"])
  p.steps[1]!.dependsOn = ["s1"]
  assert.throws(() => transitionStep(p, "s2", "in_progress"), /dependencies/)
  assert.equal(depsDone(p, p.steps[1]!), false)
  transitionStep(p, "s1", "in_progress")
  transitionStep(p, "s1", "verify_required")
  applyEvidence(p, "s1", createEvidence("check", 0))
  transitionStep(p, "s2", "in_progress")
  assert.equal(p.steps[1]?.status, "in_progress")
})

test("active plan persists after restart (via store round-trip)", () => {
  const store = freshStore()
  const p = createPlan("goal", ["a", "b"], "node --test")
  savePlan(store, p)
  const raw = JSON.stringify(store)
  const back = JSON.parse(raw)
  const loaded = loadPlan({ ...store, plans: back.plans }, p.id)
  assert.equal(loaded.goal, "goal")
  assert.equal(loaded.steps.length, 2)
  assert.equal(loaded.acceptance?.command, "node --test")
})
