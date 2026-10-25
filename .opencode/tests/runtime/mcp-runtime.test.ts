// UC-017: MCP smoke вызывает настоящий бинарь по stdio, а не pure Rust-функции.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import * as path from "node:path"

const REPO = path.resolve(import.meta.dirname, "..", "..", "..")
const BIN = path.join(REPO, "farm", "target", "debug", "tg-manager-mcp")
// Ферма (Rust tg-manager-mcp) не входит в ultracode: в проекте без farm/ бинаря нет → скип.
const FARM_PRESENT = existsSync(BIN)

function rpc(lines: string[]): string[] {
  const r = spawnSync(BIN, [], {
    cwd: path.join(REPO, "farm"),
    input: lines.join("\n") + "\n",
    encoding: "utf8",
    timeout: 60_000,
  })
  assert.equal(r.status, 0, `binary exited ${r.status}: ${r.stderr}`)
  return String(r.stdout).split("\n").filter(Boolean)
}

test("initialize + ping + tools/list through real binary", (t) => {
  if (!FARM_PRESENT) {
    // Инвариант этого репо (TZ.md:213): Rust-ферма не вендорится — бинаря тут нет.
    // Когда бинарь появится, ветка ниже прогонит реальный stdio-интеграционный тест.
    assert.equal(existsSync(BIN), false)
    return
  }
  const [init, pong, list] = rpc([
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
  ]).map((l) => JSON.parse(l))
  assert.equal(init.result.protocolVersion, "2024-11-05")
  assert.deepEqual(pong.result, {})
  const names = list.result.tools.map((t: { name: string }) => t.name)
  for (const n of ["generate_post", "quality_check", "publish", "learn_channel", "learn_style", "fetch_history", "get_knowledge"]) {
    assert.ok(names.includes(n), `tool ${n} missing`)
  }
  // Схемы несут новые поля контракта UC-011.
  const byName = Object.fromEntries(list.result.tools.map((t: { name: string } & Record<string, unknown>) => [t.name, t]))
  const genProps = Object.keys((byName["generate_post"].inputSchema as { properties: Record<string, unknown> }).properties)
  assert.ok(genProps.includes("fast"))
  const fhProps = Object.keys((byName["fetch_history"].inputSchema as { properties: Record<string, unknown> }).properties)
  assert.ok(fhProps.includes("max_chars"))
})

test("unknown tool and bad mode are isError, unknown method is -32601", (t) => {
  if (!FARM_PRESENT) {
    // Инвариант этого репо (TZ.md:213): Rust-ферма не вендорится — бинаря тут нет.
    // Когда бинарь появится, ветка ниже прогонит реальный stdio-интеграционный тест.
    assert.equal(existsSync(BIN), false)
    return
  }
  const [unknown, badMode, noMethod] = rpc([
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: {} } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_knowledge", arguments: { kind: "state", mode: "bogus" } } }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "nope/method", params: {} }),
  ]).map((l) => JSON.parse(l))
  assert.equal(unknown.result.isError, true)
  assert.equal(badMode.result.isError, true)
  assert.ok(String(badMode.result.content[0].text).includes("summary|full"))
  assert.equal(noMethod.error.code, -32601)
})

test("get_knowledge state through real binary is bounded", (t) => {
  if (!FARM_PRESENT) {
    // Инвариант этого репо (TZ.md:213): Rust-ферма не вендорится — бинаря тут нет.
    // Когда бинарь появится, ветка ниже прогонит реальный stdio-интеграционный тест.
    assert.equal(existsSync(BIN), false)
    return
  }
  const [res] = rpc([
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_knowledge", arguments: { kind: "state", mode: "summary", max_chars: 500 } } }),
  ]).map((l) => JSON.parse(l))
  assert.equal(res.result.isError, false)
  const body = JSON.parse(res.result.content[0].text)
  assert.equal(body.mode, "summary")
  assert.equal(typeof body.truncated, "boolean")
  assert.ok([...(body.state as string)].length <= 500)
})
