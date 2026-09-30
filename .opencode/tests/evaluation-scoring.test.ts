// UC-019 — scoring: воспроизводимость, clamp, gates, verdict, report без секретов.
import { test } from "node:test"
import assert from "node:assert/strict"
import { evaluateProject } from "../lib/ultracode/evaluation/scoring.ts"
import { toReportJson, toReportMarkdown } from "../lib/ultracode/evaluation/report.ts"

function fullCriteria(score: number) {
  return [
    { id: "correctness", score, max: 30, evidence: ["e1"], findings: [] as string[] },
    { id: "tests", score: 20, max: 20, evidence: [], findings: [] as string[] },
    { id: "runtime", score: 15, max: 15, evidence: [], findings: [] as string[] },
    { id: "security", score: 15, max: 15, evidence: [], findings: [] as string[] },
    { id: "reliability", score: 10, max: 10, evidence: [], findings: [] as string[] },
    { id: "architecture", score: 5, max: 5, evidence: [], findings: [] as string[] },
    { id: "performance", score: 3, max: 3, evidence: [], findings: [] as string[] },
    { id: "docs", score: 2, max: 2, evidence: [], findings: [] as string[] },
  ]
}

test("score reproducible on same snapshot", () => {
  const input = {
    snapshot: "abc", goal: "g", criteria: fullCriteria(30).map((c) => ({ ...c, score: Math.min(c.score, c.max) })),
    hardFailed: [], softFailed: [], blockers: [], commands: ["node --test"], durationMs: 1,
  } as never
  const a = evaluateProject(input)
  const b = evaluateProject(input)
  assert.equal(a.score, b.score)
  assert.equal(a.score, 100)
  assert.equal(a.level, "staff")
})

test("runtime helper-only caps score (unit_only)", () => {
  const r = evaluateProject({
    snapshot: "s", goal: "g", criteria: fullCriteria(30), hardFailed: [],
    softFailed: ["unit_only"], blockers: [], commands: [], durationMs: 0,
  } as never)
  assert.equal(r.score, 79)
  assert.equal(r.level, "middle")
  assert.equal(r.gates["runtime"], "fail")
})

test("security critical can never pass", () => {
  const r = evaluateProject({
    snapshot: "s", goal: "g", criteria: fullCriteria(30), hardFailed: ["secrets"],
    softFailed: [], blockers: [], commands: [], durationMs: 0,
  } as never)
  assert.equal(r.score, 59)
  assert.ok(r.verdict === "needs_changes" || r.verdict === "fail")
})

test("report contains commands, evidence, criteria, blockers — no secrets", () => {
  const r = evaluateProject({
    snapshot: "s", goal: "demo", criteria: fullCriteria(10), hardFailed: [],
    softFailed: [], blockers: [{ id: "b1", severity: "critical", text: "boom" }],
    commands: ["node --test x --password=hunter2"], durationMs: 5,
  } as never)
  const md = toReportMarkdown(r)
  assert.ok(md.includes("## Blockers"))
  assert.ok(md.includes("## Commands"))
  assert.ok(!md.includes("hunter2"))
  assert.doesNotThrow(() => JSON.parse(toReportJson(r)))
})

test("scores clamp to criterion max", () => {
  const r = evaluateProject({
    snapshot: "s", goal: "g",
    criteria: [{ id: "docs", score: 99, max: 2, evidence: [], findings: [] }],
    hardFailed: [], softFailed: [], blockers: [], commands: [], durationMs: 0,
  } as never)
  assert.equal(r.score, 2)
})

test("EV-005: level is computed after caps, not from raw sum", () => {
  // raw сумма 95+, но hard gate режет до 59 → уровень junior, не staff
  const r = evaluateProject({
    snapshot: "s", goal: "g", criteria: fullCriteria(30), hardFailed: ["compile"],
    softFailed: [], blockers: [], commands: [], durationMs: 0,
  } as never)
  assert.equal(r.score, 59)
  assert.equal(r.level, "junior")
})

test("EV-005: BLOCKER: findings become critical blockers", () => {
  const r = evaluateProject({
    snapshot: "s", goal: "g",
    criteria: [{ id: "security", score: 0, max: 15, evidence: [], findings: ["BLOCKER: leak suspected"] }],
    hardFailed: [], softFailed: [], blockers: [], commands: [], durationMs: 0,
  } as never)
  assert.equal(r.blockers.length, 1)
  assert.equal(r.blockers[0]?.severity, "critical")
  assert.ok((r.verdict === "needs_changes" || r.verdict === "fail"))
})
