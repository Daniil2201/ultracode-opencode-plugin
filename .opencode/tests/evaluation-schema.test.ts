// UC-015 — контракт оценки: детерминизм уровня, сумма весов, hard gates.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CRITERIA, TOTAL_MAX, levelForScore, hardGateCap, softGateCap, applyGates, verdictFor,
} from "../lib/ultracode/evaluation/schema.ts"

test("weights sum to 100", () => {
  assert.equal(TOTAL_MAX, 100)
  assert.deepEqual(CRITERIA.map((c) => c.id), [
    "correctness", "tests", "runtime", "security",
    "reliability", "architecture", "performance", "docs",
  ])
})

test("same scores always give same level (boundaries)", () => {
  assert.equal(levelForScore(0), "junior")
  assert.equal(levelForScore(59), "junior")
  assert.equal(levelForScore(60), "middle")
  assert.equal(levelForScore(79), "middle")
  assert.equal(levelForScore(80), "senior")
  assert.equal(levelForScore(94), "senior")
  assert.equal(levelForScore(95), "staff")
  assert.equal(levelForScore(100), "staff")
  // детерминизм: повторный вызов тот же результат
  assert.equal(levelForScore(86), levelForScore(86))
})

test("critical gate caps score at 59", () => {
  assert.equal(applyGates(95, ["secrets"], []), 59)
  assert.equal(applyGates(95, [], []), 95)
  assert.equal(hardGateCap([]), 100)
})

test("maturity gap caps score at 79", () => {
  assert.equal(applyGates(95, [], ["unit_only"]), 79)
  assert.equal(softGateCap([]), 100)
  // hard доминирует над soft
  assert.equal(applyGates(95, ["compile"], ["unit_only"]), 59)
})

test("verdict reflects blockers and score", () => {
  assert.equal(verdictFor(30, 0), "fail")
  assert.equal(verdictFor(70, 1), "needs_changes")
  assert.equal(verdictFor(86, 0), "pass_with_followups")
  assert.equal(verdictFor(96, 0), "pass")
})
