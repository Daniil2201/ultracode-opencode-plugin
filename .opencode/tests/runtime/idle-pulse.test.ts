// Фаза 1 (R.0.1): session.idle — пульс без роста knowledge и без git-коммитов.
// Стиль: настоящий инстанс плагина + изолированный XDG (как fixtures.ts).
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { storeFileFor } from "../../lib/ultracode/store.ts"

async function bootIsolated() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-idle-"))
  const project = path.join(dir, "proj")
  fs.mkdirSync(project, { recursive: true })
  process.env.XDG_DATA_HOME = path.join(dir, "xdg")
  const mod = await import(`../../plugin/ultracode.ts?idle=${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`)
  const ctx: any = {
    location: { directory: project, project: { id: project, directory: project, canonical: project } },
    options: {},
    worktree: project,
    directory: project,
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [], next: undefined }) },
    tool: { transform: async (cb: any) => { cb({ list: () => [], get: () => undefined, namespace: () => {}, add: () => {}, update: () => {}, remove: () => {} }); return { dispose: async () => {} } }, list: async () => [], reload: async () => {}, hook: async () => ({ dispose: async () => {} }) },
    session: { hook: async (kind: string, cb: any) => { return { dispose: async () => {} } }, create: async (o: any) => ({ id: "c", ...o }), prompt: async () => ({ info: {}, parts: [] }), wait: async () => {}, context: async () => [], interrupt: async () => {}, get: async () => ({}), remove: async () => {}, switchAgent: async () => {}, switchModel: async () => {}, update: async () => {}, move: async () => {}, generate: async () => ({ text: "" }), command: async () => {}, compact: async () => ({}), synthetic: async () => ({}) },
    event: { subscribe: async function* () {} },
    provider: { list: async () => [] },
    model: { list: async () => [], default: async () => undefined },
    _usageBySession: new Map(),
  }
  await mod.default.setup(ctx)
  return {
    dir, project, ctx,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } },
  }
}

test("5 idles подряд: knowledge не растёт, коммитов нет, пульс в history", async () => {
  const rt = await bootIsolated()
  try {
    for (let i = 0; i < 5; i++) {
      await (rt.ctx as any)._handleEvent({ type: "session.idle", properties: { sessionID: `idle-sid-${i}` } })
    }
    const file = storeFileFor(rt.project)
    const store = JSON.parse(fs.readFileSync(file, "utf8"))
    assert.equal(store.knowledge.length, 0, "knowledge вырос на idle (мусорный fact вернулся?)")
    assert.equal(store.tokens.external.history.length, 5, "пульсы не записаны в history")
    assert.ok(
      !fs.existsSync(path.join(path.dirname(file), ".git")),
      "idle создал git-репо/коммит (пульс обязан быть без коммита)",
    )
  } finally {
    rt.cleanup()
  }
})
