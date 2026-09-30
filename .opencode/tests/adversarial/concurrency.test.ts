// UC-018: concurrency, duplicate claim, resume, stale evidence, retry —
// конкурентная запись через НАСТОЯЩИЕ процессы и настоящий store.ts,
// остальное через настоящий tool path плагина.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { makeRuntime } from "../runtime/fixtures.ts"

const REPO = path.resolve(import.meta.dirname, "..", "..", "..")
const STORE_TS = pathToFileURL(path.join(REPO, ".opencode", "lib", "ultracode", "store.ts")).href

function writerChild(xdg: string, proj: string, tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const code = `
      process.env.XDG_DATA_HOME = ${JSON.stringify(xdg)};
      const { updateStoreFile, storeFileFor } = await import(${JSON.stringify(STORE_TS)});
      const file = storeFileFor(${JSON.stringify(proj)});
      for (let i = 0; i < 10; i++) {
        updateStoreFile(file, (s) => {
          const id = ${JSON.stringify(tag)} + "-" + i;
          s.plans[id] = { id, ts: new Date().toISOString(), title: "t", goal: "g",
            steps: [{ id: "s1", text: "x", status: "todo", attempts: 0 }], status: "active" };
        });
      }`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] })
    let err = ""
    child.stderr.on("data", (d) => { err += d })
    child.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`writer ${tag} exit ${c}: ${err.slice(0, 500)}`))))
  })
}

test("two concurrent writers lose no plan and never truncate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-conc-"))
  try {
    const xdg = path.join(dir, "xdg")
    const proj = path.join(dir, "proj")
    await Promise.all([writerChild(xdg, proj, "A"), writerChild(xdg, proj, "B")])
    const root = path.join(xdg, "opencode", "ultracode", "projects")
    const file = path.join(root, fs.readdirSync(root)[0] as string, "context.json")
    const raw = fs.readFileSync(file, "utf8") // не парсится = обрезанный файл = провал
    const store = JSON.parse(raw)
    for (let i = 0; i < 10; i++) {
      assert.ok(store.plans[`A-${i}`], `lost A-${i}`)
      assert.ok(store.plans[`B-${i}`], `lost B-${i}`)
    }
    assert.ok(!fs.readdirSync(path.dirname(file)).some((f) => f.endsWith(".tmp")), "leftover tmp file")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("duplicate claim rejected: step runs once", async () => {
  const rt = await makeRuntime()
  try {
    await rt.callTool({ action: "plan_new", plan: "lab-claim", goal: "c", steps: "job" })
    const first = await rt.callTool({ action: "plan_step", plan: "lab-claim", step: "s1", status: "in_progress" })
    assert.ok(first.includes("in_progress"))
    const second = await rt.callTool({ action: "plan_step", plan: "lab-claim", step: "s1", status: "in_progress" })
    assert.ok(!second.includes("→") || second.includes("in_progress") === false || /already|cannot|остаётся/i.test(second),
      `double claim must fail, got: ${second}`)
  } finally {
    rt.cleanup()
  }
})

test("in_progress and verify_required survive restart", async () => {
  const rt = await makeRuntime()
  try {
    await rt.callTool({ action: "plan_new", plan: "lab-resume", goal: "r", steps: "one\ntwo" })
    await rt.callTool({ action: "plan_step", plan: "lab-resume", step: "s1", status: "in_progress" })
    await rt.callTool({ action: "plan_step", plan: "lab-resume", step: "s2", status: "in_progress" })
    await rt.callTool({ action: "plan_step", plan: "lab-resume", step: "s2", status: "verify_required" })
    const rt2 = await rt.reopen()
    const show = await rt2.callTool({ action: "plan_show", plan: "lab-resume" })
    assert.ok(show.includes("s1") && show.includes("s2"))
    const plan = JSON.parse(rt2.readStoreRaw()).plans["lab-resume"]
    assert.equal(plan.steps[0].status, "in_progress")
    assert.equal(plan.steps[1].status, "verify_required")
  } finally {
    rt.cleanup()
  }
})

test("stale success cannot close a new attempt (runtime path)", async () => {
  const rt = await makeRuntime()
  try {
    await rt.callTool({ action: "plan_new", plan: "lab-stale", goal: "st", steps: "job" })
    // attempt 0: провал — фиксирует попытку.
    await rt.callTool({ action: "plan_step", plan: "lab-stale", step: "s1", status: "in_progress" })
    await rt.callTool({ action: "plan_step", plan: "lab-stale", step: "s1", status: "verify_required" })
    await rt.callTool({ action: "evidence", plan: "lab-stale", stepId: "s1", command: "t", exitCode: 1 })
    // Новая попытка: успеха для неё ещё нет — done обязан быть отклонён (UC-018).
    const started = await rt.callTool({ action: "plan_step", plan: "lab-stale", step: "s1", status: "in_progress" })
    assert.ok(started.includes("in_progress"), started)
    const done = await rt.callTool({ action: "plan_step", plan: "lab-stale", step: "s1", status: "done" })
    assert.ok(!done.includes("→ done"), `closed without evidence for the new attempt: ${done}`)
    // Успех текущей попытки закрывает шаг.
    const ev = await rt.callTool({ action: "evidence", plan: "lab-stale", stepId: "s1", command: "t", exitCode: 0 })
    assert.ok(ev.includes("done"), ev)
    const plan = JSON.parse(rt.readStoreRaw()).plans["lab-stale"]
    assert.equal(plan.steps[0].status, "done")
    assert.equal(plan.steps[0].evidence.length, 2)
  } finally {
    rt.cleanup()
  }
})
