// Фаза 4.5: addModelUsage ПЕРЕЗАПИСЫВАЕТ total (снимок диалога, не дельта).
import { test } from "node:test"
import assert from "node:assert/strict"
import { addModelUsage, evaluate } from "../lib/ultracode/budget.ts"

test("addModelUsage перезаписывает total, не суммирует", () => {
  const map = new Map()
  addModelUsage(map, "s", { tokens: { total: 314704 } })
  addModelUsage(map, "s", { tokens: { total: 314851 } })
  // было бы 629555 при суммировании (удвоение на каждом шаге)
  assert.equal(map.get("s")!.total, 314851)
  assert.equal(map.get("s")!.estimated, false)
})

test("addModelUsage игнорирует нулевой/отсутствующий total", () => {
  const map = new Map()
  addModelUsage(map, "s", { tokens: { total: 100 } })
  addModelUsage(map, "s", { tokens: { total: 0 } })
  addModelUsage(map, "s", { tokens: {} })
  addModelUsage(map, "s", {})
  addModelUsage(map, "s", { tokens: { total: "x" } })
  assert.equal(map.get("s")!.total, 100, "предыдущий снимок испорчен")
  // без единого total — честный ноль до первого ответа ассистента
  const empty = new Map()
  assert.equal(evaluate({ total: 0, estimated: true }, 100).level, "ok")
  assert.equal(empty.get("s"), undefined)
})
