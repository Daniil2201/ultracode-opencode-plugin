// UC-029 — Sentinel: advisory pre-check перед evidence. Ничего не пишет, не блокирует.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { sentinelCheck } from "../lib/ultracode/sentinel.ts"
import type { SentinelResult } from "../lib/ultracode/sentinel.ts"
import type { Evidence, PlanStep } from "../lib/ultracode/schema.ts"

const repos: string[] = []

function tmpRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uc-sentinel-")))
  spawnSync("git", ["init", "-q"], { cwd: dir, shell: false })
  repos.push(dir)
  return dir
}

function step(over: Partial<PlanStep> = {}): PlanStep {
  return { id: "s1", text: "починить lib/x.ts", status: "verify_required", check: "node --test x.ts", ...over }
}

function ev(over: Partial<Evidence> = {}): Evidence {
  return { command: "node --test x.ts", exitCode: 0, stdout: "", stderr: "", ts: new Date().toISOString(), ...over }
}

function byId(r: SentinelResult, id: string) {
  const c = r.checks.find((c) => c.id === id)
  assert.ok(c, `нет чека ${id} в [${r.checks.map((c) => c.id).join(",")}]`)
  return c
}

function write(dir: string, rel: string, body: string): void {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body, "utf8")
}

process.on("exit", () => {
  for (const d of repos) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

test("PHP Parse error в evidence → syntax fail", () => {
  const r = sentinelCheck(step({ evidence: [ev({ stdout: "PHP Parse error: syntax error, unexpected token \";\"" })] }), tmpRepo())
  assert.equal(byId(r, "syntax").status, "fail")
  assert.equal(r.status, "fail")
})

test("ошибка компиляции TS распознаётся в stderr", () => {
  const r = sentinelCheck(step({ evidence: [ev({ exitCode: 0, stderr: "src/a.ts(3,5): error TS2304: Cannot find name" })] }), tmpRepo())
  assert.equal(byId(r, "syntax").status, "fail")
})

test("пустой шаг → empty-step fail", () => {
  const r = sentinelCheck(step({ text: "", check: undefined, evidence: [] }), tmpRepo())
  assert.equal(byId(r, "empty-step").status, "fail")
})

test("шаг без acceptance/check/файлов/evidence → empty-step fail", () => {
  const r = sentinelCheck(step({ text: "починить", check: undefined, evidence: [] }), tmpRepo())
  assert.equal(byId(r, "empty-step").status, "fail")
})

test("чистый git и объявленные файлы → task-to-file fail «ничего не изменено»", () => {
  const r = sentinelCheck(step({ evidence: [ev()] }), tmpRepo())
  const c = byId(r, "task-to-file")
  assert.equal(c.status, "fail")
  assert.match(c.detail, /ничего не изменено/)
})

test("изменён файл вне шага → task-to-file warn, не fail", () => {
  const dir = tmpRepo()
  write(dir, "other.ts", "export const a = 1\n")
  const r = sentinelCheck(step({ evidence: [ev()] }), dir)
  assert.equal(byId(r, "task-to-file").status, "warn")
  assert.equal(r.status, "warn")
})

test("изменён только объявленный файл → task-to-file pass", () => {
  const dir = tmpRepo()
  write(dir, "lib/x.ts", "export const a = 1\n")
  const r = sentinelCheck(step({ evidence: [ev()] }), dir)
  assert.equal(byId(r, "task-to-file").status, "pass")
})

test("TODO в файле шага → ghost-comments fail", () => {
  const dir = tmpRepo()
  write(dir, "lib/x.ts", "export const a = 1\n// TODO: дописать\n")
  const r = sentinelCheck(step({ evidence: [ev()] }), dir)
  assert.equal(byId(r, "ghost-comments").status, "fail")
  assert.equal(r.status, "fail")
})

test("закомментированный код (3+ строк) → ghost-comments warn", () => {
  const dir = tmpRepo()
  write(dir, "lib/x.ts", "export const a = 1\n// const b = 2;\n// const c = 3;\n// return b + c;\nexport const d = 4\n")
  const r = sentinelCheck(step({ evidence: [ev()] }), dir)
  assert.equal(byId(r, "ghost-comments").status, "warn")
})

test("CHANGELOG.md без [Unreleased] → changelog fail", () => {
  const dir = tmpRepo()
  write(dir, "lib/x.ts", "export const a = 1\n")
  write(dir, "CHANGELOG.md", "# Changelog\n\n## 1.0.0\n\n- Added: что-то\n")
  const r = sentinelCheck(step({ text: "починить lib/x.ts и CHANGELOG.md", evidence: [ev()] }), dir)
  assert.equal(byId(r, "changelog").status, "fail")
})

test("CHANGELOG.md с [Unreleased] и категорией → changelog pass", () => {
  const dir = tmpRepo()
  write(dir, "lib/x.ts", "export const a = 1\n")
  write(dir, "CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n- Fixed: починили lib/x.ts\n")
  const r = sentinelCheck(step({ text: "починить lib/x.ts и CHANGELOG.md", evidence: [ev()] }), dir)
  assert.equal(byId(r, "changelog").status, "pass")
})

test("нет CHANGELOG.md → changelog skip, и skip не ухудшает status", () => {
  const dir = tmpRepo()
  write(dir, "lib/x.ts", "export const a = 1\n")
  const r = sentinelCheck(step({ evidence: [ev()] }), dir)
  assert.equal(byId(r, "changelog").status, "skip")
  assert.equal(byId(r, "ghost-comments").status, "pass")
  assert.equal(r.status, "pass", `ожидали pass, а детали: ${JSON.stringify(r.checks)}`)
})

test("вне git-репозитория task-to-file = skip", () => {
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uc-sentinel-plain-")))
  repos.push(plain)
  write(plain, "lib/x.ts", "export const a = 1\n")
  const r = sentinelCheck(step({ evidence: [ev()] }), plain)
  assert.equal(byId(r, "task-to-file").status, "skip")
})

test("evidence отсутствует → syntax skip", () => {
  const r = sentinelCheck(step(), tmpRepo())
  assert.equal(byId(r, "syntax").status, "skip")
})

test("acceptance с ненулевым exit → syntax fail", () => {
  const r = sentinelCheck(step({ evidence: [ev({ exitCode: 1, stdout: "1 test failed" })] }), tmpRepo())
  assert.equal(byId(r, "syntax").status, "fail")
})

test("ничего не пишет на диск", () => {
  const dir = tmpRepo()
  write(dir, "lib/x.ts", "export const a = 1\n")
  const snap = () => spawnSync("find", [dir, "-type", "f"], { encoding: "utf8", shell: false }).stdout
  const before = snap()
  sentinelCheck(step({ evidence: [ev()] }), dir)
  assert.equal(snap(), before, "sentinel создал/удалил файлы")
})

test("spawn только 'git status --porcelain' с shell:false", () => {
  const calls: Array<[string, string[], unknown]> = []
  const fake = ((cmd: string, args: string[], opts: { shell?: boolean }) => {
    calls.push([cmd, args, opts?.shell])
    return { status: 0, stdout: "" }
  }) as unknown as typeof spawnSync
  sentinelCheck(step({ evidence: [ev()] }), os.tmpdir(), fake)
  assert.equal(calls.length, 1, `ожидали 1 вызов, получили ${calls.length}`)
  assert.deepEqual(calls[0], ["git", ["status", "--porcelain"], false])
})

test("быстрый вызов: durationMs < 2000", () => {
  const dir = tmpRepo()
  write(dir, "lib/x.ts", "export const a = 1\n")
  const r = sentinelCheck(step({ evidence: [ev()] }), dir)
  assert.ok(r.durationMs < 2000, `медленно: ${r.durationMs} мс`)
  assert.ok(r.durationMs >= 0)
})

test("детали не длиннее 200 символов", () => {
  const dir = tmpRepo()
  write(dir, "lib/x.ts", `// TODO: ${"x".repeat(500)}\n`)
  const r = sentinelCheck(step({ evidence: [ev()] }), dir)
  for (const c of r.checks) assert.ok(c.detail.length <= 201, `${c.id}: ${c.detail.length} символов`)
})
