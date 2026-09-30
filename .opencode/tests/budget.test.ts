// Фаза 4.5: total от платформы — снимок, не сумма. Фаза 3 (накопление) удалена.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  newUsage, usageFor, addModelUsage, evaluate, resolveLimit, thresholdsFrom,
} from "../lib/ultracode/budget.ts"

const at = (total: number, limit = 100) => {
  const map = new Map()
  addModelUsage(map, "s", { tokens: { total } })
  return { verdict: evaluate(map.get("s")!, limit), map }
}

test("evaluate: 39→ok, 40→soft, 59→soft, 60→hard, 75→emergency", () => {
  assert.equal(at(39).verdict.level, "ok")
  assert.equal(at(40).verdict.level, "soft")
  assert.equal(at(59).verdict.level, "soft")
  assert.equal(at(60).verdict.level, "hard")
  assert.equal(at(74).verdict.level, "hard")
  assert.equal(at(75).verdict.level, "emergency")
  assert.equal(at(120).verdict.level, "emergency")
})

test("evaluate: pct = total / limit (cache.read уже внутри total)", () => {
  // реальный кейс из сессии: input 413 + output 208 + reasoning 114 +
  // cache.read 313969 = total 314704; лимит 200k → 157% → emergency
  const { verdict } = at(314704, 200000)
  assert.ok(Math.abs(verdict.pct - 157.352) < 0.01, `pct=${verdict.pct}`)
  assert.equal(verdict.level, "emergency")
  assert.equal(at(40000, 100000).verdict.level, "soft")
})

test("evaluate: неизвестный лимит → ok без порогов, estimated", () => {
  const map = new Map()
  addModelUsage(map, "s", { tokens: { total: 9999 } })
  for (const lim of [0, -5, NaN]) {
    const r = evaluate(map.get("s")!, lim)
    assert.equal(r.level, "ok")
    assert.equal(r.estimated, true)
    assert.ok(Number.isNaN(r.pct))
  }
})

test("evaluate: total 0 + estimated → NaN/ok (ответа ещё не было)", () => {
  const r = evaluate({ total: 0, estimated: true }, 0)
  assert.ok(Number.isNaN(r.pct))
  assert.equal(r.level, "ok")
})

test("evaluate без третьего аргумента → balanced 40/60/75", () => {
  assert.equal(at(39).verdict.level, "ok")
  assert.equal(at(60).verdict.level, "hard")
  assert.equal(at(75).verdict.level, "emergency")
})

test("evaluate с aggressive-профилем: 29 ok, 30 soft, 44 soft, 45 hard, 59 hard, 60 emergency", () => {
  const t = { soft: 30, hard: 45, emergency: 60 }
  const one = (total: number) => {
    const map = new Map()
    addModelUsage(map, "s", { tokens: { total } })
    return evaluate(map.get("s")!, 100, t).level
  }
  assert.equal(one(29), "ok")
  assert.equal(one(30), "soft")
  assert.equal(one(44), "soft")
  assert.equal(one(45), "hard")
  assert.equal(one(59), "hard")
  assert.equal(one(60), "emergency")
})

test("resolveLimit: store → providers-карта → 0", () => {
  const cache = new Map([["acme/m1", 5000]])
  assert.equal(resolveLimit(2000, cache, "acme", "m1"), 2000)
  assert.equal(resolveLimit(undefined, cache, "acme", "m1"), 5000)
  assert.equal(resolveLimit(0, cache, "acme", "m1"), 5000)
  assert.equal(resolveLimit(undefined, cache, "acme", "unknown"), 0)
  assert.equal(resolveLimit(undefined, null, "acme", "m1"), 0)
  assert.equal(resolveLimit(undefined, cache), 0)
})

test("thresholdsFrom: пустой конфиг → balanced", () => {
  assert.deepEqual(thresholdsFrom({ budgetTokens: 2000, anim: false }), { soft: 40, hard: 60, emergency: 75 })
})

test("thresholdsFrom: частичный override", () => {
  assert.deepEqual(
    thresholdsFrom({ budgetTokens: 2000, anim: false, thresholdSoft: 30, thresholdHard: 45 }),
    { soft: 30, hard: 45, emergency: 75 },
  )
})

test("thresholdsFrom: полный override aggressive", () => {
  assert.deepEqual(
    thresholdsFrom({ budgetTokens: 2000, anim: true, thresholdSoft: 30, thresholdHard: 45, thresholdEmergency: 60 }),
    { soft: 30, hard: 45, emergency: 60 },
  )
})

test("usageFor: одна сессия — один снимок", () => {
  const map = new Map()
  assert.equal(usageFor(map, "s1"), map.get("s1"))
  assert.equal(newUsage().total, 0)
  assert.equal(newUsage().estimated, true)
})
