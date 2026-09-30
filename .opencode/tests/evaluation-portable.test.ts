// UC-026 — portable evaluation: матрица поверх stack-contract, скоринг только
// по применимым гейтам. Exec инжектится (фейки), fs — через tmp-каталоги.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  detectWarm,
  evaluatePortable,
  parseEvaluateTarget,
  scorePortable,
  type PortableExec,
  type PortableGateResult,
} from "../lib/ultracode/evaluation/portable.ts"

function mkroot(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-portable-"))
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } } }
}

function fakeExec(map: Record<string, { exitCode: number; stdout?: string; stderr?: string; timedOut?: boolean }>): PortableExec {
  return (cmd: string) => {
    for (const [k, v] of Object.entries(map)) {
      if (cmd.includes(k)) return { exitCode: v.exitCode, stdout: v.stdout ?? "", stderr: v.stderr ?? "", timedOut: v.timedOut ?? false }
    }
    if (cmd.startsWith("command -v ")) {
      const bin = cmd.slice("command -v ".length).trim()
      const missing = (map["__missing__"]?.stdout ?? "").split(" ").filter(Boolean)
      return missing.includes(bin)
        ? { exitCode: 1, stdout: "", stderr: "", timedOut: false }
        : { exitCode: 0, stdout: `/usr/bin/${bin}\n`, stderr: "", timedOut: false }
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false }
  }
}

const PKG = JSON.stringify({ scripts: { test: "jest", build: "tsc" } })

test("all green rust project scores 100/pass", () => {
  const r = mkroot({ "Cargo.toml": '[package]\nname="x"\n' })
  try {
    const res = evaluatePortable(r.dir, fakeExec({ "cargo test": { exitCode: 0, stdout: "test result: ok. 12 passed; 0 failed" } }))
    assert.equal(res.verdict, "pass")
    assert.equal(res.score, 100)
    assert.equal(res.level, "staff")
    const test = res.gates.find((g) => g.name === "test")
    assert.equal(test?.outcome, "pass")
  } finally {
    r.cleanup()
  }
})

test("mixed gates score over applicable only", () => {
  const r = mkroot({ "package.json": PKG })
  try {
    const res = evaluatePortable(r.dir, fakeExec({
      "npm test": { exitCode: 0, stdout: "Tests: 9 passed, 9 total" },
      "npm run build": { exitCode: 1, stderr: "error TS123" },
    }))
    // lint/typecheck отсутствуют в scripts → skipped; build fail + test pass.
    // Веса: test=3, build=2 → (3*1+2*0)/5 = 60.0 (не 50).
    assert.equal(res.verdict, "fail")
    assert.equal(res.score, 60)
    assert.equal(res.level, "middle")
    assert.equal(res.gates.find((g) => g.name === "lint")?.outcome, "skipped")
  } finally {
    r.cleanup()
  }
})

test("missing runtime gives blocked, not fail", () => {
  const r = mkroot({ "composer.json": JSON.stringify({ scripts: { test: "phpunit" } }) })
  try {
    const res = evaluatePortable(r.dir, fakeExec({ "__missing__": { exitCode: 0, stdout: "php composer" } }))
    assert.equal(res.verdict, "inconclusive")
    assert.equal(res.score, null)
    assert.ok(res.gates.some((g) => g.outcome === "blocked"), "expected blocked gates")
    assert.ok(!res.gates.some((g) => g.outcome === "fail"), "blocked must not count as fail")
  } finally {
    r.cleanup()
  }
})

test("no tests executed is N/A, excluded from score", () => {
  const r = mkroot({ "composer.json": JSON.stringify({ scripts: { test: "phpunit" } }) })
  try {
    const res = evaluatePortable(r.dir, fakeExec({
      "composer test": { exitCode: 1, stdout: "No tests executed!" },
    }))
    const test = res.gates.find((g) => g.name === "test")
    assert.equal(test?.outcome, "no-tests")
    assert.equal(res.verdict, "inconclusive")
    assert.equal(res.score, null)
  } finally {
    r.cleanup()
  }
})

test("unknown stack is inconclusive, never throws", () => {
  const r = mkroot({ "README.md": "hi\n" })
  try {
    const res = evaluatePortable(r.dir, fakeExec({}))
    assert.equal(res.verdict, "inconclusive")
    assert.equal(res.score, null)
    assert.equal(res.stack, null)
  } finally {
    r.cleanup()
  }
  assert.equal(evaluatePortable("/nonexistent-uc-portable-xyz", fakeExec({})).verdict, "inconclusive")
})

test("zero applicable gates is inconclusive, not 100", () => {
  // Только preflight/stack: все команды null (голый composer.json без scripts).
  const r = mkroot({ "composer.json": JSON.stringify({ name: "legacy" }) })
  try {
    const res = evaluatePortable(r.dir, fakeExec({}))
    // test default есть (lenient), но рантайма нет → blocked; применимых ноль
    assert.equal(res.score, null)
    assert.ok(res.verdict === "inconclusive" || res.verdict === "fail")
  } finally {
    r.cleanup()
  }
})

