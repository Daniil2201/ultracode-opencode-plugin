// UC-004 — session-scoped метрики, MCP-ошибки, bounded metrics.jsonl без секретов.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { freshStore } from "../lib/ultracode/schema.ts"
import { getSessionMetrics, recordTool, toolArgs, isErrorOutput, appendMetrics, MAX_METRICS_LINES } from "../lib/ultracode/metrics.ts"

test("two parallel sessions do not mix stats", () => {
  const s = freshStore()
  recordTool(s, "sess-a", "read", 10, false)
  recordTool(s, "sess-a", "read", 10, false)
  recordTool(s, "sess-b", "edit", 20, true)
  const a = getSessionMetrics(s, "sess-a")
  const b = getSessionMetrics(s, "sess-b")
  assert.equal(a.tools, 2)
  assert.equal(b.tools, 1)
  assert.notEqual(a.sessionId, b.sessionId)
})

test("tool args read from input.args only", () => {
  assert.deepEqual(toolArgs({ args: { a: 1 } }), { a: 1 })
  assert.deepEqual(toolArgs({ input: { a: 1 } }), {})
  assert.deepEqual(toolArgs(null), {})
})

test("MCP error is recorded as error", () => {
  assert.equal(isErrorOutput({ metadata: { isError: true } }), true)
  assert.equal(isErrorOutput({ metadata: { status: "error" } }), true)
  assert.equal(isErrorOutput({ result: { isError: true } }), true)
  assert.equal(isErrorOutput({ result: { ok: true } }), false)
  assert.equal(isErrorOutput(null), false)
})

test("metrics file is bounded and secret-free", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "uc004-"))
  const f = path.join(d, "metrics.jsonl")
  for (let i = 0; i < MAX_METRICS_LINES + 50; i++) {
    appendMetrics(f, { ts: new Date().toISOString(), sessionId: "s", tool: `tool-${i} api_hash=SECRET123`, durationMs: 5, isError: false })
  }
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean)
  assert.ok(lines.length <= MAX_METRICS_LINES)
  const raw = fs.readFileSync(f, "utf8")
  assert.ok(!raw.includes("SECRET123"))
})
