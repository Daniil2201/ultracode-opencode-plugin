import { test } from "node:test"
import assert from "node:assert/strict"
import guardrails, { blockedRule, commandFromInput } from "../plugin/guardrails.ts"

test("guardrails v2 registers execute.before and blocks destructive bash", async () => {
  let hook: ((event: any) => Promise<void> | void) | undefined
  await guardrails.setup({
    tool: {
      hook: async (name: string, callback: (event: any) => Promise<void> | void) => {
        assert.equal(name, "execute.before")
        hook = callback
        return { dispose: async () => {} }
      },
    },
  } as any)

  assert.ok(hook)
  await hook!({ tool: "bash", input: { command: "npm test" } })
  await assert.rejects(
    async () => hook!({ tool: "bash", input: { command: "rm -rf /" } }),
    /Blocked command \(recursive rm of system path\)/,
  )
})

test("guardrails ignores non-shell tools and accepts common command fields", async () => {
  assert.equal(commandFromInput({ cmd: "git status" }), "git status")
  assert.equal(commandFromInput({ script: "npm test" }), "npm test")
  assert.equal(commandFromInput({ nope: true }), undefined)
  assert.equal(blockedRule("git status"), undefined)
  assert.equal(blockedRule("terraform destroy")?.name, "infrastructure destroy")
})