test("timeout is blocked with note", () => {
  const r = mkroot({ "Cargo.toml": "[package]\n" })
  try {
    const res = evaluatePortable(r.dir, fakeExec({ "cargo test": { exitCode: 1, stdout: "", timedOut: true } }))
    assert.equal(res.gates.find((g) => g.name === "test")?.outcome, "blocked")
  } finally {
    r.cleanup()
  }
})

test("scorePortable is pure and total", () => {
  const mk = (outcome: PortableGateResult["outcome"]): PortableGateResult => ({
    name: "x", command: "c", outcome, exitCode: outcome === "pass" ? 0 : 1, durationMs: 1, note: "",
  })
  assert.deepEqual(scorePortable([mk("pass"), mk("pass")]), { score: 100, level: "staff", verdict: "pass" })
  assert.deepEqual(scorePortable([mk("pass"), mk("fail")]), { score: 50, level: "junior", verdict: "fail" })
  assert.deepEqual(scorePortable([mk("blocked"), mk("skipped")]).verdict, "inconclusive")
  assert.deepEqual(scorePortable([]).score, null)
})

test("parseEvaluateTarget extracts path or null", () => {
  assert.equal(parseEvaluateTarget("all --target /tmp/x"), "/tmp/x")
  assert.equal(parseEvaluateTarget("--target relative/path"), "relative/path")
  assert.equal(parseEvaluateTarget("all"), null)
  assert.equal(parseEvaluateTarget(""), null)
})

test("weighted failures: 5 env fails of 619 give 95.2 senior, verdict fail", () => {
  // Кейс requests: частичный кредит вместо бинарного нуля.
  // 1-(5*0.3/619)*20 = 0.9515 → 95.2; красные тесты режут staff до senior.
  const gates: PortableGateResult[] = [
    { name: "build", command: null, outcome: "skipped", exitCode: null, durationMs: 0, note: "" },
    {
      name: "test", command: "make test", outcome: "fail", exitCode: 2, durationMs: 1, note: "",
      tests: { passed: 614, failed: 5 },
      failures: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, cause: "environment" as const, weight: 0.3 })),
    },
  ]
  const r = scorePortable(gates)
  assert.equal(r.score, 95.2)
  assert.equal(r.level, "senior")
  assert.equal(r.verdict, "fail")
})

test("level capped at senior with any failed tests", () => {
  const gates: PortableGateResult[] = [{
    name: "test", command: "t", outcome: "fail", exitCode: 1, durationMs: 1, note: "",
    tests: { passed: 995, failed: 5 },
    failures: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, cause: "environment" as const, weight: 0.3 })),
  }]
  const r = scorePortable(gates)
  // Математика дала бы 97 → staff, но красные тесты режут потолок до senior.
  assert.equal(r.score, 97)
  assert.equal(r.level, "senior")
})

test("single counted gate is enough evidence (deviation documented)", () => {
  const gates: PortableGateResult[] = [{
    name: "test", command: "t", outcome: "pass", exitCode: 0, durationMs: 1, note: "",
    tests: { passed: 100, failed: 0 },
  }]
  const r = scorePortable(gates)
  assert.equal(r.score, 100)
  assert.equal(r.verdict, "pass")
})

test("single bare gate without counts stays inconclusive", () => {
  const gates: PortableGateResult[] = [
    { name: "build", command: "make build", outcome: "pass", exitCode: 0, durationMs: 1, note: "" },
  ]
  const r = scorePortable(gates)
  assert.equal(r.score, null)
  assert.equal(r.verdict, "inconclusive")
})

test("unknown failures count as code (fail-closed)", () => {
  const gates: PortableGateResult[] = [{
    name: "test", command: "t", outcome: "fail", exitCode: 1, durationMs: 1, note: "",
    tests: { passed: 90, failed: 10 },
    failures: [],
  }]
  const r = scorePortable(gates)
  // 10 неизвестных = 10 code: 1-(10/100)*20 <0 → clamp 0.
  assert.equal(r.score, 0)
  assert.equal(r.verdict, "fail")
})

test("cold/warm marker detected from artifacts", () => {
  const r = mkroot({})
  try {
    assert.equal(detectWarm(r.dir, "rust", ""), "cold")
    fs.mkdirSync(path.join(r.dir, "target", "debug"), { recursive: true })
    fs.writeFileSync(path.join(r.dir, "target", "debug", "x"), "bin")
    assert.equal(detectWarm(r.dir, "rust", ""), "warm")
    assert.equal(detectWarm(r.dir, "go", ""), null)
    assert.equal(detectWarm("/nonexistent-uc-warm-xyz", "rust", ""), "cold")
  } finally {
    r.cleanup()
  }
})

test("build marker reflects pre-run state, not post-build", () => {
  // Регрессия: маркер, замеренный после сборки, всегда показывал бы warm.
  const r = mkroot({ "Cargo.toml": "[package]\n" })
  try {
    const res = evaluatePortable(r.dir, fakeExec({ "cargo build": { exitCode: 0, stdout: "ok" } }))
    const build = res.gates.find((g) => g.name === "build")
    assert.ok(build?.note.includes("cold"), `expected cold marker, got: ${build?.note}`)
  } finally {
    r.cleanup()
  }
})
