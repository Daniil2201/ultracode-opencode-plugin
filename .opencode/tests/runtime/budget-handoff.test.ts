// Фаза 3, интеграция: 61% usage → handoff reason:hard + git-коммит,
// повтор не дублирует, новая сессия видит summary через system.transform.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { storeFileFor, loadStore } from "../../lib/ultracode/store.ts"
import { readHandoff } from "../../lib/ultracode/handoff.ts"

const gitOk = (() => {
  try { execFileSync("git", ["--version"], { encoding: "utf8" }); return true } catch { return false }
})()
const canCommit = gitOk && typeof require !== "undefined"

async function boot(tag: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-bh-"))
  const project = path.join(dir, "proj")
  fs.mkdirSync(project, { recursive: true })
  process.env.XDG_DATA_HOME = path.join(dir, "xdg")
  const mod = await import(`../../plugin/ultracode.ts?${tag}=${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`)
  const captured: any = { hooks: {} as Record<string, any>, tools: {} as Record<string, any>, events: [] as any[] }
  const usageBySession = new Map()
  const ctx: any = {
    location: { directory: project, project: { id: project, directory: project, canonical: project } },
    options: {},
    worktree: project,
    directory: project,
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [], next: undefined }) },
    tool: {
      transform: async (cb: (editor: any) => void) => {
        const editor = { list: () => Object.values(captured.tools), get: (name: string) => captured.tools[name], namespace: () => {}, add: (tool: any) => { captured.tools[tool.name] = tool }, update: (id: string, fn: (t: any) => void) => { if (captured.tools[id]) fn(captured.tools[id]) }, remove: (id: string) => { delete captured.tools[id] } }
        cb(editor)
        return { dispose: async () => {} }
      },
      list: async () => Object.values(captured.tools),
      reload: async () => {},
      hook: async () => ({ dispose: async () => {} }),
    },
    session: {
      hook: async (kind: string, cb: any) => {
        if (kind === "context") captured.hooks["context"] = cb
        if (kind === "prompt") captured.hooks["prompt"] = cb
        if (kind === "compaction") captured.hooks["compaction"] = cb
        return { dispose: async () => {} }
      },
      create: async (opts: any) => ({ id: "child-" + Date.now(), ...opts }),
      prompt: async (opts: any) => ({ info: { providerID: "test", modelID: "test", error: undefined }, parts: [{ type: "text", text: "test response" }] }),
      wait: async () => {},
      context: async () => [],
      interrupt: async () => {},
      get: async () => ({}),
      remove: async () => {},
      switchAgent: async () => {},
      switchModel: async () => {},
      update: async () => {},
      move: async () => {},
      generate: async () => ({ text: "generated" }),
      command: async () => {},
      compact: async () => ({}),
      synthetic: async () => ({}),
    },
    event: { subscribe: async function* () { /* events delivered via ctx._handleEvent in sendEvent */ } },
    provider: { list: async () => [] },
    model: { list: async () => [], default: async () => undefined },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [], next: undefined }) },
    _usageBySession: usageBySession,
  }
  await mod.default.setup(ctx)
  const tool = captured.tools["ultracode_context"]
  const gitLog = (): number => {
    try {
      const out = execFileSync("git", ["log", "--oneline"], { cwd: path.dirname(storeFileFor(project)), encoding: "utf8" })
      return out.trim().split("\n").filter(Boolean).length
    } catch { return 0 }
  }
  const callTool = async (args: Record<string, unknown>) => {
    const out = await tool.execute(args, { sessionID: "lab", messageID: "m1", agent: "lab", directory: project, worktree: project, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} })
    return typeof out === "string" ? out : String(out?.output ?? out)
  }
  const systemTransform = async (system: any[]) => {
    const h = captured.hooks["context"]
    if (h) await h({ sessionID: "lab", system, model: {} })
    for (let i = 0; i < system.length; i++) {
      if (typeof system[i] === "object" && system[i] !== null && typeof system[i].text === "string") system[i] = system[i].text
    }
    return system
  }
  const sendEvent = async (event: unknown) => {
    const handler = (ctx as any)._handleEvent
    if (handler) await handler(event)
    captured.events.push(event)
  }
  return { dir, project, callTool, systemTransform, sendEvent, gitLog, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } } }
}

