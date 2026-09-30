// UC-022 — гений дебага = дисциплина: одна гипотеза за раз,
// failed не закрывает сессию, fix только с регресс-тестом.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createDebugSession, addHypothesis, nextHypothesis,
  recordAttempt, resolveDebug, debugReport,
} from "../lib/ultracode/debug.ts"

function session() {
  const s = createDebugSession("пост не публикуется", "farm mcp publish")
  addHypothesis(s, "упал bot token", "проверить ответ publish")
  addHypothesis(s, "текст ниже порога", "прогнать quality_check")
  return s
}

test("one hypothesis at a time, fail does not resolve", () => {
  const s = session()
  assert.equal(nextHypothesis(s)?.id, "h1")
  assert.equal(recordAttempt(s, "h1", false, "token ok, ошибка другая"), "open")
  assert.equal(s.status, "open")
  assert.equal(nextHypothesis(s)?.id, "h2")
})

test("all hypotheses failed -> stuck, not resolved", () => {
  const s = session()
  recordAttempt(s, "h1", false, "e1")
  assert.equal(recordAttempt(s, "h2", false, "e2"), "stuck")
  assert.equal(s.status, "stuck")
  assert.throws(() => recordAttempt(s, "h9", true, "x"), /unknown hypothesis/)
})

test("resolve requires regression test, report holds evidence", () => {
  const s = session()
  recordAttempt(s, "h1", false, "e1")
  recordAttempt(s, "h2", true, "score 42 < 70")
  assert.throws(() => resolveDebug(s, "low score", "rework", "  "), /regression test required/)
  resolveDebug(s, "low score", "rework draft", "quality_check must return >= 70")
  assert.equal(s.status, "resolved")
  const r = debugReport(s)
  assert.ok(r.includes("пост не публикуется"))
  assert.ok(r.includes("low score"))
  assert.ok(r.includes("quality_check must return"))
  assert.ok(r.includes("FAIL") && r.includes("PASS"))
})

test("symptom and hypothesis require text", () => {
  assert.throws(() => createDebugSession("  "), /symptom required/)
  const s = createDebugSession("x")
  assert.throws(() => addHypothesis(s, "", "check"), /required/)
})
