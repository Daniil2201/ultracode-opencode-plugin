// UC-033 — разбивка tool-токенов по типам: классификация, ленивая инициализация,
// обратная совместимость со старыми сторами.
import { test } from "node:test"
import assert from "node:assert/strict"
import { freshStore } from "../lib/ultracode/schema.ts"
import {
  classifyTool,
  toolsByKind,
  addToolTokensByKind,
  getSessionMetrics,
  type ToolKind,
} from "../lib/ultracode/metrics.ts"

test("classifyTool: встроенные тулы opencode", () => {
  for (const n of ["bash", "read", "grep", "glob", "edit", "write"]) {
    assert.equal(classifyTool(n), n as ToolKind, n)
  }
})

test("classifyTool: MCP по префиксу сервера и по имени", () => {
  for (const n of ["browser-mcp_browser_click", "tg-manager_get_knowledge", "mcp_something"]) {
    assert.equal(classifyTool(n), "mcp", n)
  }
})

test("classifyTool: остальные встроенные → other", () => {
  for (const n of ["skill", "task", "webfetch", "websearch", "todotowrite", "question", "lsp", "ultracode_context", "triage"]) {
    assert.equal(classifyTool(n), "other", n)
  }
})

test("classifyTool: регистр и мусор не ломают", () => {
  assert.equal(classifyTool("BASH"), "bash")
  assert.equal(classifyTool(""), "other")
  assert.equal(classifyTool(undefined as unknown as string), "other")
})

test("addToolTokensByKind: поле создаётся лениво и копится", () => {
  const store = freshStore()
  const row = getSessionMetrics(store, "s1")
  assert.equal((row as { toolsByKind?: unknown }).toolsByKind, undefined, "поле создано заранее")
  addToolTokensByKind(row, "bash", 100)
  addToolTokensByKind(row, "bash", 50)
  addToolTokensByKind(row, "mcp", 7)
  assert.deepEqual(toolsByKind(row), { bash: 150, read: 0, grep: 0, glob: 0, edit: 0, write: 0, mcp: 7, other: 0 })
})

test("addToolTokensByKind: нули и мусор игнорируются", () => {
  const store = freshStore()
  const row = getSessionMetrics(store, "s1")
  addToolTokensByKind(row, "read", 0)
  addToolTokensByKind(row, "read", -5)
  addToolTokensByKind(row, "read", Number.NaN)
  assert.equal((row as { toolsByKind?: unknown }).toolsByKind, undefined, "создано ради нулей")
})

// Старые сторы без поля обязаны читаться как нули, а не падать.
test("старый стор без toolsByKind читается как нули", () => {
  const store = freshStore()
  const row = getSessionMetrics(store, "legacy")
  assert.deepEqual(toolsByKind(row), { bash: 0, read: 0, grep: 0, glob: 0, edit: 0, write: 0, mcp: 0, other: 0 })
  // частично заполненный стор (например, только mcp) тоже валиден
  ;(row as { toolsByKind?: Record<string, number> }).toolsByKind = { mcp: 42 }
  const k = toolsByKind(row)
  assert.equal(k.mcp, 42)
  assert.equal(k.bash, 0)
  assert.equal(k.other, 0)
})

test("сумма по видам не превышает row.tools", () => {
  const store = freshStore()
  const row = getSessionMetrics(store, "s2")
  const parts: Array<[ToolKind, number]> = [["bash", 500], ["read", 300], ["mcp", 1200], ["other", 40]]
  let total = 0
  for (const [kind, n] of parts) {
    addToolTokensByKind(row, kind, n)
    total += n
  }
  row.tools = total
  const sum = Object.values(toolsByKind(row)).reduce((a, b) => a + b, 0)
  assert.equal(sum, total)
  assert.equal(sum, row.tools)
})

test("стор остаётся сериализуемым без миграции схемы", () => {
  const store = freshStore()
  const row = getSessionMetrics(store, "s3")
  addToolTokensByKind(row, classifyTool("browser-mcp_browser_click"), 999)
  const back = JSON.parse(JSON.stringify(store))
  const k = toolsByKind(back.tokens.external.history[0]!)
  assert.equal(k.mcp, 999)
  assert.equal(back.tokens.external.history[0]!.tools, 0, "tools не тронут разбивкой")
})
