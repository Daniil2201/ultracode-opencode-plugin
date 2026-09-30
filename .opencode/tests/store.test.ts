// UC-001 — store v3: миграция, повреждённый JSON, per-project, atomic save.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { freshStore, migrateStore, STORE_VERSION } from "../lib/ultracode/schema.ts"
import { loadStore, projectSlug, saveStore, storeFileFor, withStoreLock } from "../lib/ultracode/store.ts"

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uc001-"))
}

test("version is 3", () => {
  assert.equal(STORE_VERSION, 3)
  assert.equal(freshStore().version, 3)
})

test("v2 loads without data loss", () => {
  const v2 = {
    version: 2,
    knowledge: [{ id: "k1", ts: new Date().toISOString(), kind: "fact", project: "p", text: "hello", tags: ["farm"], status: "open" }],
    plans: {},
    lessons: [{ id: "l1", ts: new Date().toISOString(), kind: "lesson", project: "p", text: "t", tags: ["x"] }],
  }
  const s = migrateStore(v2)
  assert.equal(s.version, 3)
  assert.equal(s.knowledge[0]?.text, "hello")
  assert.deepEqual(s.knowledge[0]?.labels, ["farm"])
  assert.equal(s.lessons[0]?.text, "t")
})

test("corrupted JSON does not break startup", () => {
  const d = tmpdir()
  const f = path.join(d, "context.json")
  fs.writeFileSync(f, "{ broken json [[[", "utf8")
  const s = loadStore(f)
  assert.equal(s.version, 3)
  assert.equal(s.knowledge.length, 0)
})

test("two projects do not see each other memory", () => {
  const root = tmpdir()
  const fa = storeFileFor("/proj/alpha", root)
  const fb = storeFileFor("/proj/beta", root)
  assert.notEqual(fa, fb)
  assert.notEqual(projectSlug("/proj/alpha"), projectSlug("/proj/beta"))
})

test("parallel atomic write leaves no truncated context.json", () => {
  const d = tmpdir()
  const f = path.join(d, "context.json")
  const s = freshStore()
  s.knowledge.push({
    id: "k1", ts: new Date().toISOString(), kind: "fact", project: "p",
    text: "x".repeat(5000), labels: [], status: "open", archived: false,
  })
  saveStore(f, s)
  const raw = fs.readFileSync(f, "utf8")
  assert.ok(raw.endsWith("\n"))
  assert.doesNotThrow(() => JSON.parse(raw))
  const leftovers = fs.readdirSync(d).filter((x) => x.endsWith(".tmp"))
  assert.equal(leftovers.length, 0)
})

test("fn error is not retried as contention: propagates fast with message", () => {
  const d = tmpdir()
  const f = path.join(d, "context.json")
  const started = Date.now()
  assert.throws(() => withStoreLock(f, () => { throw new Error("real-dependency-error") }), /real-dependency-error/)
  assert.ok(Date.now() - started < 2000, "error must not spin until lock timeout")
  assert.ok(!fs.existsSync(`${f}.lock`), "lock released after fn error")
})

test("pickProjectDir skips bare root: run and TUI resolve same cwd", async () => {
  const { pickProjectDir } = await import("../lib/ultracode/store.ts")
  const cwd = process.cwd()
  assert.equal(pickProjectDir(cwd, cwd, cwd), cwd)
  assert.equal(pickProjectDir("/", cwd, cwd), cwd)
  assert.equal(pickProjectDir("/", undefined, cwd), cwd)
  assert.equal(pickProjectDir(undefined, undefined, cwd), cwd)
  assert.equal(projectSlug(pickProjectDir("/", cwd, cwd)), projectSlug(cwd))
})

test("handoff survives restart: write file, fresh load, read", async () => {
  const { buildHandoff, writeHandoff, readHandoff } = await import("../lib/ultracode/handoff.ts")
  const d = tmpdir()
  const f = path.join(d, "context.json")
  saveStore(f, freshStore())
  writeHandoff(f, buildHandoff("ses_abc123", "hard", 60, "summary"), () => {})
  const re = loadStore(f)
  assert.equal(readHandoff(re)?.sessionId, "ses_abc123")
  assert.equal(readHandoff(re)?.reason, "hard")
})
