// Фаза 1: даун agentmemory виден как externalMisses, misses инструментов не тронут.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { storeFileFor } from "../../lib/ultracode/store.ts"

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
    const hooks = new Map<string, (event: any) => Promise<void> | void>()
    const ctx = {
      location: { directory: project, project: { id: project, directory: project, canonical: project } },
      session: {
        hook: async (name: string, callback: (event: any) => Promise<void> | void) => {
          hooks.set(name, callback)
          return { dispose: async () => {} }
        },
      },
      event: { subscribe: async function* () {} },
    }
    const cleanup = await mod.default.setup(ctx as any)
    const system: any[] = []
    // V2 context hook: сервис недоступен, но инструкции всё равно инжектятся.
    await hooks.get("context")?.({ sessionID: "s1", system })
    assert.ok(system.some((part) => part?.text?.includes("agentmemory-instructions")))
    // V2 prompt admission hook: /observe недоступен и учитывается отдельно.
    await hooks.get("prompt")?.({
      sessionID: "s1",
      prompt: { text: "test", files: [], agents: [], skills: [] },
      delivery: "steer",
    })
    // prompt hook неблокирующий: ждём только завершения фоновой доставки.
    for (let i = 0; i < 50; i += 1) {
      const current = JSON.parse(fs.readFileSync(storeFileFor(project), "utf8"))
      if ((current.tokens.externalMisses ?? 0) >= 2) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (typeof cleanup === "function") cleanup()
    const store = JSON.parse(fs.readFileSync(storeFileFor(project), "utf8"))
    assert.ok((store.tokens.externalMisses ?? 0) >= 2, `externalMisses=${store.tokens.externalMisses}, ждали ≥2`)
    assert.equal(store.tokens.hitRate.misses, 0, "misses инструментов тронут дауном MCP")
  } finally {
    delete process.env.AGENTMEMORY_URL
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

test("agentmemory payload redacts secrets before network capture", async () => {
  const { safeText } = await import("../../plugin/agentmemory-capture.ts")
  const text = safeText({ apiKey: "SECRET9", message: "ok" }, 1000)
  assert.doesNotMatch(text, /SECRET9/)
  assert.match(text, /\[redacted\]/)
  assert.match(text, /ok/)
})
