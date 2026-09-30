// Фаза 1: даун agentmemory виден как externalMisses, misses инструментов не тронут.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { storeFileFor } from "../../lib/ultracode/store.ts"

// agentmemory-capture — плагин дауна памяти, не часть ultracode: в проекте его нет → скип.
const AGENTMEMORY_PRESENT = fs.existsSync(
  path.resolve(import.meta.dirname, "..", "..", "plugin", "agentmemory-capture.ts"),
)

test("недоступный MCP :3111 → externalMisses растёт, misses стоит", async (t) => {
  if (!AGENTMEMORY_PRESENT) { t.skip("plugin/agentmemory-capture.ts not present in this project"); return }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-extmem-"))
  const project = path.join(dir, "proj")
  fs.mkdirSync(project, { recursive: true })
  process.env.XDG_DATA_HOME = path.join(dir, "xdg")
  process.env.AGENTMEMORY_URL = "http://127.0.0.1:9" // discard-порт: быстрый refuse
  try {
    const mod = await import(`../../plugin/agentmemory-capture.ts?ext=${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`)
    const hooks = await mod.default({ worktree: project, project: { id: project } })
    // путь /context (system.transform) — сервис недоступен
    await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, { system: [] })
    // путь /observe (event → observe → post catch) — сервис недоступен
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "s1", error: "boom" } } })
    const store = JSON.parse(fs.readFileSync(storeFileFor(project), "utf8"))
    assert.ok((store.tokens.externalMisses ?? 0) >= 2, `externalMisses=${store.tokens.externalMisses}, ждали ≥2`)
    assert.equal(store.tokens.hitRate.misses, 0, "misses инструментов тронут дауном MCP")
  } finally {
    delete process.env.AGENTMEMORY_URL
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})
