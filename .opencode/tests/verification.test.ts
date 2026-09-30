// UC-007 — evidence-gate: done только с exit 0, без evidence остаётся verify_required.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createPlan, transitionStep } from "../lib/ultracode/plan.ts"
import { applyEvidence, createEvidence, sanitizeOutput, clipOutput } from "../lib/ultracode/verification.ts"

test("exit 0 -> done, exit 1 -> failed", () => {
  const p = createPlan("goal", ["a"])
  transitionStep(p, "s1", "in_progress")
  transitionStep(p, "s1", "verify_required")
  applyEvidence(p, "s1", createEvidence("node -e 0", 0, "ok"))
  assert.equal(p.steps[0]?.status, "done")
  const q = createPlan("goal", ["a"])
  transitionStep(q, "s1", "in_progress")
  transitionStep(q, "s1", "verify_required")
  applyEvidence(q, "s1", createEvidence("node -e 1", 1, "", "boom"))
  assert.equal(q.steps[0]?.status, "failed")
})

test("no evidence keeps verify_required", () => {
  const p = createPlan("goal", ["a"])
  transitionStep(p, "s1", "in_progress")
  transitionStep(p, "s1", "verify_required")
  assert.equal(p.steps[0]?.status, "verify_required")
})

test("stdout is clipped and secrets redacted", () => {
  const big = "x".repeat(10000)
  const e = createEvidence("cmd", 0, `hello api_hash=ABCDEF ${big}`, "err password=hunter2")
  assert.ok((e.stdout?.length ?? 0) <= 4000 + 100)
  assert.ok(!String(e.stdout).includes("ABCDEF"))
  assert.ok(!String(e.stderr).includes("hunter2"))
  assert.equal(e.truncated, true)
})

test("sanitize + clip are pure", () => {
  assert.ok(sanitizeOutput("token abc").length > 0)
  assert.equal(clipOutput("short").truncated, false)
})
