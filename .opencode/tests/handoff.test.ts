// Фаза 3: writer/reader handoff на изолированном файле (без git — noop-коммит).
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { loadStore } from "../lib/ultracode/store.ts"
import { buildHandoff, writeHandoff, readHandoff } from "../lib/ultracode/handoff.ts"

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-handoff-"))
  return path.join(dir, "proj-x", "context.json")
}

test("write → read → перетирание новой записью", () => {
  const file = tmpFile()
  const commits: string[] = []
  writeHandoff(file, buildHandoff("s1", "hard", 61, "PLAN: p\nreason: hard 61%"), (m) => { commits.push(m) })
  assert.equal(commits.length, 1)
  assert.ok(commits[0].includes("handoff") && commits[0].includes("61%") && commits[0].includes("hard"))
  const back = readHandoff(loadStore(file))
  assert.equal(back?.sessionId, "s1")
  assert.equal(back?.reason, "hard")
  assert.equal(back?.usagePct, 61)
  // старая запись перетирается
  writeHandoff(file, buildHandoff("s2", "emergency", 80, "PLAN: p\nreason: emergency 80%"), () => {})
  const back2 = readHandoff(loadStore(file))
  assert.equal(back2?.sessionId, "s2")
  assert.equal(back2?.reason, "emergency")
})

test("readHandoff: пустой/битый стор → null", () => {
  assert.equal(readHandoff(loadStore(tmpFile())), null)
  assert.equal(readHandoff({} as never), null)
  assert.equal(readHandoff({ handoff: { sessionId: 42 } } as never), null)
})