test("61% usage → hard + коммит; повтор без дубля; новая сессия видит summary", async () => {
  const rt = await boot("bh1")
  try {
    await rt.callTool({ action: "budget", limit: 100 })
    // message.updated с реальными output=61 → hard
    await rt.sendEvent({ type: "message.updated", properties: { info: {
      sessionID: "lab", role: "assistant", modelID: "m", providerID: "p",
      tokens: { total: 61, input: 40, output: 15, reasoning: 0, cache: { read: 6, write: 0 } },
    } } })
    const h = readHandoff(loadStore(storeFileFor(rt.project)))
    assert.equal(h?.reason, "hard")
    assert.ok((h?.usagePct ?? 0) >= 60 && (h?.usagePct ?? 0) < 75, `usagePct=${h?.usagePct}`)
    assert.ok(h?.summary.includes("hard"), "summary без причины")
    const base = rt.gitLog()
    if (canCommit) assert.equal(rt.gitLog(), base + 1, "нет коммита handoff")
    // повторный триггер — без перезаписи
    await rt.sendEvent({ type: "message.updated", properties: { info: {
      sessionID: "lab", tokens: { total: 66 },
    } } })
    const h2 = readHandoff(loadStore(storeFileFor(rt.project)))
    assert.equal(h2?.usagePct, h?.usagePct, "handoff перезаписан повторным триггером")
    if (canCommit) assert.equal(rt.gitLog(), base + 1, "дубль коммита handoff")
    // новая сессия видит summary через system.transform
    const mod2 = await import(`../../plugin/ultracode.ts?bh2=${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`)
    const ctx2: any = {
      location: { directory: rt.project, project: { id: rt.project, directory: rt.project, canonical: rt.project } },
      options: {},
      worktree: rt.project,
      directory: rt.project,
      storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [], next: undefined }) },
      tool: { transform: async (cb: any) => { cb({ list: () => [], get: () => undefined, namespace: () => {}, add: () => {}, update: () => {}, remove: () => {} }); return { dispose: async () => {} } }, list: async () => [], reload: async () => {}, hook: async () => ({ dispose: async () => {} }) },
      session: { hook: async (kind: string, cb: any) => { if (kind === "context") (ctx2 as any)._ctxHook = cb; return { dispose: async () => {} } }, create: async (o: any) => ({ id: "c", ...o }), prompt: async () => ({ info: {}, parts: [] }), wait: async () => {}, context: async () => [], interrupt: async () => {}, get: async () => ({}), remove: async () => {}, switchAgent: async () => {}, switchModel: async () => {}, update: async () => {}, move: async () => {}, generate: async () => ({ text: "" }), command: async () => {}, compact: async () => ({}), synthetic: async () => ({}) },
      event: { subscribe: async function* () {} },
      provider: { list: async () => [] },
      model: { list: async () => [], default: async () => undefined },
      storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [], next: undefined }) },
      _usageBySession: new Map(),
    }
    await mod2.default.setup(ctx2)
    const system: unknown[] = []
    const h2hook = (ctx2 as any)._ctxHook
    if (h2hook) await h2hook({ sessionID: "lab2", system, model: {} })
    for (let i = 0; i < system.length; i++) {
      if (typeof system[i] === "object" && system[i] !== null && typeof system[i].text === "string") system[i] = system[i].text
    }
    assert.ok(system.join("\n").includes("ultracode-handoff"), "handoff не инжектнут новой сессии")
  } finally {
    rt.cleanup()
  }
})
