// Фаза 4, интеграция: soft ужимает инъекцию; hard пишет handoff только из
// event (transform не переписывает); без лимита (estimated) ужима нет.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { storeFileFor, loadStore, updateStoreFile } from "../../lib/ultracode/store.ts"
import { readHandoff } from "../../lib/ultracode/handoff.ts"

const canCommit = (() => {
  try { execFileSync("git", ["--version"], { encoding: "utf8" }); return true } catch { return false }
})() && typeof require !== "undefined"

const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu "

async function boot(tag: string, project?: string) {
  const dir = project ? path.dirname(project) : fs.mkdtempSync(path.join(os.tmpdir(), "uc-ib-"))
  const proj = project ?? path.join(dir, "proj")
  if (!project) fs.mkdirSync(proj, { recursive: true })
  process.env.XDG_DATA_HOME = path.join(dir, "xdg")
  const mod = await import(`../../plugin/ultracode.ts?${tag}=${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`)
  const captured = { tools: {} as Record<string, any>, hooks: {} as Record<string, any>, events: [] as any[] }
  const usageBySession = new Map()
  const ctx = {
    location: { directory: proj, project: { id: proj, directory: proj, canonical: proj } },
    options: {},
    worktree: proj,
    directory: proj,
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
    event: {
      subscribe: async function* () { /* events delivered via ctx._handleEvent in sendEvent */ },
    },
    provider: { list: async () => [] },
    model: { list: async () => [], default: async () => undefined },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [], next: undefined }) },
    location: { directory: proj, project: { id: proj, directory: proj, canonical: proj } },
    options: {},
    _usageBySession: usageBySession,
  }
  await mod.default.setup(ctx)
  const tool = captured.tools["ultracode_context"]
  const callTool = async (args: Record<string, unknown>) => {
    const out = await tool.execute(args, { sessionID: "lab", messageID: "m1", agent: "lab", directory: proj, worktree: proj, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} })
    return typeof out === "string" ? out : String(out?.output ?? out)
  }
  const systemTransform = async (system: any[]) => {
    const h = captured.hooks["context"]
    if (h) await h({ sessionID: "lab", system, model: {} })
    for (let i = 0; i < system.length; i++) {
      if (typeof system[i] === "object" && system[i] !== null && typeof system[i].text === "string") {
        system[i] = system[i].text
      }
    }
    return system
  }
  const sendEvent = async (event: unknown) => {
    const handler = (ctx as any)._handleEvent
    if (handler) await handler(event)
    captured.events.push(event)
  }
  return {
    dir, project: proj,
    callTool, systemTransform, sendEvent,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } },
  }
}

async function seedKnowledge(callTool: (a: Record<string, unknown>) => Promise<string>, n: number) {
  for (let i = 0; i < n; i++) {
    await callTool({ action: "add", kind: "fact", text: `seed fact ${i} ` + words.repeat(12) })
  }
}

const spentOf = (project: string): { spent: number; budget: number } => {
  const s = loadStore(storeFileFor(project))
  return { spent: s.lastInjection?.spentTokens ?? -1, budget: s.lastInjection?.budgetTokens ?? -1 }
}

test("soft (40%+) ужимает инъекцию: spent меньше, бюджет halved", async () => {
  const rt = await boot("ib1")
  try {
    await seedKnowledge(rt.callTool, 5)
    const sysA: unknown[] = []
    await rt.systemTransform(sysA)
    const full = spentOf(rt.project)
    assert.ok(full.spent > 0, "базовая инъекция пуста")
    await rt.callTool({ action: "budget", limit: 1000 })
    await rt.sendEvent({ type: "message.updated", properties: { info: { sessionID: "lab", tokens: { total: 500 } } } })
    const sysB: unknown[] = []
    await rt.systemTransform(sysB)
    const soft = spentOf(rt.project)
    assert.equal(soft.budget, 1000, `бюджет не halved: ${soft.budget}`)
    assert.ok(soft.spent < full.spent, `soft не ужал: ${soft.spent} >= ${full.spent}`)
  } finally {
    rt.cleanup()
  }
})

test("hard пишет handoff из event; transform не переписывает", async () => {
  const rt = await boot("ib2")
  try {
    await rt.callTool({ action: "budget", limit: 100 })
    await rt.sendEvent({ type: "message.updated", properties: { info: { sessionID: "lab", modelID: "m", providerID: "p", tokens: { total: 65, input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 0 } } } } })
    const h1 = readHandoff(loadStore(storeFileFor(rt.project)))
    assert.equal(h1?.reason, "hard")
    assert.ok((h1?.usagePct ?? 0) >= 60 && (h1?.usagePct ?? 0) < 75, `usagePct=${h1?.usagePct}`)
    const sys: unknown[] = []
    await rt.systemTransform(sys)
    const h2 = readHandoff(loadStore(storeFileFor(rt.project)))
    assert.equal(h2?.usagePct, h1?.usagePct, "handoff перезаписан transform-ом")
  } finally {
    rt.cleanup()
  }
})

test("estimated (лимита нет): ужим не применяется", async () => {
  const rt = await boot("ib3")
  try {
    await seedKnowledge(rt.callTool, 5)
    const sys1: unknown[] = []
    await rt.systemTransform(sys1)
    const full = spentOf(rt.project)
    await rt.sendEvent({ type: "message.updated", properties: { info: { sessionID: "lab", tokens: { total: 1500 } } } })
    const sys2: unknown[] = []
    await rt.systemTransform(sys2)
    const est = spentOf(rt.project)
    assert.equal(est.budget, full.budget, "estimated изменил бюджет")
    assert.equal(est.spent, full.spent, "estimated ужал инъекцию")
  } finally {
    rt.cleanup()
  }
})

test("thresholdHard из конфига: 51% при hard=50 пишет, при hard=70 молчит", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-ib-"))
  const project = path.join(dir, "proj")
  fs.mkdirSync(project, { recursive: true })
  process.env.XDG_DATA_HOME = path.join(dir, "xdg")
  const file = storeFileFor(project)
  try {
    const { updateStoreFile: usf } = await import("../../lib/ultracode/store.ts")
    usf(file, (s: any) => {
      s.config.modelLimit = 100
      s.config.thresholdHard = 50
      s.config.thresholdEmergency = 90
    })
    const rtA = await boot("ib4a", project)
    try {
      await rtA.sendEvent({ type: "message.updated", properties: { info: { sessionID: "lab", tokens: { total: 51 } } } })
      assert.equal(readHandoff(loadStore(file))?.reason, "hard", "hard=50 при 51% не сработал")
    } finally {
      rtA.cleanup()
    }
    // hard=70: 51% не пишет
    usf(file, (s: any) => {
      delete s.handoff
      s.config.thresholdHard = 70
    })
    const rtB = await boot("ib4b", project)
    try {
      await rtB.sendEvent({ type: "message.updated", properties: { info: { sessionID: "lab", tokens: { total: 51 } } } })
      assert.equal(readHandoff(loadStore(file)), null, "hard=70 при 51% сработал ложно")
    } finally {
      rtB.cleanup()
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})
