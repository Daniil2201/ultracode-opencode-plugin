// UC-018: секреты нигде не персистятся — command, stdout, stderr, error
// через НАСТОЯЩИЙ tool path; проверяем сырые байты store-файла.
import { test } from "node:test"
import assert from "node:assert/strict"
import { makeRuntime } from "../runtime/fixtures.ts"

const SECRET = "SECRET-9f8e7d6c5b4a"

test("secret in evidence stdout/stderr is redacted on disk", async () => {
  const rt = await makeRuntime()
  try {
    await rt.callTool({ action: "plan_new", plan: "lab-sec", goal: "sec", steps: "s" })
    await rt.callTool({ action: "plan_step", plan: "lab-sec", step: "s1", status: "in_progress" })
    await rt.callTool({
      action: "evidence", plan: "lab-sec", stepId: "s1",
      command: "node check.mjs", exitCode: 1,
      stdout: `leak api_hash=${SECRET}`,
      stderr: `fail password=${SECRET}`,
    })
    const raw = rt.readStoreRaw()
    assert.ok(!raw.includes(SECRET), "secret bytes persisted to store file")
    assert.ok(raw.includes("[redacted]"))
  } finally {
    rt.cleanup()
  }
})

test("secret in knowledge text is redacted on disk", async () => {
  const rt = await makeRuntime()
  try {
    await rt.callTool({ action: "add", kind: "fact", text: `token report bot_token=${SECRET}` })
    assert.ok(!rt.readStoreRaw().includes(SECRET))
  } finally {
    rt.cleanup()
  }
})
