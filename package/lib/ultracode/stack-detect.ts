// UC-023 — автоопределение стека проекта для acceptance по умолчанию.
// Смотрит манифесты в project root (+1 уровень вглубь для монорепо),
// Makefile/justfile target `test`, workflow `run:`-строки.
// Чистые функции + тонкий fs-слой; секреты из workflow режутся до записи.
// Ponytail: stdlib only, капы на чтение, детерминированный порядок.
import * as fs from "node:fs"
import * as path from "node:path"
import { sanitizeOutput } from "./verification.ts"

export type StackKind = "node" | "rust" | "python" | "go" | "php" | "unknown"

export interface StackCandidate {
  stack: Exclude<StackKind, "unknown">
  testCommand: string
  source: string
  dir: string
  note?: string
}

export interface DetectedStack extends StackCandidate {
  others: StackCandidate[]
}

// Приоритет primary-стека при нескольких манифестах в одном каталоге.
const MANIFEST_PRIORITY: Array<Exclude<StackKind, "unknown">> = ["node", "rust", "python", "go", "php"]

const SKIP_DIRS = new Set([
  "node_modules", "target", "dist", "build", ".git", ".venv", "venv",
  "__pycache__", ".opencode", ".github", ".vscode", ".idea", "coverage",
  ".next", ".turbo",
])
const MAX_SUBDIRS = 50
const MAX_WORKFLOWS = 5
const MAX_WF_LINES = 150
const MAX_READ_BYTES = 32768
const MAX_CMD = 200
const MAX_OTHERS = 5

