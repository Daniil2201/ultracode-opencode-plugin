// UC-010 — checkpoint: цель не теряется, summary компактный, без дубликатов.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createPlan } from "../lib/ultracode/plan.ts"
import { buildCheckpoint, checkpointKey, appendCheckpointOnce } from "../lib/ultracode/checkpoint.ts"

test("no active plan keeps explicit marker", () => {
  assert.equal(buildCheckpoint(null), "No active plan")
})

test("checkpoint keeps goal, current step and blockers compactly", () => {
  const p = createPlan("сделать X", ["a", "b"])
  p.steps[0]!.status = "in_progress"
  p.blockers = ["ждём API"]
  const c = buildCheckpoint(p)
  assert.ok(c.includes(`PLAN: ${p.id}`))
  assert.ok(c.includes("GOAL: сделать X"))
  assert.ok(c.includes("CURRENT: s1"))
  assert.ok(c.includes("ждём API"))
  assert.ok(c.length < 2000) // summary, а не вся история
})

test("repeated compaction does not duplicate", () => {
  const p = createPlan("goal", ["a"])
  p.steps[0]!.status = "in_progress"
  const ctx: string[] = []
  const seen = new Set<string>()
  assert.equal(appendCheckpointOnce(ctx, p, seen), true)
  assert.equal(appendCheckpointOnce(ctx, p, seen), false)
  assert.equal(ctx.length, 1)
  void checkpointKey
})
