// UC-003 — идемпотентная инъекция + раздельные бюджеты.
import { test } from "node:test"
import assert from "node:assert/strict"
import { injectOnce, hasMarker, renderInjection, renderSections, tokens, DEFAULT_BUDGETS } from "../lib/ultracode/injection.ts"

test("two transforms give one block (idempotent)", () => {
  const system: string[] = []
  injectOnce(system, "sess-1", "hello")
  injectOnce(system, "sess-1", "hello")
  assert.equal(system.length, 1)
  assert.ok(hasMarker(system, "sess-1"))
  // другая сессия — свой маркер
  injectOnce(system, "sess-2", "hello")
  assert.equal(system.length, 2)
})

test("budget is not exceeded per section", () => {
  const big = "x".repeat(20000)
  const r = renderInjection({ knowledge: big, lessons: big, plan: "ok", farm: "ok" }, DEFAULT_BUDGETS)
  assert.ok(r.spentTokens <= r.budgetTokens)
  assert.equal(r.truncated.knowledge, true)
  assert.equal(r.truncated.plan, false)
})

test("lastInjection-like report: injected vs evicted accounting", () => {
  const r = renderInjection({ knowledge: "a".repeat(100), lessons: "b" }, { knowledge: 10, lessons: 100, plan: 100, farm: 100 })
  // knowledge обрезан -> truncated true, но текст всё равно в бюджете секции
  assert.equal(typeof r.spentTokens, "number")
  assert.ok(tokens(r.text) <= r.budgetTokens + 50) // грубая оценка + теги
})

// Фаза 4: renderSections — единый путь сборки.
const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu "
const rec = (i: number, kind: string, reps: number) => ({
  id: `k${i}`,
  ts: new Date().toISOString(),
  kind,
  project: "p",
  text: `${kind} record ${i} ` + words.repeat(reps),
  labels: ["lab"],
  source: undefined,
  status: "open" as const,
  archived: false,
})

test("renderSections: порядок секций, сумма ≈ бюджет", () => {
  const r = renderSections(
    { knowledge: [rec(1, "fact", 10), rec(2, "decision", 10)], lessons: [], plans: [], project: "p" },
    1000,
  )
  assert.deepEqual(r.sections.map((s) => s.name), ["knowledge", "lessons", "plans", "farm"])
  assert.ok(r.totalTokens <= r.budgetTokens + 10, `total ${r.totalTokens} > budget ${r.budgetTokens}`)
  assert.equal(r.budgetTokens, 1000)
})

test("renderSections: бюджет 1000 — сплит пропорционален DEFAULT_BUDGETS", () => {
  const r = renderSections(
    {
      knowledge: [rec(1, "fact", 10), rec(2, "fact", 10), rec(3, "fact", 10)],
      lessons: [],
      plans: [],
      farm: words.repeat(40),
      project: "p",
    },
    1000,
  )
  const k = r.sections[0].tokens
  const f = r.sections[3].tokens
  assert.ok(k > f, `доля knowledge (${k}) обязана превышать долю farm (${f})`)
  assert.ok(r.totalTokens <= r.budgetTokens + 10)
})

test("renderSections: бюджет 500 — lessons/farm ужимаются первыми", () => {
  const r = renderSections(
    {
      knowledge: [rec(1, "decision", 12)],
      lessons: [
        { id: "l1", ts: new Date().toISOString(), kind: "lesson", project: "p", text: words.repeat(6), labels: [] },
        { id: "l2", ts: new Date().toISOString(), kind: "lesson", project: "p", text: words.repeat(6), labels: [] },
      ],
      plans: [],
      farm: words.repeat(40),
      project: "p",
    },
    500,
  )
  assert.equal(r.truncated.lessons, true, "lessons обязаны ужаться")
  assert.equal(r.truncated.farm, true, "farm обязан ужаться")
  assert.ok(r.sections[0].tokens > r.sections[3].tokens, "ядро (knowledge) защищено пропорцией")
  assert.ok(r.totalTokens <= r.budgetTokens + 10)
})

test("renderSections: пустые входы — не падает", () => {
  const r = renderSections({ knowledge: [], lessons: [], plans: [], project: "p" }, 2000)
  assert.equal(r.totalTokens, 0)
  assert.deepEqual(r.injected, [])
  assert.equal(r.sections.length, 4)
})
