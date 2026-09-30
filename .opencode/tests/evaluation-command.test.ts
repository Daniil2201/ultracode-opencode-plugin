// UC-020 — команда /evaluate: скрипт, доки, wiring; тяжёлая матрица — в самом скрипте.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

const REPO = path.resolve(import.meta.dirname, "..", "..")
const SCRIPT = path.join(REPO, "scripts", "evaluate-ultracode.sh")
const CMD = path.join(REPO, ".opencode", "commands", "evaluate.md")

test("evaluate command doc exists and defines gates", () => {
  const doc = fs.readFileSync(CMD, "utf8")
  for (const must of ["/evaluate", "--smoke", "--all", "junior", "senior", "non-zero", "eval-last"]) {
    assert.ok(doc.includes(must), `evaluate.md missing ${must}`)
  }
})

test("script is executable, allowlisted and syntax-clean", () => {
  assert.ok(fs.existsSync(SCRIPT))
  assert.ok((fs.statSync(SCRIPT).mode & 0o111) !== 0, "must be executable")
  const src = fs.readFileSync(SCRIPT, "utf8")
  assert.ok(src.includes("set -euo pipefail"))
  assert.ok(src.includes("--smoke") && src.includes("--all"))
  assert.ok(!src.includes("curl") && !src.includes("rm -rf"), "no network/destructive ops")
  const syntax = spawnSync("bash", ["-n", SCRIPT])
  assert.equal(syntax.status, 0)
})

test("script --help is fast and green", () => {
  const r = spawnSync("bash", [SCRIPT, "--help"], { encoding: "utf8", timeout: 15_000 })
  assert.equal(r.status, 0)
  assert.ok(String(r.stdout).includes("--smoke"))
})

test("plugin evaluate action routes to the allowlisted script", async () => {
  const mod = await import(`../plugin/ultracode.ts?evalw=${Date.now().toString(36)}`)
  const hooks = await mod.default({ worktree: "/tmp", project: { id: "/tmp" } })
  const src = fs.readFileSync(path.join(REPO, ".opencode", "plugin", "ultracode.ts"), "utf8")
  assert.ok(src.includes("evaluate-ultracode.sh"), "plugin must shell only the allowlisted script")
  void hooks
})
