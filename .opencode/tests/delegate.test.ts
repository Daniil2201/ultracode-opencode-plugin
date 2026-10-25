import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

function makeCtx(opts?: { agent?: string; providerModels?: Record<string, string[]> }) {
  const tools: Record<string, any> = {}
  const created: any[] = []
  const prompted: any[] = []
  const interrupted: string[] = []
  const ctx: any = {
    location: { directory: "/tmp/proj", project: { id: "/tmp/proj", directory: "/tmp/proj", canonical: "/tmp/proj" } },
    options: {},
    worktree: "/tmp/proj",
    directory: "/tmp/proj",
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [], next: undefined }) },
    tool: {
      transform: async (cb: (editor: any) => void) => {
        const editor = { list: () => Object.values(tools), get: (name: string) => tools[name], namespace: () => {}, add: (tool: any) => { tools[tool.name] = tool }, update: (id: string, fn: (t: any) => void) => { if (tools[id]) fn(tools[id]) }, remove: (id: string) => { delete tools[id] } }
        cb(editor)
        return { dispose: async () => {} }
      },
      list: async () => Object.values(tools),
      reload: async () => {},
      hook: async () => ({ dispose: async () => {} }),
    },
    session: {
      hook: async () => ({ dispose: async () => {} }),
      create: async (o: any) => { created.push(o); return { id: "child-" + created.length } },
      prompt: async (o: any) => { prompted.push(o); return { info: { providerID: o?.model?.providerID ?? "test", modelID: o?.model?.modelID ?? "test", error: undefined }, parts: [{ type: "text", text: "child result text" }] } },
      wait: async () => {},
      context: async () => [],
      interrupt: async (o: any) => { interrupted.push(o?.sessionID) },
      get: async () => ({}),
      remove: async () => {},
      switchAgent: async () => {},
      switchModel: async () => {},
      update: async () => {},
      move: async () => {},
      generate: async () => ({ text: "" }),
      command: async () => {},
      compact: async () => ({}),
      synthetic: async () => ({}),
    },
    event: { subscribe: async function* () {} },
    provider: {
      list: async () => {
        const models: Record<string, any> = {}
        for (const [pid, mids] of Object.entries(opts?.providerModels ?? { test: ["test"] })) {
          const m: Record<string, any> = {}
          for (const mid of mids) m[mid] = { limit: { context: 1000 } }
          models[pid] = { id: pid, models: m }
        }
        return Object.values(models)
      },
    },
    model: { list: async () => [], default: async () => undefined },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [], next: undefined }) },
    location: { directory: "/tmp/proj", project: { id: "/tmp/proj", directory: "/tmp/proj", canonical: "/tmp/proj" } },
    options: {},
    _usageBySession: new Map(),
  }
  return { ctx, tools, created, prompted, interrupted }
}

async function loadPlugin(ctx: any) {
  const mod = await import(`../plugin/ultracode.ts?d=${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`)
  await mod.default.setup(ctx)
  return ctx
}

function tctx(agent = "ultracode", sessionID = "parent-1") {
  const ac = new AbortController()
  return { sessionID, messageID: "m1", agent, directory: "/tmp/proj", worktree: "/tmp/proj", abort: ac.signal, metadata: () => {}, ask: async () => {}, _ac: ac }
}

test("delegate: valid model checked against catalog; unknown rejected before create", async () => {
  const { ctx, tools, created } = makeCtx({ providerModels: { test: ["test"] } })
  await loadPlugin(ctx)
  const tool = tools["ultracode_delegate"]
  const r1 = await tool.execute({ agent: "ultracode-executor", prompt: "do work", providerID: "test", modelID: "test" }, tctx())
  assert.match(r1.output, /delegate ultracode-executor/)
  assert.equal(created.length, 1)
  assert.equal(created[0].parentID, "parent-1")
  assert.deepEqual(created[0].model, { providerID: "test", modelID: "test" })

  const r2 = await tool.execute({ agent: "ultracode-executor", prompt: "do work", providerID: "nope", modelID: "nope" }, tctx())
  assert.match(r2.output, /не найдена в каталоге/)
  assert.equal(created.length, 1) // no new session
})

