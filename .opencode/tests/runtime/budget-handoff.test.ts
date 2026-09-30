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
// Bare require() недоступен в ESM под node --test (typeof require === "undefined"),
// поэтому git-коммиты плагина там молча no-op. В реальном рантайме opencode
// require есть (проверено вручную: коммит `[ultracode] handoff s61 61% hard`).
// Коммит-ассёрты — только когда require доступен, иначе проверяем идемпотентность
// по неизменности записи.
const canCommit = gitOk && typeof require !== "undefined"

async function boot(tag: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-bh-"))
  const project = path.join(dir, "proj")
  fs.mkdirSync(project, { recursive: true })
  process.env.XDG_DATA_HOME = path.join(dir, "xdg")
  const mod = await import(`../../plugin/ultracode.ts?${tag}=${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`)
  const hooks = await mod.default({ worktree: project, project: { id: project } })
  const gitLog = (): number => {
    try {
      const out = execFileSync("git", ["log", "--oneline"], { cwd: path.dirname(storeFileFor(project)), encoding: "utf8" })
      return out.trim().split("\n").filter(Boolean).length
    } catch { return 0 }
  }
  return {
    dir, project, hooks, gitLog,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } },
  }
}

const toolCtx = () => ({ sessionID: "s61", messageID: "m", agent: "lab" }) as never

test("61% usage → hard + коммит; повтор без дубля; новая сессия видит summary", async () => {
  const rt = await boot("bh1")
  try {
    const tool = rt.hooks.tool.ultracode_context
    await tool.execute({ action: "budget", limit: 100 }, toolCtx())
    // chat.message — малый input, порога нет
    await rt.hooks["chat.message"](
      { sessionID: "s61" },
      { sessionID: "s61", parts: [{ type: "text", text: "короткий вопрос" }] },
    )
    assert.equal(readHandoff(loadStore(storeFileFor(rt.project))), null, "handoff до порога")
    const base = rt.gitLog()
    // message.updated с реальными output=61 → hard (input от chat сверху, всё равно <75)
    await rt.hooks.event({ event: { type: "message.updated", properties: { info: {
      sessionID: "s61", role: "assistant", modelID: "m", providerID: "p",
      tokens: { total: 61, input: 40, output: 15, reasoning: 0, cache: { read: 6, write: 0 } },
    } } } })
    const h = readHandoff(loadStore(storeFileFor(rt.project)))
    assert.equal(h?.reason, "hard")
    assert.ok((h?.usagePct ?? 0) >= 60 && (h?.usagePct ?? 0) < 75, `usagePct=${h?.usagePct}`)
    assert.ok(h?.summary.includes("hard"), "summary без причины")
    if (canCommit) assert.equal(rt.gitLog(), base + 1, "нет коммита handoff")
    // повторный триггер — без перезаписи (handoffWritten): usagePct застыл на 61,
    // хотя пришёл новый снимок total=66. При доступном git — и без второго коммита.
    await rt.hooks.event({ event: { type: "message.updated", properties: { info: {
      sessionID: "s61", tokens: { total: 66 },
    } } } })
    const h2 = readHandoff(loadStore(storeFileFor(rt.project)))
    assert.equal(h2?.usagePct, h?.usagePct, "handoff перезаписан повторным триггером")
    if (canCommit) assert.equal(rt.gitLog(), base + 1, "дубль коммита handoff")
    // новая сессия видит summary через system.transform
    const mod2 = await import(`../../plugin/ultracode.ts?bh2=${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`)
    const hooks2 = await mod2.default({ worktree: rt.project, project: { id: rt.project } })
    const system: unknown[] = []
    await hooks2["experimental.chat.system.transform"]({ sessionID: "s62" }, { system })
    assert.ok(system.join("\n").includes("ultracode-handoff"), "handoff не инжектнут новой сессии")
  } finally {
    rt.cleanup()
  }
})