function exists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function readText(p: string): string | null {
  try {
    const st = fs.statSync(p)
    if (!st.isFile() || st.size > MAX_READ_BYTES * 4) return null
    return fs.readFileSync(p, "utf8").slice(0, MAX_READ_BYTES)
  } catch {
    return null
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function scriptOf(pkg: Record<string, unknown>, name: string): string | null {
  const scripts = pkg["scripts"]
  if (!scripts || typeof scripts !== "object") return null
  const v = (scripts as Record<string, unknown>)[name]
  return typeof v === "string" && v.trim() ? v.trim() : null
}

// UC-025: все string-скрипты манифеста для contract-слоя ({} при любой проблеме).
export function readScripts(dir: string, file: string): Record<string, string> {
  const out: Record<string, string> = {}
  const parsed = parseJson(readText(path.join(dir, file)) ?? "")
  const scripts = parsed?.["scripts"]
  if (!scripts || typeof scripts !== "object") return out
  for (const [k, v] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim()
  }
  return out
}

function src(rel: string, f: string): string {
  return rel ? `${rel}/${f}` : f
}

// Точный target `test:` (не test-foo). Команда запускается из project root.
function makeTarget(dir: string, rel: string, file: "Makefile" | "justfile"): string | null {
  const text = readText(path.join(dir, file))
  if (!text) return null
  if (!/^test\s*:(?!=)/m.test(text)) return null
  const bin = file === "Makefile" ? "make" : "just"
  return rel ? `${bin} -C ${rel} test` : `${bin} test`
}

// Первая test-похожая run-строка из workflows (отсортировано = детерминировано).
function workflowCommand(root: string): string | null {
  let dir: string
  try {
    dir = path.join(root, ".github", "workflows")
    if (!fs.statSync(dir).isDirectory()) return null
  } catch {
    return null
  }
  let files: string[]
  try {
    files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .sort()
      .slice(0, MAX_WORKFLOWS)
  } catch {
    return null
  }
  const testRe = /test|pytest|phpunit|jest|vitest|go test|cargo test/i
  const fallbackRe = /clippy|tsc --noEmit|tsc\b|lint|build/i
  let fallback: string | null = null
  for (const f of files) {
    const text = readText(path.join(dir, f))
    if (!text) continue
    for (const line of text.split("\n").slice(0, MAX_WF_LINES)) {
      const m = /^\s*(?:-\s*)?run:\s*(.+?)\s*$/.exec(line)
      if (!m) continue
      const cmd = sanitizeOutput(m[1]).slice(0, MAX_CMD)
      if (!cmd || /[|&;]/.test(cmd)) continue
      if (testRe.test(cmd)) return cmd
      if (!fallback && fallbackRe.test(cmd)) fallback = cmd
    }
  }
  return fallback
}

function manifestsAt(dir: string, rel: string): StackCandidate[] {
  const cands: StackCandidate[] = []
  // Явный scripts.test в манифесте — авторитетная команда; иначе дефолт стека.
  const scripted = (
    file: string,
    stack: Exclude<StackKind, "unknown">,
    testCommand: string,
  ): void => {
    const parsed = parseJson(readText(path.join(dir, file)) ?? "")
    if (!parsed) return
    const base = src(rel, file)
    cands.push(scriptOf(parsed, "test")
      ? { stack, testCommand, source: `${base}:scripts.test`, dir: rel }
      : { stack, testCommand, source: base, dir: rel, note: "scripts.test missing — confirm" })
  }
  scripted("package.json", "node", "npm test")
  scripted("composer.json", "php", "composer test")
  if (exists(path.join(dir, "Cargo.toml"))) {
    cands.push({ stack: "rust", testCommand: "cargo test", source: src(rel, "Cargo.toml"), dir: rel })
  }
  if (exists(path.join(dir, "pyproject.toml"))) {
    cands.push({ stack: "python", testCommand: "pytest", source: src(rel, "pyproject.toml"), dir: rel })
  }
  if (exists(path.join(dir, "go.mod"))) {
    cands.push({ stack: "go", testCommand: "go test ./...", source: src(rel, "go.mod"), dir: rel })
  }
  return cands
}

// Команда с учётом project-specific entrypoints:
// package.json scripts.test > Makefile test > justfile test > workflow > default манифеста.
function resolveCommand(root: string, dir: string, rel: string, m: StackCandidate): StackCandidate {
  if (/:scripts\.test$/.test(m.source)) return m
  const make = makeTarget(dir, rel, "Makefile")
  if (make) return { ...m, testCommand: make, source: rel ? `${rel}/Makefile:test` : "Makefile:test" }
  const just = makeTarget(dir, rel, "justfile")
  if (just) return { ...m, testCommand: just, source: rel ? `${rel}/justfile:test` : "justfile:test" }
  if (!rel) {
    const wf = workflowCommand(root)
    if (wf) return { ...m, testCommand: wf, source: ".github/workflows" }
  }
  return m
}

function subdirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP_DIRS.has(d.name))
      .map((d) => d.name)
      .sort()
      .slice(0, MAX_SUBDIRS)
  } catch {
    return []
  }
}

// Детект стека. null = манифестов нет, acceptance остаётся ручным (не выдумываем).
// Никогда не бросает: битые файлы и недоступные пути дают пропуск кандидата.
export function detectStack(projectRoot: string): DetectedStack | null {
  let root: string
  try {
    root = path.resolve(projectRoot)
    if (!fs.statSync(root).isDirectory()) return null
  } catch {
    return null
  }
  const found: StackCandidate[] = []
  const collect = (dir: string, rel: string): void => {
    for (const c of manifestsAt(dir, rel)) found.push(resolveCommand(root, dir, rel, c))
  }
  collect(root, "")
  for (const sub of subdirs(root)) collect(path.join(root, sub), sub)
  if (found.length === 0) return null
  const rank = (c: StackCandidate): number => {
    const mi = MANIFEST_PRIORITY.indexOf(c.stack)
    // Root-каталог важнее субдира при равном стеке.
    return mi * 10 + (c.dir ? 1 : 0)
  }
  const sorted = [...found].sort((a, b) => rank(a) - rank(b))
  const [primary, ...rest] = sorted
  const { note, ...base } = primary
  const out: DetectedStack = { ...base, others: rest.slice(0, MAX_OTHERS) }
  if (note) out.note = note
  return out
}
