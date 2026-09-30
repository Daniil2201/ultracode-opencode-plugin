// UC-017: plan_new через настоящий tool path — acceptance и зависимости сохраняются.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import { makeRuntime, toolSchema } from "./fixtures.ts"

test("runtime schema accepts documented fields", async () => {
  const s = await toolSchema()
  for (const a of ["plan_new", "plan_show", "plan_step", "evidence", "evaluate", "contract"]) {
    assert.ok(s.actions.includes(a), `action ${a} missing in runtime schema`)
  }
  // UC-017 case 3: verify_required принимается schema инструмента.
  assert.ok(s.statuses.includes("verify_required"), "verify_required missing in status enum")
})

test("plan_new persists acceptance command and dependencies", async () => {
  const rt = await makeRuntime()
  try {
    const out = await rt.callTool({
      action: "plan_new",
      plan: "lab-goal",
      goal: "fixture goal",
      steps: "first step\nsecond step",
      acceptanceCommand: "node fixture-pass.mjs",
      dependsOn: JSON.stringify({ s2: ["s1"] }),
    })
    assert.ok(out.includes("lab-goal"))
    const raw = rt.readStoreRaw()
    const store = JSON.parse(raw)
    const plan = store.plans["lab-goal"]
    assert.ok(plan, "plan persisted to store file")
    assert.equal(plan.acceptance.command, "node fixture-pass.mjs")
    assert.deepEqual(plan.steps[1].dependsOn, ["s1"])
    assert.equal(plan.goal, "fixture goal")
  } finally {
    rt.cleanup()
  }
})

test("goal -> task -> plan_step: dependent waits, independent runs", async () => {
  const rt = await makeRuntime()
  try {
    await rt.callTool({
      action: "plan_new", plan: "lab-flow", goal: "flow",
      steps: "step one\nstep two", dependsOn: JSON.stringify({ s2: ["s1"] }),
    })
    // s2 до s1 — ошибка зависимости через настоящий path
    const blocked = await rt.callTool({ action: "plan_step", plan: "lab-flow", step: "s2", status: "in_progress" })
    assert.ok(blocked.includes("dependencies") || blocked.includes("зависимост"), `unexpected: ${blocked}`)
    const started = await rt.callTool({ action: "plan_step", plan: "lab-flow", step: "s1", status: "in_progress" })
    assert.ok(started.includes("in_progress"))
  } finally {
    rt.cleanup()
  }
})

// UC-023: дефолт acceptance из детекта стека — только когда явной команды нет.
async function seedStack(rt: {
  storeFile: () => string
  readStoreRaw: () => string
  callTool: (args: Record<string, unknown>) => Promise<string>
}): Promise<void> {
  // priming: store-файл появляется только на первой записи
  await rt.callTool({ action: "plan_new", plan: "lab-seed", goal: "seed", steps: "s" })
  const file = rt.storeFile()
  const store = JSON.parse(rt.readStoreRaw())
  store.stack = { stack: "rust", testCommand: "cargo test -p mcp", source: "farm/Cargo.toml", dir: "farm", others: [] }
  fs.writeFileSync(file, JSON.stringify(store))
}

test("plan_new defaults acceptance from detected stack", async () => {
  const rt = await makeRuntime()
  try {
    await seedStack(rt)
    const out = await rt.callTool({ action: "plan_new", plan: "lab-def", goal: "def", steps: "only step" })
    const plan = JSON.parse(rt.readStoreRaw()).plans["lab-def"]
    assert.equal(plan.acceptance.command, "cargo test -p mcp")
    assert.ok(out.includes("auto: farm/Cargo.toml"), `missing auto note: ${out}`)
  } finally {
    rt.cleanup()
  }
})

