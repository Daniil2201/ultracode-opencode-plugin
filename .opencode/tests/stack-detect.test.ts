// UC-023 — stack-detect: манифесты, приоритеты, фолбэки, edge cases.
// Изолированные tmp-каталоги, детерминировано, без сети и секретов.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { detectStack } from "../lib/ultracode/stack-detect.ts"

function mkroot(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-stack-"))
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } } }
}

test("node: scripts.test wins", () => {
  const r = mkroot({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) })
  try {
    const st = detectStack(r.dir)
    assert.ok(st)
    assert.equal(st.stack, "node")
    assert.equal(st.testCommand, "npm test")
    assert.equal(st.source, "package.json:scripts.test")
    assert.equal(st.dir, "")
  } finally {
    r.cleanup()
  }
})

test("node without scripts.test: default + note", () => {
  const r = mkroot({ "package.json": JSON.stringify({ name: "x" }) })
  try {
    const st = detectStack(r.dir)
    assert.ok(st)
    assert.equal(st.testCommand, "npm test")
    assert.match(st.note ?? "", /scripts\.test/)
  } finally {
    r.cleanup()
  }
})

test("rust / python / go / php defaults", () => {
  const cases: Array<[string, string, string]> = [
    ["Cargo.toml", "rust", "cargo test"],
    ["pyproject.toml", "python", "pytest"],
    ["go.mod", "go", "go test ./..."],
  ]
  for (const [file, stack, cmd] of cases) {
    const r = mkroot({ [file]: file === "go.mod" ? "module example.com/x\n\ngo 1.21\n" : "[pkg]\n" })
    try {
      const st = detectStack(r.dir)
      assert.ok(st, file)
      assert.equal(st.stack, stack)
      assert.equal(st.testCommand, cmd)
      assert.equal(st.source, file)
    } finally {
      r.cleanup()
    }
  }
  const php = mkroot({ "composer.json": JSON.stringify({ scripts: { test: "phpunit" } }) })
  try {
    const st = detectStack(php.dir)
    assert.ok(st)
    assert.equal(st.stack, "php")
    assert.equal(st.source, "composer.json:scripts.test")
  } finally {
    php.cleanup()
  }
})

test("Makefile test beats manifest default", () => {
  const r = mkroot({ "Cargo.toml": "[pkg]\n", "Makefile": "test:\n\tcargo test --workspace\n" })
  try {
    const st = detectStack(r.dir)
    assert.ok(st)
    assert.equal(st.testCommand, "make test")
    assert.equal(st.source, "Makefile:test")
  } finally {
    r.cleanup()
  }
})

test("justfile used when no Makefile test", () => {
  const r = mkroot({ "Cargo.toml": "[pkg]\n", "justfile": "test:\n  cargo nextest run\n" })
  try {
    const st = detectStack(r.dir)
    assert.ok(st)
    assert.equal(st.testCommand, "just test")
  } finally {
    r.cleanup()
  }
})

test("Makefile without test target falls through", () => {
  const r = mkroot({ "Cargo.toml": "[pkg]\n", "Makefile": "build:\n\tcargo build\n" })
  try {
    const st = detectStack(r.dir)
    assert.ok(st)
    assert.equal(st.testCommand, "cargo test")
  } finally {
    r.cleanup()
  }
})

test("subdir manifest tracked with dir", () => {
  const r = mkroot({ "farm/Cargo.toml": "[pkg]\n" })
  try {
    const st = detectStack(r.dir)
    assert.ok(st)
    assert.equal(st.stack, "rust")
    assert.equal(st.dir, "farm")
    assert.equal(st.source, "farm/Cargo.toml")
  } finally {
    r.cleanup()
  }
})

test("priority: package.json beats Cargo.toml, other recorded", () => {
  const r = mkroot({
    "package.json": JSON.stringify({ scripts: { test: "jest" } }),
    "Cargo.toml": "[pkg]\n",
  })
  try {
    const st = detectStack(r.dir)
    assert.ok(st)
    assert.equal(st.stack, "node")
    assert.ok(st.others.some((o) => o.stack === "rust"))
  } finally {
    r.cleanup()
  }
})

test("empty dir and bad paths give null, never throw", () => {
  const empty = mkroot({})
  try {
    assert.equal(detectStack(empty.dir), null)
  } finally {
    empty.cleanup()
  }
  assert.equal(detectStack("/nonexistent-uc-stack-xyz"), null)
  const f = mkroot({ "a.txt": "x" })
  try {
    assert.equal(detectStack(path.join(f.dir, "a.txt")), null)
  } finally {
    f.cleanup()
  }
})

test("broken package.json skipped, next manifest wins", () => {
  const r = mkroot({ "package.json": "{oops", "Cargo.toml": "[pkg]\n" })
  try {
    const st = detectStack(r.dir)
    assert.ok(st)
    assert.equal(st.stack, "rust")
  } finally {
    r.cleanup()
  }
})

test("workflow run line used when nothing better", () => {
  const r = mkroot({
    "Cargo.toml": "[pkg]\n",
    ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - run: cargo test --workspace\n",
  })
  try {
    const st = detectStack(r.dir)
    assert.ok(st)
    assert.equal(st.testCommand, "cargo test --workspace")
    assert.equal(st.source, ".github/workflows")
  } finally {
    r.cleanup()
  }
})

test("workflow without test line falls back, shell metachars skipped", () => {
  const r = mkroot({
    "Cargo.toml": "[pkg]\n",
    ".github/workflows/ci.yml": "steps:\n  - run: cargo test --all | tee out\n  - run: cargo build\n",
  })
  try {
    const st = detectStack(r.dir)
    assert.ok(st)
    // строка с pipe пропущена, взят fallback build
    assert.equal(st.testCommand, "cargo build")
  } finally {
    r.cleanup()
  }
})

test(".opencode and node_modules manifests ignored", () => {
  const r = mkroot({
    ".opencode/package.json": JSON.stringify({ dependencies: {} }),
    "node_modules/foo/package.json": JSON.stringify({ scripts: { test: "x" } }),
  })
  try {
    assert.equal(detectStack(r.dir), null)
  } finally {
    r.cleanup()
  }
})

test("empty scripts.test treated as missing", () => {
  const r = mkroot({ "package.json": JSON.stringify({ scripts: { test: "  " } }) })
  try {
    const st = detectStack(r.dir)
    assert.ok(st)
    assert.match(st.note ?? "", /scripts\.test/)
  } finally {
    r.cleanup()
  }
})
