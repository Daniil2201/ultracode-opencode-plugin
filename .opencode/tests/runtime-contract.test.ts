// UC-033 — plan_new режет шаги из однострочного ввода (|, нумерация),
// иначе план складывается в 1 шаг (как в 3 ранах аудита легаси).
import { test } from "node:test"
import assert from "node:assert/strict"
import { validatePlanNewArgs } from "../lib/ultracode/runtime-contract.ts"

test("pipe-separated steps become N steps", () => {
  const out = validatePlanNewArgs({ goal: "g", steps: "recon|tech_scan|db_schema" })
  assert.deepEqual(out.steps, ["recon", "tech_scan", "db_schema"])
})

test("numbered single-line steps become N steps", () => {
  const out = validatePlanNewArgs({ goal: "g", steps: "1. разведка 2. ядро 3. отчёт" })
  assert.equal(out.steps.length, 3)
  assert.match(out.steps[0], /^1\. разведка/)
})

test("newline steps unchanged", () => {
  const out = validatePlanNewArgs({ goal: "g", steps: "one\ntwo" })
  assert.deepEqual(out.steps, ["one", "two"])
})

test("single step stays single", () => {
  assert.deepEqual(validatePlanNewArgs({ goal: "g", steps: "only step" }).steps, ["only step"])
  assert.deepEqual(validatePlanNewArgs({ goal: "g", steps: "s" }).steps, ["s"])
})

test("no false split on mid-sentence numbers", () => {
  const out = validatePlanNewArgs({ goal: "g", steps: "шаг 1. потом текст 2. далее" })
  assert.equal(out.steps.length, 1)
})

test("no false split on decimals", () => {
  assert.deepEqual(validatePlanNewArgs({ goal: "g", steps: "версия 2.0 вышла" }).steps, ["версия 2.0 вышла"])
})

test("text fallback splits piped second line", () => {
  const out = validatePlanNewArgs({ text: "goal\ns1|s2" })
  assert.equal(out.goal, "goal")
  assert.deepEqual(out.steps, ["s1", "s2"])
})

test("empty steps throw", () => {
  assert.throws(() => validatePlanNewArgs({ goal: "g", steps: "  " }), /at least one step/)
})
