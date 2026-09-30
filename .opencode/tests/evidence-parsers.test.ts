// UC-024 — кросс-язычный evidence: tool + распарсенные counts/coverage.
// Парсеры тотальные (не бросают), гейтинг по-прежнему только по exitCode.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  detectEvidenceTool,
  parseTestOutput,
  summarizeEvidence,
  createEvidence,
} from "../lib/ultracode/verification.ts"

test("detectEvidenceTool: runners and traps", () => {
  const cases: Array<[string, string]> = [
    ["pytest tests/", "pytest"],
    ["python -m pytest -q", "pytest"],
    ["python3 -m pytest tests/x.py", "pytest"],
    ["py.test old", "pytest"],
    ["cargo test -p mcp", "cargo-test"],
    ["cargo nextest run", "cargo-test"],
    ["npx jest --json", "jest"],
    ["yarn jest src/", "jest"],
    ["npx playwright test", "playwright"],
    ["playwright test e2e/", "playwright"],
  ["make test", "custom"],
  ["npm test", "custom"],
  ["node --test", "node-test"],
  ["node --import=tsx/esm --test test/", "node-test"],
  ["go test ./...", "go-test"],
  ["vendor/bin/phpunit", "phpunit"],
  ["suggest edits here", "custom"],
  ]
  for (const [cmd, want] of cases) {
    assert.equal(detectEvidenceTool(cmd), want, cmd)
  }
})

test("parse pytest summaries", () => {
  assert.deepEqual(parseTestOutput("pytest -q", "12 passed, 3 failed in 1.23s").tests, { passed: 12, failed: 3 })
  assert.deepEqual(parseTestOutput("pytest", "3 failed, 12 passed in 0.5s").tests, { passed: 12, failed: 3 })
  assert.deepEqual(parseTestOutput("pytest", "45 passed in 2.1s").tests, { passed: 45, failed: 0 })
  assert.deepEqual(parseTestOutput("pytest", "no tests ran in 0.01s").tests, { passed: 0, failed: 0 })
  assert.equal(parseTestOutput("pytest", "hello world").tests, undefined)
  assert.equal(parseTestOutput("make test", "hello world").tool, "custom")
})

test("parse cargo summaries, multi-bin summed", () => {
  assert.deepEqual(
    parseTestOutput("cargo test", "test result: ok. 45 passed; 0 failed; 0 ignored").tests,
    { passed: 45, failed: 0 },
  )
  assert.deepEqual(
    parseTestOutput("cargo test", "test result: FAILED. 44 passed; 1 failed;").tests,
    { passed: 44, failed: 1 },
  )
  assert.deepEqual(
    parseTestOutput("cargo test", "test result: ok. 3 passed; 0 failed\ntest result: ok. 9 passed; 1 failed").tests,
    { passed: 12, failed: 1 },
  )
  assert.deepEqual(
    parseTestOutput("cargo test", "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured").tests,
    { passed: 0, failed: 0 },
  )
})

test("parse jest json and text", () => {
  const j = JSON.stringify({ numTotalTests: 45, numPassedTests: 44, numFailedTests: 1 })
  assert.deepEqual(parseTestOutput("npx jest --json", j).tests, { passed: 44, failed: 1 })
  assert.deepEqual(parseTestOutput("npx jest --json", `snapshots updated\n${j}\n`).tests, { passed: 44, failed: 1 })
  assert.equal(parseTestOutput("npx jest --json", "not json at all").tests, undefined)
  assert.deepEqual(
    parseTestOutput("npx jest", "Tests: 1 failed, 44 passed, 45 total").tests,
    { passed: 44, failed: 1 },
  )
  assert.deepEqual(
    parseTestOutput("npx jest", "Tests: 45 passed, 45 total").tests,
    { passed: 45, failed: 0 },
  )
})

test("parse playwright list output", () => {
  assert.deepEqual(parseTestOutput("npx playwright test", "45 passed (30.5s)").tests, { passed: 45, failed: 0 })
  assert.deepEqual(parseTestOutput("npx playwright test", "2 failed").tests, { passed: 0, failed: 2 })
  assert.deepEqual(parseTestOutput("npx playwright test", "45 passed, 2 failed").tests, { passed: 45, failed: 2 })
})

