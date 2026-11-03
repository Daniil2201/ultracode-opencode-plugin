// UC-017 fixtures: изолированный runtime — отдельный XDG_DATA_HOME + project dir,
// настоящий execute() плагина (тот же модуль, что грузит opencode), персистентный store-файл.
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface Runtime {
  dir: string
  project: string
  callTool: (args: Record<string, unknown>) => Promise<string>
  callToolNamed: (name: string, args: Record<string, unknown>, sessionID?: string) => Promise<string>
  tools: () => string[]
  chatMessage: (text: string) => Promise<void>
  systemTransform: (system: string[]) => Promise<string[]>
  messagesTransform: (messages: unknown[]) => Promise<unknown[]>
  compactSession: (sessionID: string) => Promise<void>
  sendEvent: (event: unknown) => Promise<void>
  storeFile: () => string
  readStoreRaw: () => string
  reload: () => Promise<Runtime>
  reopen: () => Promise<Pick<Runtime, "callTool" | "readStoreRaw" | "storeFile">>
  cleanup: () => void
}

function fakeContext(project: string, captured: { tools: Record<string, any>; hooks: Record<string, any>; events: any[] }): Record<string, unknown> {
  const systemTransforms: any[] = []
  const messagesTransforms: any[] = []
  const compactionHandlers: any[] = []
  const promptHandlers: any[] = []
  const eventSubscribers: any[] = []

  const ctx: Record<string, unknown> = {
    location: { directory: project, project: { id: project, directory: project, canonical: project } },
    options: {},
    worktree: project,
    directory: project,
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({ entries: [], next: undefined }),
    },
    tool: {
      transform: async (cb: (editor: any) => void) => {
        const editor = {
          list: () => Object.values(captured.tools),
          get: (name: string) => captured.tools[name],
          namespace: () => {},
          add: (tool: any) => { captured.tools[tool.name] = tool },
          update: (id: string, fn: (t: any) => void) => { if (captured.tools[id]) fn(captured.tools[id]) },
          remove: (id: string) => { delete captured.tools[id] },
        }
        cb(editor)
        return { dispose: async () => {} }
      },
      list: async () => Object.values(captured.tools),
      reload: async () => {},
      hook: async () => ({ dispose: async () => {} }),
    },
    session: {
      hook: async (kind: string, cb: any) => {
        if (kind === "context") systemTransforms.push(cb)
        if (kind === "prompt") promptHandlers.push(cb)
        if (kind === "compaction") compactionHandlers.push(cb)
        captured.hooks[kind] = cb
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
      subscribe: async function* (opts: any) {
        const queue = captured.events
        // Yield all currently queued events
        while (queue.length > 0) {
          yield queue.shift()
        }
        // Wait for more events (with timeout)
        const start = Date.now()
        while (Date.now() - start < 200) {
          if (queue.length > 0) {
            yield queue.shift()
          } else {
            await new Promise((r) => setTimeout(r, 10))
          }
        }
        // Yield any remaining
        while (queue.length > 0) {
          yield queue.shift()
        }
      },
    },
    provider: {
      list: async () => [],
    },
    model: {
      list: async () => [],
      default: async () => undefined,
    },
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({ entries: [], next: undefined }),
    },
    location: { directory: project, project: { id: project, directory: project, canonical: project } },
    options: {},
    // Capture system transforms for testing
    _systemTransforms: systemTransforms,
    _promptHandlers: promptHandlers,
    _compactionHandlers: compactionHandlers,
  }

  return ctx
}


async function doSendEvent(event: unknown, usageBySession: Map<string, any>, captured: any) {
  const ev = event as any
  if (ev?.type === "message.updated") {
    const info = ev.properties?.info ?? {}
    const msid = info.sessionID || info.sessionId || "lab"
    const t = Number(info?.tokens?.total ?? 0)
    if (t > 0) usageBySession.set(msid, { total: t, estimated: false })
  }
  captured.events.push(event)
  await new Promise((r) => setTimeout(r, 50))
}

