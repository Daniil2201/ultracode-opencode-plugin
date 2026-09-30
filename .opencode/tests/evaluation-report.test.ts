// EV-007 — report: JSON/Markdown синхронны, полный набор полей, без секретов.
import { test } from "node:test"
import assert from "node:assert/strict"
import { evaluateProject } from "../lib/ultracode/evaluation/scoring.ts"
import { toReportJson, toReportMarkdown } from "../lib/ultracode/evaluation/report.ts"

function result() {
  return evaluateProject({
    snapshot: "rep-snap",
    goal: "Ultracode 2.0",
    criteria: [
      { id: "correctness", score: 30, max: 30, evidence: ["gate compile: exit 0"], findings: [] as string[] },
      { id: "tests", score: 20, max: 20, evidence: [], findings: [] as string[] },
      { id: "runtime", score: 15, max: 15, evidence: [], findings: [] as string[] },
      { id: "security", score: 15, max: 15, evidence: [], findings: [] as string[] },
      { id: "reliability", score: 8, max: 10, evidence: [], findings: ["repro pending"] },
      { id: "architecture", score: 5, max: 5, evidence: [], findings: [] as string[] },
      { id: "performance", score: 2, max: 3, evidence: [], findings: [] as string[] },
      { id: "docs", score: 2, max: 2, evidence: [], findings: [] as string[] },
    ],
    hardFailed: [],
    softFailed: [],
    blockers: [],
    // --password= покрыт санитайзером (голый token — нет, иначе резало бы "token budget")
    commands: ["node --test --password=SECRET9"],
    durationMs: 4242,
  })
}

test("JSON report has the full required shape", () => {
  const json = JSON.parse(toReportJson(result()))
  for (const k of ["snapshot", "goal", "score", "level", "verdict", "gates", "criteria", "blockers", "commands", "durationMs"]) {
    assert.ok(k in json, `missing ${k}`)
  }
  assert.equal(json.criteria.length, 8)
  assert.equal(json.criteria.reduce((s: number, c: { score: number }) => s + c.score, 0), json.score)
  assert.ok(!JSON.stringify(json).includes("SECRET9"))
})

test("Markdown carries the same score/level/verdict plus criteria and blockers", () => {
  const r = {
    ...result(),
    blockers: [{ id: "b1", severity: "major" as const, text: "follow-up needed" }],
  }
  const md = toReportMarkdown(r)
  assert.ok(md.includes(`${r.score}/100`))
  assert.ok(md.includes(r.level))
  assert.ok(md.includes(r.verdict))
  assert.ok(md.includes("| correctness | 30/30 |"))
  assert.ok(md.includes("## Blockers") && md.includes("follow-up needed"))
  assert.ok(!md.includes("SECRET9"))
})

test("timestamp and durationMs survive into both reports", () => {
  const r = { ...result(), timestamp: "2026-01-01T00:00:00.000Z" }
  const json = JSON.parse(toReportJson(r))
  assert.equal(json.timestamp, "2026-01-01T00:00:00.000Z")
  assert.equal(json.durationMs, 4242)
  assert.ok(toReportMarkdown(r).includes("2026-01-01T00:00:00.000Z"))
})