test("parse coverage: xml rate and TOTAL line", () => {
  assert.equal(
    parseTestOutput("pytest --cov", "12 passed\n<coverage line-rate=\"0.7823\" version=\"x\">").coverage,
    78,
  )
  assert.equal(
    parseTestOutput("pytest", "Name Stmts Miss Cover\nTOTAL 100 22 78%").coverage,
    78,
  )
  assert.equal(parseTestOutput("pytest", "12 passed").coverage, undefined)
  assert.equal(parseTestOutput("cargo test", "test result: ok. 1 passed").coverage, undefined)
})

test("createEvidence fills tool/tests/coverage, override wins", () => {
  const e = createEvidence("pytest -q", 0, "12 passed in 1s")
  assert.equal(e.tool, "pytest")
  assert.deepEqual(e.tests, { passed: 12, failed: 0 })
  const over = createEvidence("make test", 0, "12 passed in 1s", undefined, "pytest")
  assert.equal(over.tool, "pytest")
  const bad = createEvidence("pytest -q", 0, "12 passed in 1s", undefined, "mocha")
  assert.equal(bad.tool, "pytest")
  const plain = createEvidence("make test", 0, "done")
  assert.equal(plain.tool, "custom")
  assert.equal(plain.tests, undefined)
})

test("summarizeEvidence formats the meaningful line", () => {
  assert.equal(
    summarizeEvidence({ tool: "cargo-test", tests: { passed: 45, failed: 0 } }),
    "cargo-test · 45/45 passed",
  )
  assert.equal(
    summarizeEvidence({ tool: "pytest", tests: { passed: 12, failed: 3 }, coverage: 78 }),
    "pytest · 12/15 passed, 3 failed · coverage 78%",
  )
  assert.equal(summarizeEvidence({ tool: "custom", coverage: 78 }), "coverage 78%")
  assert.equal(summarizeEvidence({ tool: "custom" }), null)
})

test("counts never affect gating, parsers never throw", () => {
  assert.doesNotThrow(() => parseTestOutput("", undefined, undefined))
  assert.doesNotThrow(() => parseTestOutput("pytest", "═".repeat(5000)))
  const r = parseTestOutput("pytest", "")
  assert.equal(r.tool, "pytest")
  assert.equal(r.tests, undefined)
})

test("redact keeps === headers split from next line (no glue)", async () => {
  const { redactConfidential } = await import("../lib/ultracode/confidential.ts")
  const out = redactConfidential("==== short test summary info ====\nFAILED t - ConnectionError: x\n")
  assert.ok(out.includes("info ====\nFAILED"), "header must stay on its own line")
  // А настоящий log-wrap после одиночного = склеивается вместе с ним.
  assert.equal(redactConfidential("password=\nSECRET123"), "password=[redacted]")
})

test("meaningless detail falls back to id for classification", async () => {
  const { parseFailures } = await import("../lib/ultracode/verification.ts")
  const entries = parseFailures("pytest", "FAILED tests/test_x.py::test_connect_timeout[t0] - ...\n")
  assert.equal(entries.length, 1)
  assert.equal(entries[0].cause, "environment")
})

test("parse node TAP summaries and entries", async () => {
  const { parseFailures } = await import("../lib/ultracode/verification.ts")
  const tap = "TAP version 13\n# tests 24\n# pass 22\n# fail 2\nnot ok 1 - my test\n  failureType: testCodeFailure\n  ...\nok 2 - other\n"
  assert.deepEqual(parseTestOutput("node --test", tap).tests, { passed: 22, failed: 2 })
  const entries = parseFailures("node-test", tap)
  assert.equal(entries.length, 1)
  assert.ok(entries[0].id.includes("my test"))
})

