// UC-025 — контракт «работающий проект»: один интерфейс, реализации на стек.
// Unit: таблицы команд честны (нет подтверждения — null). Runtime: экшен contract.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { detectContract } from "../lib/ultracode/stack-contract.ts"
import { makeRuntime } from "./runtime/fixtures.ts"

function mkroot(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-contract-"))
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } } }
}

test("node: full table from scripts", () => {
  const r = mkroot({ "package.json": JSON.stringify({ scripts: { test: "vitest", build: "tsc", lint: "eslint", typecheck: "tsc --noEmit", start: "node dist/i.js" } }) })
  try {
    const c = detectContract(r.dir)
    assert.ok(c)
    assert.equal(c.stack, "node")
    assert.deepEqual(c.commands(), {
      test: "npm test", build: "npm run build", lint: "npm run lint", typecheck: "npm run typecheck", run: "npm start",
    })
  } finally {
    r.cleanup()
  }
})

test("node: dev fallback for run, nulls without evidence", () => {
  const r = mkroot({ "package.json": JSON.stringify({ scripts: { test: "jest", dev: "vite" } }) })
  try {
    const c = detectContract(r.dir)
    assert.ok(c)
    assert.equal(c.test(), "npm test")
    assert.equal(c.build(), null)
    assert.equal(c.lint(), null)
    assert.equal(c.typecheck(), null)
    assert.equal(c.run(), "npm run dev")
  } finally {
    r.cleanup()
  }
})

test("rust: table with honest run=null", () => {
  const r = mkroot({ "Cargo.toml": '[package]\nname="x"\n' })
  try {
    const c = detectContract(r.dir)
    assert.ok(c)
    assert.deepEqual(c.commands(), {
      test: "cargo test", build: "cargo build", lint: "cargo clippy", typecheck: "cargo check", run: null,
    })
  } finally {
    r.cleanup()
  }
})

test("python/php: only test is promised", () => {
  const py = mkroot({ "pyproject.toml": "[project]\n" })
  try {
    const c = detectContract(py.dir)
    assert.ok(c)
    assert.equal(c.test(), "pytest")
    assert.equal(c.build(), null)
    assert.equal(c.lint(), null)
    assert.equal(c.typecheck(), null)
    assert.equal(c.run(), null)
  } finally {
    py.cleanup()
  }
  const php = mkroot({ "composer.json": JSON.stringify({ scripts: { test: "phpunit" } }) })
  try {
    const c = detectContract(php.dir)
    assert.ok(c)
    assert.equal(c.test(), "composer test")
    assert.equal(c.build(), null)
    assert.equal(c.run(), null)
  } finally {
    php.cleanup()
  }
})

test("go: build and vet, no lint/run guesses", () => {
  const r = mkroot({ "go.mod": "module example.com/x\n" })
  try {
    const c = detectContract(r.dir)
    assert.ok(c)
    assert.deepEqual(c.commands(), {
      test: "go test ./...", build: "go build ./...", lint: null, typecheck: "go vet ./...", run: null,
    })
  } finally {
    r.cleanup()
  }
})

test("make entrypoint flows into test()", () => {
  const r = mkroot({ "Cargo.toml": "[package]\n", "Makefile": "test:\n\tcargo test --workspace\n" })
  try {
    const c = detectContract(r.dir)
    assert.ok(c)
    assert.equal(c.test(), "make test")
    assert.equal(c.build(), "cargo build")
    assert.equal(c.dir, "")
  } finally {
    r.cleanup()
  }
})

test("subdir manifest keeps dir", () => {
  const r = mkroot({ "farm/Cargo.toml": "[package]\n" })
  try {
    const c = detectContract(r.dir)
    assert.ok(c)
    assert.equal(c.stack, "rust")
    assert.equal(c.dir, "farm")
    assert.equal(c.test(), "cargo test")
  } finally {
    r.cleanup()
  }
})

test("unknown project and bad paths give null, never throw", () => {
  const r = mkroot({ "README.md": "hi\n" })
  try {
    assert.equal(detectContract(r.dir), null)
  } finally {
    r.cleanup()
  }
  assert.equal(detectContract("/nonexistent-uc-contract-xyz"), null)
})

test("runtime: contract action returns command table", async () => {
  const rt = await makeRuntime()
  try {
    fs.writeFileSync(path.join(rt.project, "package.json"), JSON.stringify({ scripts: { test: "jest", lint: "eslint" } }))
    const out = await rt.callTool({ action: "contract" })
    const parsed = JSON.parse(out)
    assert.equal(parsed.stack, "node")
    assert.equal(parsed.commands.test, "npm test")
    assert.equal(parsed.commands.lint, "npm run lint")
    assert.equal(parsed.commands.run, null)
  } finally {
    rt.cleanup()
  }
})

test("runtime: contract on unknown project is explicit", async () => {
  const rt = await makeRuntime()
  try {
    const out = await rt.callTool({ action: "contract" })
    assert.ok(out.includes("не определён") || out.includes("unknown"), `unexpected: ${out}`)
  } finally {
    rt.cleanup()
  }
})
