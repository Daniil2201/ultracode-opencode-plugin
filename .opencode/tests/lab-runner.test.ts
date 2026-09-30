// UC-016 — lab-runner: timeout не вешает, вывод режется+redact, ошибка — evidence.
import { test } from "node:test"
import assert from "node:assert/strict"
import { runLabCommand, execSafe, sanitizeCommand, runsReproducible } from "../lib/ultracode/evaluation/lab-runner.ts"

const CWD = process.cwd()

test("passing command becomes exit-0 evidence", () => {
  const e = runLabCommand("node -e \"process.exit(0)\"", CWD, 10_000)
  assert.equal(e.exitCode, 0)
  assert.ok(typeof e.durationMs === "number")
  assert.ok(e.ts.length > 0)
})

test("failing command becomes evidence, not a throw", () => {
  const e = runLabCommand("node -e \"process.exit(3)\"", CWD, 10_000)
  assert.equal(e.exitCode, 3)
})

test("timeout does not hang the runner", () => {
  const e = runLabCommand("sleep 30", CWD, 500)
  assert.notEqual(e.exitCode, 0)
  assert.ok((e.stderr ?? "").includes("TIMEOUT"))
  assert.ok((e.durationMs ?? 0) < 15_000)
})

test("output is clipped and secrets redacted", () => {
  const e = runLabCommand("node -e \"console.log('x'.repeat(20000)); console.error('api_hash=SECRET9')\"", CWD, 10_000)
  assert.ok(((e.stdout ?? "").length) <= 4000)
  assert.ok(!(e.stderr ?? "").includes("SECRET9"))
  assert.equal(e.truncated, true)
})

test("command itself is redacted", () => {
  assert.ok(!sanitizeCommand("deploy --password=hunter2").includes("hunter2"))
})

test("two green runs are reproducible, red is not", () => {
  const a = runLabCommand("node -e \"process.exit(0)\"", CWD, 10_000)
  const b = runLabCommand("node -e \"process.exit(0)\"", CWD, 10_000)
  assert.equal(runsReproducible(a, b), true)
  const c = runLabCommand("node -e \"process.exit(1)\"", CWD, 10_000)
  assert.equal(runsReproducible(a, c), false)
  void execSafe
})
