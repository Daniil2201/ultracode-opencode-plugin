// UC-017: verify -> evidence -> done через настоящий tool path; evidence персистентно.
import { test } from "node:test"
import assert from "node:assert/strict"
import { makeRuntime } from "./fixtures.ts"

test("evidence exit 0 persists and closes step", async () => {
  const rt = await makeRuntime()
  try {
    await rt.callTool({ action: "plan_new", plan: "lab-ev", goal: "ev", steps: "only step" })
    await rt.callTool({ action: "plan_step", plan: "lab-ev", step: "s1", status: "in_progress" })
    await rt.callTool({ action: "plan_step", plan: "lab-ev", step: "s1", status: "verify_required" })
    const out = await rt.callTool({
      action: "evidence", plan: "lab-ev", stepId: "s1",
      command: "node fixture-pass.mjs", exitCode: 0, stdout: "ok",
    })
    assert.ok(out.includes("done"))
    const plan = JSON.parse(rt.readStoreRaw()).plans["lab-ev"]
    assert.equal(plan.steps[0].status, "done")
    assert.equal(plan.steps[0].evidence[0].exitCode, 0)
    assert.equal(plan.steps[0].evidence[0].command, "node fixture-pass.mjs")
  } finally {
    rt.cleanup()
  }
})

test("evidence exit 1 persists as failed and bumps attempt", async () => {
  const rt = await makeRuntime()
  try {
    await rt.callTool({ action: "plan_new", plan: "lab-ev2", goal: "ev", steps: "only step" })
    await rt.callTool({ action: "plan_step", plan: "lab-ev2", step: "s1", status: "in_progress" })
    await rt.callTool({ action: "plan_step", plan: "lab-ev2", step: "s1", status: "verify_required" })
    const out = await rt.callTool({
      action: "evidence", plan: "lab-ev2", stepId: "s1",
      command: "node fixture-fail.mjs", exitCode: 1, stderr: "boom",
    })
    assert.ok(out.includes("failed"))
    const plan = JSON.parse(rt.readStoreRaw()).plans["lab-ev2"]
    assert.equal(plan.steps[0].status, "failed")
    assert.equal(plan.steps[0].attempts, 1)
  } finally {
    rt.cleanup()
  }
})

test("UC-030: evidence для шага из todo отклоняется и не персистится", async () => {
  const rt = await makeRuntime()
  try {
    await rt.callTool({ action: "plan_new", plan: "lab-ev4", goal: "ev", steps: "only step" })
    const out = await rt.callTool({
      action: "evidence", plan: "lab-ev4", stepId: "s1",
      command: "node fixture-pass.mjs", exitCode: 0, stdout: "ok",
    })
    assert.ok(out.includes("rejected"), `ожидали отказ гейта: ${out}`)
    const plan = JSON.parse(rt.readStoreRaw()).plans["lab-ev4"]
    assert.equal(plan.steps[0].status, "todo")
    assert.equal((plan.steps[0].evidence ?? []).length, 0)
  } finally {
    rt.cleanup()
  }
})

test("UC-030: команда не совпадает с acceptance — evidence отклоняется", async () => {
  const rt = await makeRuntime()
  try {
    await rt.callTool({
      action: "plan_new", plan: "lab-ev5", goal: "ev", steps: "only step",
      acceptanceCommand: "node fixture-pass.mjs",
    })
    await rt.callTool({ action: "plan_step", plan: "lab-ev5", step: "s1", status: "in_progress" })
    const bad = await rt.callTool({ action: "evidence", plan: "lab-ev5", stepId: "s1", command: "echo ok", exitCode: 0 })
    assert.ok(bad.includes("rejected"), `ожидали отказ по команде: ${bad}`)
    const good = await rt.callTool({
      action: "evidence", plan: "lab-ev5", stepId: "s1", command: "node fixture-pass.mjs", exitCode: 0, stdout: "ok",
    })
    assert.ok(good.includes("done"), `ожидали done: ${good}`)
  } finally {
    rt.cleanup()
  }
})

test("failed runtime path is not green: no evidence means no done", async () => {
  const rt = await makeRuntime()
  try {
    await rt.callTool({ action: "plan_new", plan: "lab-ev3", goal: "ev", steps: "only step" })
    const out = await rt.callTool({ action: "plan_step", plan: "lab-ev3", step: "s1", status: "done" })
    assert.ok(!out.includes("→ done"), `must not close without evidence: ${out}`)
  } finally {
    rt.cleanup()
  }
})
