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
})() && typeof require !== "undefined" // bare require недоступен под node --test

const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu "

async function boot(tag: string, project?: string) {
  const dir = project ? path.dirname(project) : fs.mkdtempSync(path.join(os.tmpdir(), "uc-ib-"))
  const proj = project ?? path.join(dir, "proj")
  if (!project) fs.mkdirSync(proj, { recursive: true })
  process.env.XDG_DATA_HOME = path.join(dir, "xdg")
  const mod = await import(`../../plugin/ultracode.ts?${tag}=${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`)
  const hooks = await mod.default({ worktree: proj, project: { id: proj } })
  return {
    dir, project: proj, hooks,
    callTool: (args: Record<string, unknown>) =>
      (hooks.tool.ultracode_context.execute(args, { sessionID: "t" }) as Promise<string>),
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
    await rt.hooks["experimental.chat.system.transform"]({ sessionID: "sA" }, { system: sysA })
    const full = spentOf(rt.project)
    assert.ok(full.spent > 0, "базовая инъекция пуста")
    // лимит 1000 + usage 50% через message.updated (Фаза 4.5: total — снимок)
    await rt.callTool({ action: "budget", limit: 1000 })
    await rt.hooks.event({ event: { type: "message.updated", properties: { info: {
      sessionID: "sB", tokens: { total: 500 },
    } } } })
    const sysB: unknown[] = []
    await rt.hooks["experimental.chat.system.transform"]({ sessionID: "sB" }, { system: sysB })
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
    await rt.hooks.event({ event: { type: "message.updated", properties: { info: {
      sessionID: "sH", modelID: "m", providerID: "p",
      tokens: { total: 65, input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 0 } },
    } } } })
    const h1 = readHandoff(loadStore(storeFileFor(rt.project)))
    assert.equal(h1?.reason, "hard")
    const grepHandoff = (): number => {
      try {
        const out = execFileSync("git", ["log", "--oneline", "--grep=handoff"],
          { cwd: path.dirname(storeFileFor(rt.project)), encoding: "utf8" })
        return out.trim().split("\n").filter(Boolean).length
      } catch { return -1 }
    }
    const commitsBefore = grepHandoff()
    // transform того же sid: ужимает, но handoff не трогает
    const sys: unknown[] = []
    await rt.hooks["experimental.chat.system.transform"]({ sessionID: "sH" }, { system: sys })
    const h2 = readHandoff(loadStore(storeFileFor(rt.project)))
    assert.deepEqual(h2, h1, "transform переписал handoff")
    if (canCommit) assert.equal(grepHandoff(), commitsBefore, "transform добавил handoff-коммит")
  } finally {
    rt.cleanup()
  }
})

test("estimated (лимита нет): ужим не применяется", async () => {
  const rt = await boot("ib3")
  try {
    await seedKnowledge(rt.callTool, 3)
    const sys1: unknown[] = []
    await rt.hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, { system: sys1 })
    const full = spentOf(rt.project)
    // total пришёл, но лимита нет (ни modelLimit, ни providers у тестового ctx)
    await rt.hooks.event({ event: { type: "message.updated", properties: { info: {
      sessionID: "s2", tokens: { total: 1500 },
    } } } })
    const sys2: unknown[] = []
    await rt.hooks["experimental.chat.system.transform"]({ sessionID: "s2" }, { system: sys2 })
    const est = spentOf(rt.project)
    assert.equal(est.budget, full.budget, "бюджет ужат без лимита")
    assert.equal(est.spent, full.spent, "spent изменился без лимита")
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
    updateStoreFile(file, (s) => {
      s.config.modelLimit = 100
      s.config.thresholdHard = 50
    })
    const a = await boot("ib4a", project)
    await a.hooks.event({ event: { type: "message.updated", properties: { info: {
      sessionID: "sT", tokens: { total: 51 },
    } } } })
    assert.equal(readHandoff(loadStore(file))?.reason, "hard", "hard=50 при 51% не сработал")
    updateStoreFile(file, (s) => {
      delete s.handoff
      s.config.thresholdHard = 70
    })
    const b = await boot("ib4b", project)
    await b.hooks.event({ event: { type: "message.updated", properties: { info: {
      sessionID: "sT2", tokens: { total: 51 },
    } } } })
    assert.equal(readHandoff(loadStore(file)), null, "hard=70 при 51% сработал ложно")
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})
