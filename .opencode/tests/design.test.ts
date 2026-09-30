// UC-009 — дизайн: no context -> blocker, no confirm -> no start_run, path escape rejected.
import { test } from "node:test"
import assert from "node:assert/strict"
import { safeArtifactPath, canStartRun, nextStageAfterContext, blockerNoContext, validateManifest } from "../lib/ultracode/design.ts"

test("files outside project root rejected", () => {
  assert.throws(() => safeArtifactPath("/proj", "../etc/passwd"), /escapes/)
  assert.throws(() => safeArtifactPath("/proj", "/etc/passwd"), /escapes/)
  assert.ok(safeArtifactPath("/proj", "cards/item.html").endsWith("cards/item.html"))
})

test("start_run not called without brief confirmation", () => {
  assert.equal(canStartRun(null), false)
  assert.equal(canStartRun({ goal: "карточка", confirmed: false }), false)
  assert.equal(canStartRun({ goal: "карточка", confirmed: true }), true)
})

test("no active context gives clear blocker", () => {
  assert.equal(nextStageAfterContext(false), "blocked")
  assert.ok(blockerNoContext().includes("start_run не вызван"))
})

test("manifest validated inside root", () => {
  const out = validateManifest("/proj", { files: ["a.html", "css/b.css"] })
  assert.equal(out.length, 2)
  assert.throws(() => validateManifest("/proj", { files: ["ok.html", "../../evil.html"] }), /escapes/)
})