test("explicit acceptanceCommand beats stack default", async () => {
  const rt = await makeRuntime()
  try {
    await seedStack(rt)
    const out = await rt.callTool({
      action: "plan_new", plan: "lab-exp", goal: "exp", steps: "only step",
      acceptanceCommand: "make test",
    })
    const plan = JSON.parse(rt.readStoreRaw()).plans["lab-exp"]
    assert.equal(plan.acceptance.command, "make test")
    assert.ok(!out.includes("auto:"), `unexpected auto note: ${out}`)
  } finally {
    rt.cleanup()
  }
})

// UC-036: чек цели на настоящем tool-path. Сид — дрейф стора: s1 done с evidence
// прошлой попытки (attempt 0 при attempts 1), s2 ждёт закрытия.
async function seedDriftedPlan(rt: {
  readStoreRaw: () => string
  storeFile: () => string
  callTool: (args: Record<string, unknown>) => Promise<string>
}, planId: string, s2: Record<string, unknown>): Promise<void> {
  await rt.callTool({ action: "plan_new", plan: planId, goal: "drift goal", steps: "one\ntwo" })
  const file = rt.storeFile()
  const store = JSON.parse(rt.readStoreRaw())
  const p = store.plans[planId]
  p.steps[0] = {
    id: "s1", text: "one", status: "done", attempts: 1,
    evidence: [{ command: "node --test", exitCode: 0, ts: "2026-01-01T00:00:00.000Z", attempt: 0 }],
  }
  p.steps[1] = { id: "s2", text: "two", attempts: 0, ...s2 }
  p.status = "active"
  fs.writeFileSync(file, JSON.stringify(store))
}

test("UC-036: evidence закрывает шаг, но гейт цели ставит gf и не закрывает план", async () => {
  const rt = await makeRuntime()
  try {
    await seedDriftedPlan(rt, "lab-gate", { status: "verify_required" })
    const out = await rt.callTool({
      action: "evidence", plan: "lab-gate", stepId: "s2",
      command: "node --test", exitCode: 0, stdout: "ok",
    })
    assert.ok(out.includes("GOAL_FAIL"), `нет признака GOAL_FAIL в ответе: ${out}`)
    const plan = JSON.parse(rt.readStoreRaw()).plans["lab-gate"]
    assert.equal(plan.steps[1].status, "done")
    const gf = plan.steps.find((s: { id: string }) => s.id === "gf")
    assert.ok(gf, "шаг gf добавлен в context.json")
    assert.equal(gf.status, "todo")
    assert.notEqual(plan.status, "done", "план не помечен выполненным")
  } finally {
    rt.cleanup()
  }
})

test("UC-036: plan_step done при валидном evidence — gf есть, записи «завершён» нет", async () => {
  const rt = await makeRuntime()
  try {
    await seedDriftedPlan(rt, "lab-gate2", {
      status: "verify_required",
      evidence: [{ command: "node --test", exitCode: 0, ts: "2026-01-01T00:00:00.000Z", attempt: 0 }],
    })
    const out = await rt.callTool({ action: "plan_step", plan: "lab-gate2", step: "s2", status: "done" })
    assert.ok(out.includes("done"), `шаг не закрыт: ${out}`)
    const store = JSON.parse(rt.readStoreRaw())
    const plan = store.plans["lab-gate2"]
    assert.notEqual(plan.status, "done", "план не помечен выполненным")
    assert.ok(plan.steps.some((s: { id: string }) => s.id === "gf"), "шаг gf добавлен")
    const done = store.knowledge.filter((k: { text: string }) => k.text.includes("завершён"))
    assert.equal(done.length, 0, `ложная запись о завершении: ${JSON.stringify(done)}`)
    // Регресс на plugin:1516 — вердикт чека, а не зелёные шаги: ложь пишется blocker-записью.
    const notClosed = store.knowledge.filter(
      (k: { kind: string; text: string }) => k.kind === "blocker" && k.text.includes("не закрыт"),
    )
    assert.equal(notClosed.length, 1, `нет записи «не закрыт»: ${JSON.stringify(store.knowledge.map((k: {text: string}) => k.text))}`)
    assert.ok(notClosed[0].text.includes("s1"), notClosed[0].text)
  } finally {
    rt.cleanup()
  }
})