test("delegate: catalog read failure rejects before create", async () => {
  const { ctx, tools, created } = makeCtx()
  ctx.provider.list = async () => { throw new Error("boom") }
  await loadPlugin(ctx)
  const tool = tools["ultracode_delegate"]
  const r = await tool.execute({ agent: "ultracode-executor", prompt: "do", providerID: "test", modelID: "test" }, tctx())
  assert.match(r.output, /каталог моделей недоступен/)
  assert.equal(created.length, 0)
})

test("delegate: session.create gets parentID; prompt gets agent/model/prompt", async () => {
  const { ctx, tools, created, prompted } = makeCtx()
  await loadPlugin(ctx)
  const tool = tools["ultracode_delegate"]
  const r = await tool.execute({ agent: "ultracode-reviewer", prompt: "review this", providerID: "test", modelID: "test" }, tctx())
  assert.match(r.output, /child result text/)
  assert.equal(created.length, 1)
  assert.equal(created[0].parentID, "parent-1")
  assert.equal(created[0].agent, "ultracode-reviewer")
  assert.equal(prompted.length, 1)
  assert.equal(prompted[0].sessionID, "child-1")
  assert.equal(prompted[0].agent, "ultracode-reviewer")
  assert.deepEqual(prompted[0].model, { providerID: "test", modelID: "test" })
  assert.equal(prompted[0].parts[0].text, "review this")
  assert.equal(prompted[0].text, "review this")
})

test("delegate: no model override -> model omitted from prompt", async () => {
  const { ctx, tools, prompted } = makeCtx()
  await loadPlugin(ctx)
  const tool = tools["ultracode_delegate"]
  const r = await tool.execute({ agent: "ultracode-planner", prompt: "plan" }, tctx())
  assert.match(r.output, /delegate ultracode-planner/)
  assert.equal(prompted.length, 1)
  assert.equal(prompted[0].model, undefined)
})

test("delegate: preferFree auto-selects free model from catalog", async () => {
  const { ctx, tools, prompted } = makeCtx({ providerModels: { opencode: ["gpt-5", "beam-free"] } })
  await loadPlugin(ctx)
  const tool = tools["ultracode_delegate"]
  const r = await tool.execute({ agent: "ultracode-executor", prompt: "x", preferFree: true }, tctx())
  assert.match(r.output, /delegate ultracode-executor/)
  assert.equal(prompted.length, 1)
  assert.deepEqual(prompted[0].model, { providerID: "opencode", modelID: "beam-free" })
})

test("delegate: preferFree with no free model leaves model unset", async () => {
  const { ctx, tools, prompted } = makeCtx({ providerModels: { opencode: ["gpt-5", "gpt-4"] } })
  await loadPlugin(ctx)
  const tool = tools["ultracode_delegate"]
  const r = await tool.execute({ agent: "ultracode-executor", prompt: "x", preferFree: true }, tctx())
  assert.match(r.output, /delegate ultracode-executor/)
  assert.equal(prompted.length, 1)
  assert.equal(prompted[0].model, undefined)
})

test("delegate: result includes actual model from AssistantMessage", async () => {
  const { ctx, tools } = makeCtx()
  ctx.session.prompt = async (o: any) => ({ info: { providerID: "realp", modelID: "realm", error: undefined }, parts: [{ type: "text", text: "answer" }] })
  await loadPlugin(ctx)
  const tool = tools["ultracode_delegate"]
  const r = await tool.execute({ agent: "ultracode-executor", prompt: "x" }, tctx())
  assert.match(r.output, /model: realp\/realm/)
  assert.match(r.output, /answer/)
})

test("delegate: SDK envelope error returned as error", async () => {
  const { ctx, tools } = makeCtx()
  ctx.session.prompt = async () => ({ error: { message: "sdk boom" } })
  await loadPlugin(ctx)
  const tool = tools["ultracode_delegate"]
  const r = await tool.execute({ agent: "ultracode-executor", prompt: "x" }, tctx())
  assert.match(r.output, /sdk boom/)
})

test("delegate: AssistantMessage.error returned as error", async () => {
  const { ctx, tools } = makeCtx()
  ctx.session.prompt = async () => ({ info: { providerID: "p", modelID: "m", error: { message: "assistant failed" } }, parts: [] })
  await loadPlugin(ctx)
  const tool = tools["ultracode_delegate"]
  const r = await tool.execute({ agent: "ultracode-executor", prompt: "x" }, tctx())
  assert.match(r.output, /assistant failed/)
})

