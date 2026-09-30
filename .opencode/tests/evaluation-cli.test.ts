// EV-007 — pipeline: gates → criteria → evaluateProject → caps → verdict → файлы.
// Доказывает, что score идёт из взвешенного движка, а не из счёта гейтов.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildCriteria } from "../lib/ultracode/evaluation/criteria.ts"
import type { GateResult } from "../lib/ultracode/evaluation/criteria.ts"
import { evaluateProject } from "../lib/ultracode/evaluation/scoring.ts"
import { runEvaluator, snapshotMetadata } from "../lib/ultracode/evaluation/cli.ts"

function gate(name: string, exitCode = 0, output = "ok"): GateResult {
  return { name, command: `cmd-${name}`, exitCode, durationMs: 1000, output }
}

const SMOKE_GREEN: GateResult[] = [
  "compile", "unit", "runtime", "security", "concurrency",
  "mcp-test", "mcp-clippy", "mcp-fmt",
].map((n) => gate(n))

test("all-green smoke is 79, not 100: score comes from weights+caps, not gate count", () => {
  const built = buildCriteria(SMOKE_GREEN, "smoke")
  assert.deepEqual(built.hardFailed, [])
  assert.ok(built.softFailed.includes("repro_missing"))
  // performance 3 (p95 в норме) + docs частичный 1 → raw 99, но soft cap режет до 79
  const raw = built.criteria.reduce((s, c) => s + c.score, 0)
  assert.equal(raw, 99)
  const r = evaluateProject({
    snapshot: "s", goal: "g", criteria: built.criteria,
    hardFailed: built.hardFailed, softFailed: built.softFailed,
    blockers: built.blockers, commands: [], durationMs: 0,
  })
  assert.equal(r.score, 79)
  assert.equal(r.level, "middle")
})

test("all-green all-mode is 100: p95 measured against SLO", () => {
  const gates: GateResult[] = [...SMOKE_GREEN,
    gate("mcp-release"), gate("farm-health"), gate("install-status"),
    gate("install-smoke"), gate("repro", 0, "REPRO OK")]
  const built = buildCriteria(gates, "all")
  assert.deepEqual(built.hardFailed, [])
  assert.deepEqual(built.softFailed, [])
  const r = evaluateProject({
    snapshot: "s", goal: "g", criteria: built.criteria,
    hardFailed: [], softFailed: [], blockers: [], commands: [], durationMs: 0,
  })
  // 30+20+15+15+10+5+3+2: p95 gate-duration измерен и в норме —
  // третий балл performance заработан harness, а не авансом.
  // Уровень/verdict — строго по таблицам UC-015; остаточный операционный риск
  // (CI/chaos/rollback) — отдельными follow-ups, не скрытой скидкой.
  assert.equal(r.score, 100)
  assert.equal(r.level, "staff")
  assert.equal(r.verdict, "pass")
  const perf = built.criteria.find((c) => c.id === "performance")
  assert.equal(perf?.score, 3)
  assert.ok(perf?.evidence.join(" ").includes("p95"))
})

test("same gate ratio, different scores: compile-red vs docs-red", () => {
  const compileRed = buildCriteria(
    SMOKE_GREEN.map((g) => (g.name === "compile" ? gate("compile", 1, "error TS123") : g)), "smoke")
  const docsRed = buildCriteria(
    [...SMOKE_GREEN, gate("mcp-release"), gate("farm-health"),
      gate("install-status", 1, "MISS x"), gate("install-smoke"),
      gate("repro", 0, "REPRO OK")],
    "all")
  const scoreOf = (b: ReturnType<typeof buildCriteria>): number => evaluateProject({
    snapshot: "s", goal: "g", criteria: b.criteria, hardFailed: b.hardFailed,
    softFailed: b.softFailed, blockers: b.blockers, commands: [], durationMs: 0,
  }).score
  assert.ok(scoreOf(compileRed) <= 59, "compile red caps at 59")
  assert.ok(scoreOf(docsRed) >= 90, "docs red barely dents weighted score")
  assert.notEqual(scoreOf(compileRed), scoreOf(docsRed))
})

test("security red with secret keywords → hard secrets + critical blocker", () => {
  const built = buildCriteria(
    SMOKE_GREEN.map((g) => (g.name === "security" ? gate("security", 1, "✖ secret in evidence is redacted") : g)),
    "smoke")
  assert.ok(built.hardFailed.includes("secrets"))
  assert.ok(built.blockers.some((b) => b.severity === "critical"))
  assert.equal(built.criteria.find((c) => c.id === "security")?.score, 0)
})