test("parse node spec reporter (tsx default)", async () => {
  const spec = "✔ my test (12ms)\n✖ other test\nℹ tests 206\nℹ pass 205\nℹ fail 1\n"
  const parsed = parseTestOutput("npm test", spec)
  assert.equal(parsed.tool, "node-test")
  assert.deepEqual(parsed.tests, { passed: 205, failed: 1 })
})

test("sniff pytest under make/tox wrappers, not cargo shape", async () => {
  const { parseTestOutput } = await import("../lib/ultracode/verification.ts")
  const wrapped = "collecting...\n5 failed, 614 passed in 75.45s\n"
  const r = parseTestOutput("make test", wrapped)
  assert.equal(r.tool, "pytest")
  assert.deepEqual(r.tests, { passed: 614, failed: 5 })
  const cargo = "test result: ok. 45 passed; 0 failed; finished in 1.23s\n"
  const rc = parseTestOutput("make test", cargo)
  assert.equal(rc.tool, "custom")
  assert.equal(rc.tests, undefined)
})

test("parse phpunit OK and FAILURES", async () => {
  const { parseFailures } = await import("../lib/ultracode/verification.ts")
  assert.deepEqual(
    parseTestOutput("vendor/bin/phpunit", "OK (45 tests, 100 assertions)").tests,
    { passed: 45, failed: 0 },
  )
  const fail = "FAILURES!\nTests: 45, Assertions: 100, Failures: 2.\n1) App\\Test::testA\nFailed asserting that false is true.\n2) App\\Test::testB\nError: boom\n"
  assert.deepEqual(parseTestOutput("vendor/bin/phpunit", fail).tests, { passed: 43, failed: 2 })
  const entries = parseFailures("phpunit", fail)
  assert.equal(entries.length, 2)
  assert.ok(entries[0].cause === "code")
})

test("parse go FAIL entries, counts stay honest", async () => {
  const { parseFailures } = await import("../lib/ultracode/verification.ts")
  const out = "ok  \texample.com/x\t0.1s\n"
  assert.equal(parseTestOutput("go test ./...", out).tests, undefined)
  const failOut = "--- FAIL: TestFoo (0.00s)\n    foo_test.go:12: expected 1, got 2\nFAIL\n"
  const entries = parseFailures("go-test", failOut)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, "TestFoo")
  assert.equal(entries[0].cause, "code")
})

test("classifyFailure: environment, drift, flaky, code", async () => {
  const { classifyFailure } = await import("../lib/ultracode/verification.ts")
  assert.equal(classifyFailure("requests.exceptions.ConnectionError: nope").cause, "environment")
  assert.equal(classifyFailure("test timed out after 30s").cause, "environment")
  assert.equal(classifyFailure("socket.gaierror: DNS fail").cause, "environment")
  assert.equal(classifyFailure("ModuleNotFoundError: No module named 'x'").cause, "drift")
  assert.equal(classifyFailure("AttributeError: 'Y' object has no attribute").cause, "drift")
  assert.equal(classifyFailure("flaky test passed on retry").cause, "flaky")
  assert.equal(classifyFailure("AssertionError: expected 1 got 2").cause, "code")
  assert.equal(classifyFailure("").cause, "code")
  assert.equal(classifyFailure("plain text").weight, 1.0)
})

test("parseFailures caps entries and sanitizes", async () => {
  const { parseFailures } = await import("../lib/ultracode/verification.ts")
  let big = ""
  for (let i = 0; i < 100; i++) big += `FAILED test_${i} - api_hash=ABCDEF${i}\n`
  const entries = parseFailures("pytest", big)
  assert.equal(entries.length, 50)
  assert.ok(!entries.some((e) => e.id.includes("ABCDEF") || e.detail.includes("ABCDEF")))
})

test("createEvidence persists failures bounded", () => {
  const e = createEvidence("pytest -q", 1, "FAILED test_a - ConnectionError: x\n1 failed in 0.1s")
  assert.equal(e.tool, "pytest")
  assert.ok(Array.isArray(e.failures))
  assert.equal(e.failures?.length, 1)
  assert.equal(e.failures?.[0].cause, "environment")
})