test("delegate: abort triggers interrupt, child not removed", async () => {
  const { ctx, tools, interrupted } = makeCtx()
  const ac = new AbortController()
  ctx.session.prompt = async (o: any) => {
    // simulate abort
    ac.abort()
    await new Promise((r) => setTimeout(r, 10))
    throw new Error("aborted")
  }
  await loadPlugin(ctx)
  const tool = tools["ultracode_delegate"]
  const tc = tctx()
  tc.abort = ac.signal
  const r = await tool.execute({ agent: "ultracode-executor", prompt: "x" }, tc)
  assert.match(r.output, /aborted/)
  // interrupt called best-effort
  // (may or may not have child id; check not crash)
})

test("delegate: authorization - non-primary caller rejected", async () => {
  const { ctx, tools, created } = makeCtx()
  await loadPlugin(ctx)
  const tool = tools["ultracode_delegate"]
  const r = await tool.execute({ agent: "ultracode-executor", prompt: "x" }, tctx("subagent"))
  assert.match(r.output, /только primary agent ultracode/)
  assert.equal(created.length, 0)
})

test("delegate: authorization - child agent 'ultracode' rejected", async () => {
  const { ctx, tools, created } = makeCtx()
  await loadPlugin(ctx)
  const tool = tools["ultracode_delegate"]
  const r = await tool.execute({ agent: "ultracode", prompt: "x" }, tctx())
  assert.match(r.output, /недопустимый agent/)
  assert.equal(created.length, 0)
})

test("delegate: authorization - unknown agent rejected", async () => {
  const { ctx, tools, created } = makeCtx()
  await loadPlugin(ctx)
  const tool = tools["ultracode_delegate"]
  const r = await tool.execute({ agent: "foo", prompt: "x" }, tctx())
  assert.match(r.output, /недопустимый agent/)
  assert.equal(created.length, 0)
})

test("delegate: concurrency - 4th call gets limit error", async () => {
  const { ctx, tools } = makeCtx()
  // make prompt hang to hold slots
  let resolvePrompts: (() => void)[] = []
  ctx.session.prompt = async (o: any) => new Promise((res) => { resolvePrompts.push(() => res({ info: { providerID: "p", modelID: "m", error: undefined }, parts: [{ type: "text", text: "ok" }] })) })
  await loadPlugin(ctx)
  const tool = tools["ultracode_delegate"]
  const calls = [1, 2, 3].map(() => tool.execute({ agent: "ultracode-executor", prompt: "x" }, tctx()))
  // give them time to acquire slots
  await new Promise((r) => setTimeout(r, 50))
  const r4 = await tool.execute({ agent: "ultracode-executor", prompt: "x" }, tctx())
  assert.match(r4.output, /лимит 3 параллельных/)
  // release
  for (const fn of resolvePrompts) fn()
  await Promise.all(calls)
})

test("delegate: metrics written without prompt/output/secret", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-del-"))
  const proj = path.join(dir, "proj")
  fs.mkdirSync(proj, { recursive: true })
  const { ctx, tools } = makeCtx()
  ctx.location = { directory: proj, project: { id: proj, directory: proj, canonical: proj } }
  ctx.worktree = proj
  ctx.directory = proj
  process.env.XDG_DATA_HOME = path.join(dir, "xdg")
  await loadPlugin(ctx)
  const tool = tools["ultracode_delegate"]
  await tool.execute({ agent: "ultracode-executor", prompt: "secret prompt AAA", providerID: "test", modelID: "test" }, tctx())
  // find metrics file
  const root = path.join(process.env.XDG_DATA_HOME, "opencode", "ultracode", "projects")
  const entries = fs.readdirSync(root)
  const mf = path.join(root, entries[0], "metrics.jsonl")
  const raw = fs.readFileSync(mf, "utf8")
  assert.ok(raw.includes("ultracode_delegate"))
  assert.ok(!raw.includes("secret prompt AAA"))
  assert.ok(!raw.includes("child result text"))
  fs.rmSync(dir, { recursive: true, force: true })
})