test("autonomy red without secret keywords → hard confirmation, not secrets", () => {
  const built = buildCriteria(
    SMOKE_GREEN.map((g) => (g.name === "security" ? gate("security", 1, "✖ scope creep predicate mismatch") : g)),
    "smoke")
  assert.ok(built.hardFailed.includes("confirmation"))
  assert.ok(!built.hardFailed.includes("secrets"))
})

test("concurrency red → hard data_loss + critical blocker", () => {
  const built = buildCriteria(
    SMOKE_GREEN.map((g) => (g.name === "concurrency" ? gate("concurrency", 1, "lost A-0") : g)),
    "smoke")
  assert.ok(built.hardFailed.includes("data_loss"))
  assert.ok(built.blockers.some((b) => b.severity === "critical"))
  assert.equal(built.criteria.find((c) => c.id === "reliability")?.score, 0)
})

test("fmt red deducts architecture, missing gates mark partial", () => {
  const built = buildCriteria(
    SMOKE_GREEN.map((g) => (g.name === "mcp-fmt" ? gate("mcp-fmt", 1, "Diff in main.rs") : g)),
    "smoke")
  assert.equal(built.criteria.find((c) => c.id === "architecture")?.score, 3)
  assert.deepEqual(built.hardFailed, [])
})

test("snapshot marker deterministic without git", () => {
  const a = snapshotMetadata("/tmp")
  const b = snapshotMetadata("/tmp")
  assert.equal(a, b)
  assert.ok(a.startsWith("worktree:") || a.startsWith("git:"))
})

test("runEvaluator writes synced JSON/Markdown and exits 0 on green", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evcli-"))
  try {
    const gatesFile = path.join(dir, "gates.json")
    fs.writeFileSync(gatesFile, JSON.stringify({ gates: SMOKE_GREEN }), "utf8")
    const outJson = path.join(dir, "eval-last.json")
    const outMd = path.join(dir, "eval-last.md")
    const first = runEvaluator({
      gatesFile, root: dir, goal: "Ultracode 2.0", mode: "smoke",
      outJson, outMd, snapshot: "test-snap", durationMs: 123,
    })
    assert.equal(first.exitCode, 0)
    const json = JSON.parse(fs.readFileSync(outJson, "utf8"))
    for (const k of ["snapshot", "goal", "score", "level", "verdict", "gates", "criteria", "blockers", "commands", "durationMs"]) {
      assert.ok(k in json, `eval-last.json missing ${k}`)
    }
    assert.equal(json.snapshot, "test-snap")
    assert.equal(json.durationMs, 123)
    assert.equal(json.criteria.length, 8)
    const md = fs.readFileSync(outMd, "utf8")
    assert.ok(md.includes(String(json.score)) && md.includes(json.level) && md.includes(json.verdict))
    // determinism: повторный запуск — тот же score
    const second = runEvaluator({
      gatesFile, root: dir, goal: "Ultracode 2.0", mode: "smoke",
      outJson, outMd, snapshot: "test-snap", durationMs: 123,
    })
    assert.equal(second.exitCode, first.exitCode)
    assert.deepEqual(JSON.parse(fs.readFileSync(outJson, "utf8")).score, json.score)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("runEvaluator exits non-zero with critical blocker and forces fail verdict", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evcli-"))
  try {
    const gates = SMOKE_GREEN.map((g) =>
      g.name === "security" ? gate("security", 1, "secret persisted: api_hash=XXX") : g)
    const gatesFile = path.join(dir, "gates.json")
    fs.writeFileSync(gatesFile, JSON.stringify({ gates }), "utf8")
    const outJson = path.join(dir, "eval-last.json")
    const outMd = path.join(dir, "eval-last.md")
    const r = runEvaluator({
      gatesFile, root: dir, goal: "g", mode: "smoke",
      outJson, outMd, snapshot: "s", durationMs: 1,
    })
    assert.equal(r.exitCode, 1)
    const json = JSON.parse(fs.readFileSync(outJson, "utf8"))
    assert.equal(json.verdict, "fail")
    assert.ok(json.score <= 59)
    assert.ok(json.blockers.length > 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("mcp-release red deducts correctness without hard gate", () => {
  const built = buildCriteria(
    [...SMOKE_GREEN, gate("mcp-release", 1, "linker error")],
    "smoke")
  // mcp-test зелёный: 30 − 5 (release) = 25, hard-гейта нет
  assert.equal(built.criteria.find((c) => c.id === "correctness")?.score, 25)
  assert.deepEqual(built.hardFailed, [])
})
