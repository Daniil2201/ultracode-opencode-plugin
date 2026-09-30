// Токены: реальный cl100k_base + fallback. Регрессия на len/4 (русский недоучёт ~2x).
import { test } from "node:test"
import assert from "node:assert/strict"
import { countTokens, heuristicTokens, isRealTokenizer, tokens } from "../lib/ultracode/tokens.ts"

test("russian is not undercounted 2x (len/4 gave 3, real is 6)", () => {
  if (!isRealTokenizer()) {
    // пакета нет — fallback честно помечен estimated
    const r = countTokens("привет мир")
    assert.equal(r.estimated, true)
    assert.ok(r.n >= 1)
    return
  }
  const r = countTokens("привет мир")
  assert.equal(r.estimated, false)
  assert.equal(r.n, 6)
  assert.equal(heuristicTokens("привет мир"), 5) // fallback близко, но не точен
})

test("wrapper tokens() matches countTokens().n (совместимость 14+ мест)", () => {
  for (const s of ["", "hello world", "x".repeat(100), "план: done — итог"]) {
    assert.equal(tokens(s), countTokens(s).n)
    assert.ok(tokens(s) >= 1)
  }
})

test("heuristic is language-aware (latin/4, cyrillic/2)", () => {
  assert.equal(heuristicTokens("a".repeat(100)), 25)
  assert.ok(heuristicTokens("п".repeat(100)) > heuristicTokens("a".repeat(100)))
})