export async function makeRuntime(opts?: { config?: Record<string, unknown> }): Promise<Runtime> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-lab-"))
  const project = path.join(dir, "proj")
  fs.mkdirSync(project, { recursive: true })
  // Runtime fixtures model a complete Ultracode installation. The real sync
  // script installs bundled skills globally; copying them into the isolated
  // project keeps the test hermetic and exercises the same discovery format.
  fs.cpSync(path.resolve(import.meta.dirname, "..", "..", "skills"), path.join(project, ".opencode", "skills"), {
    recursive: true,
  })
  process.env.XDG_DATA_HOME = path.join(dir, "xdg")
  const budgetMod = await import("../../lib/ultracode/budget.ts")
  if (opts?.config) {
    const { saveStoreFor, loadStoreFor } = await import("../../lib/ultracode/store.ts")
    const s = loadStoreFor(project)
    Object.assign(s.config, opts.config)
    saveStoreFor(project, s)
  }
  const mod = await import(`../../plugin/ultracode.ts?lab=${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`)
  const captured = { tools: {} as Record<string, any>, hooks: {} as Record<string, any>, events: [] as any[] }
  const usageBySession = new Map()
  const ctx = fakeContext(project, captured)
  ;(ctx as any)._usageBySession = usageBySession
  await mod.default.setup(ctx)
  const tool = captured.tools["ultracode_context"]
  const callTool = async (args: Record<string, unknown>): Promise<string> => {
    const out = await tool.execute(args, { sessionID: "lab", messageID: "m1", agent: "lab", directory: project, worktree: project, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} })
    return typeof out === "string" ? out : String(out?.output ?? out)
  }
  const storeFile = (): string => {
    const root = path.join(process.env.XDG_DATA_HOME as string, "opencode", "ultracode", "projects")
    const entries = fs.existsSync(root) ? fs.readdirSync(root) : []
    if (entries.length === 0) throw new Error("store dir not created yet")
    return path.join(root, entries[0] as string, "context.json")
  }
  const readStoreRaw = (): string => fs.readFileSync(storeFile(), "utf8")
  const reopen = async () => {
    const mod2 = await import(`../../plugin/ultracode.ts?lab=${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`)
    const captured2 = { tools: {} as Record<string, any>, hooks: {} as Record<string, any>, events: [] as any[] }
    const ctx2 = fakeContext(project, captured2)
    await mod2.default.setup(ctx2)
    const tool2 = captured2.tools["ultracode_context"]
    return {
      storeFile,
      readStoreRaw,
      callTool: async (args: Record<string, unknown>): Promise<string> => {
        const out = await tool2.execute(args, { sessionID: "lab", messageID: "m1", agent: "lab", directory: project, worktree: project, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} })
        return typeof out === "string" ? out : String(out?.output ?? out)
      },
    }
  }
  const systemTransforms = (ctx as any)._systemTransforms
  const promptHandlers = (ctx as any)._promptHandlers
  const compactionHandlers = (ctx as any)._compactionHandlers

  return {
    dir, project, callTool, storeFile, readStoreRaw,
    callToolNamed: async (name: string, args: Record<string, unknown>, sessionID = "lab") => {
      const t = captured.tools[name]
      if (!t) throw new Error(`tool not registered: ${name}`)
      const out = await t.execute(args, { sessionID, messageID: "m1", agent: "lab", directory: project, worktree: project, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} })
      return typeof out === "string" ? out : String(out?.output ?? out)
    },
    tools: () => Object.keys(captured.tools),
    chatMessage: async (text: string) => {
      for (const h of promptHandlers) {
        await h({ sessionID: "lab", messageID: "m1", prompt: { text } })
      }
    },
    systemTransform: async (system: any[]) => {
      for (const h of systemTransforms) {
        await h({ sessionID: "lab", system, model: {} })
      }
      // Convert objects back to strings for test assertions
      for (let i = 0; i < system.length; i++) {
        if (typeof system[i] === "object" && system[i] !== null && typeof system[i].text === "string") {
          system[i] = system[i].text
        }
      }
      return system
    },
    messagesTransform: async (messages: unknown[]) => {
      // V2: messages transform is part of context hook
      for (const h of systemTransforms) {
        await h({ sessionID: "lab", system: [], messages, model: {} })
      }
      return messages
    },
    compactSession: async (sessionID: string) => {
      for (const h of compactionHandlers) {
        await h({ sessionID, context: [] })
      }
    },
    sendEvent: async (event: unknown) => {
      const handler = (ctx as any)._handleEvent
      if (handler) await handler(event)
      captured.events.push(event)
    },
    reload: makeRuntime,
    reopen,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } },
  }
}

export async function toolSchema(): Promise<{ actions: string[]; statuses: string[] }> {
  process.env.XDG_DATA_HOME = process.env.XDG_DATA_HOME || fs.mkdtempSync(path.join(os.tmpdir(), "uc-schema-"))
  const mod = await import(`../../plugin/ultracode.ts?schema=${Date.now().toString(36)}`)
  const captured = { tools: {} as Record<string, any>, hooks: {} as Record<string, any>, events: [] as any[] }
  const usageBySession = new Map()
  const ctx = fakeContext("/tmp", captured)
  await mod.default.setup(ctx)
  const tool = captured.tools["ultracode_context"]
  const args = tool.input.properties ? tool.input.properties : (tool.input as any)
  // V2 uses JSON Schema, not zod
  const actionEnum = args?.action?.enum || []
  const statusEnum = args?.status?.enum || []
  return { actions: actionEnum, statuses: statusEnum }
}
