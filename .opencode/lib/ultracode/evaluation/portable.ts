// UC-026 — portable evaluation чужих проектов: матрица поверх stack-contract.
// В отличие от lab-матрицы (гейты my-manager), здесь гейты выводятся из
// контракта target: test/build/lint/typecheck или null. Честность прежде всего:
// нет рантайма → blocked, нет тестов → no-tests (N/A), нет команд → skipped.
// Скоринг только по применимым гейтам; portable-score НЕ сравним с lab-score
// (другая рубрика) — это написано и в отчёте.
// Read-only по target: только запуск команд контракта, без install и записей.
// Ponytail: stdlib only, exec инжектится (тесты), тотальность (не бросает).
import * as fs from "node:fs"
import * as path from "node:path"
import { execSafe } from "./lab-runner.ts"
import { detectContract } from "../stack-contract.ts"
import type { StackContract } from "../stack-contract.ts"
import { clipOutput, parseTestOutput, sanitizeOutput, summarizeEvidence } from "../verification.ts"
import type { TestFailure } from "../schema.ts"

export type PortableOutcome = "pass" | "fail" | "blocked" | "no-tests" | "skipped"
export type PortableVerdict = "pass" | "fail" | "inconclusive"
export type PortableLevel = "junior" | "middle" | "senior" | "staff" | "inconclusive"

export interface PortableExecResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export type PortableExec = (cmd: string, cwd: string, timeoutMs: number) => PortableExecResult

export interface PortableGate {
  name: string
  command: string | null
  outcome: PortableOutcome
  exitCode: number | null
  durationMs: number
  note: string
  output?: string
  // Диагностические гейты (preflight/stack) в скоринг не входят — только команды.
  scored?: boolean
  // UC-027: counts и классифицированные падения (только test-гейт).
  tests?: { passed: number; failed: number }
  failures?: TestFailure[]
  // UC-027: хвост вывода при провале (clip+redact), failures summary вместо head.
  failureTail?: string
}

export interface PortableGateResult extends PortableGate {}

// UC-029: веса гейтов (тесты доказывают поведение — вес выше) и калибровка
// штрафа за взвешенные падения: env-провал в сьюте ~600 стоит ~1 балл,
// code-дефект там же ~3.2 балла.
export const GATE_WEIGHTS: Record<string, number> = { test: 3, build: 2, typecheck: 1, lint: 1 }
export const FAILURE_IMPACT = 20

function gateWeight(name: string): number {
  return GATE_WEIGHTS[name] ?? 1
}

export interface PortableStack {
  stack: string
  dir: string
  source: string
  commands: Record<string, string | null>
}

export interface PortableReport {
  mode: "portable"
  target: string
  stack: PortableStack | null
  preflight: Record<string, boolean>
  gates: PortableGate[]
  score: number | null
  level: PortableLevel
  verdict: PortableVerdict
  timestamp: string
  durationMs: number
}

export const PORTABLE_GATE_TIMEOUT_MS = 180_000
const PORTABLE_OUTPUT_MAX = 2000

const PREFLIGHT_BINS: Record<string, string[]> = {
  node: ["node", "npm"],
  rust: ["cargo"],
  python: ["python3"],
  php: ["php", "composer"],
  go: ["go"],
}
const ALL_BINS = ["node", "npm", "cargo", "python3", "php", "composer", "go", "make"]

// Источники test-команды, которым можно доверять измерение: явный entrypoint
// (scripts.test, Makefile/justfile, CI) либо голый манифест там, где команда
// универсальна (cargo/go/pytest работают без доп. конфигурации).
// Голые package.json/composer.json без scripts.test НЕ запускаем:
// их дефолт упал бы с npm ERR!/Command not defined — это FP, а не fail.
const VERIFIED_SRC = /:scripts\.test$|(?:Makefile|justfile):test$|workflows$/
const MANIFEST_VERIFIED: Record<string, string> = {
  rust: "Cargo.toml",
  go: "go.mod",
  python: "pyproject.toml",
}

function isVerifiedTest(stack: string, source: string): boolean {
  if (VERIFIED_SRC.test(source)) return true
  const mf = MANIFEST_VERIFIED[stack]
  return mf !== undefined && source.endsWith(mf)
}

const NO_TESTS_RE = /no tests (ran|found|executed|collected)/i

const defaultExec: PortableExec = (cmd, cwd, timeoutMs) => {
  const r = execSafe(cmd, cwd, timeoutMs)
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
}

function argv0(cmd: string): string {
  for (const tok of cmd.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue
    return tok
  }
  return ""
}

function binPresent(exec: PortableExec, bin: string, cwd: string): boolean {
  if (!/^[A-Za-z0-9_.\/-]+$/.test(bin)) return false
  try {
    const r = exec(`command -v ${bin}`, cwd, 10_000)
    return r.exitCode === 0 && r.stdout.trim().length > 0
  } catch {
    return false
  }
}

function clippedOut(stdout: string, stderr: string): string {
  return clipOutput(`${stdout}\n${stderr}`.trim(), PORTABLE_OUTPUT_MAX).text
}


// UC-027: хвост для провалов — summary падений всегда в конце вывода.
function failureTailOf(stdout: string, stderr: string): string | undefined {
  const lines = `${stdout}\n${stderr}`.split("\n")
  let start = Math.max(0, lines.length - 200)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/short test summary info|^=+\s*FAILURES\s*=+|^FAILURES!|^failures:$/i.test(lines[i])) {
      start = i
      break
    }
  }
  const tail = lines.slice(start).join("\n").trim()
  if (!tail) return undefined
  return clipOutput(tail, PORTABLE_OUTPUT_MAX).text || undefined
}

// UC-028: эвристика прогретости сборки (наличие артефактов), не гарантия.
export function detectWarm(root: string, stack: string, dir: string): "cold" | "warm" | null {
  try {
    const base = dir ? path.join(root, dir) : root
    const nonEmptyDir = (p: string): boolean | null => {
      try {
        const st = fs.statSync(path.join(base, p))
        if (!st.isDirectory()) return null
        return fs.readdirSync(path.join(base, p)).length > 0 ? true : null
      } catch {
        return null
      }
    }
    if (stack === "rust") {
      const warm = nonEmptyDir("target")
      return warm === null ? "cold" : "warm"
    }
    if (stack === "node") {
      const warm = nonEmptyDir("node_modules")
      return warm === null ? "cold" : "warm"
    }
    if (stack === "python") {
      const venv = nonEmptyDir(".venv") ?? nonEmptyDir("venv")
      return venv === null ? "cold" : "warm"
    }
    if (stack === "php") {
      const warm = nonEmptyDir("vendor")
      return warm === null ? "cold" : "warm"
    }
    return null
  } catch {
    return null
  }
}

function runGate(
  exec: PortableExec,
  name: string,
  cmd: string | null,
  cwd: string,
  timeoutMs: number,
  testGate: boolean,
): PortableGate {
  const base = (outcome: PortableOutcome, extra: Partial<PortableGate> = {}): PortableGate => ({
    name,
    command: cmd,
    outcome,
    exitCode: null,
    durationMs: 0,
    note: "",
    ...extra,
  })
  if (!cmd) return base("skipped", { note: "no command known" })
  const bin = argv0(cmd)
  if (!binPresent(exec, bin, cwd)) {
    return base("blocked", { note: `runtime not found: ${bin || "?"}` })
  }
  const started = Date.now()
  let r: PortableExecResult
  try {
    r = exec(cmd, cwd, timeoutMs)
  } catch {
    return base("blocked", { note: "spawn failed", durationMs: Date.now() - started })
  }
  const durationMs = Date.now() - started
  if (r.timedOut) return base("blocked", { exitCode: r.exitCode, durationMs, note: `timeout ${timeoutMs}ms`, output: clippedOut(r.stdout, r.stderr) })
  const output = clippedOut(r.stdout, r.stderr)
  if (r.exitCode === 0) {
    if (!testGate) return base("pass", { exitCode: 0, durationMs, output, note: "exit 0" })
    const parsed = parseTestOutput(cmd, r.stdout, r.stderr)
    const total = parsed.tests ? parsed.tests.passed + parsed.tests.failed : -1
    if (parsed.tests && total === 0) {
      return base("no-tests", { exitCode: 0, durationMs, output, note: "0/0 tests" })
    }
    const summary = summarizeEvidence({ tool: parsed.tool, tests: parsed.tests, coverage: parsed.coverage })
    return base("pass", {
      exitCode: 0,
      durationMs,
      output,
      note: summary ?? "exit 0",
      ...(parsed.tests ? { tests: parsed.tests } : {}),
      ...(parsed.failures && parsed.failures.length > 0 ? { failures: parsed.failures } : {}),
    })
  }
  if (testGate && (r.exitCode === 5 || NO_TESTS_RE.test(`${r.stdout}\n${r.stderr}`))) {
    // exit 5 = pytest "no tests collected"; phpunit/jest пишут фразу явно.
    const parsed = parseTestOutput(cmd, r.stdout, r.stderr)
    return base("no-tests", {
      exitCode: r.exitCode,
      durationMs,
      output,
      note: "runner reports no tests",
      ...(parsed.tests ? { tests: parsed.tests } : {}),
    })
  }
  // UC-027: провал несёт counts + классифицированные падения + хвост.
  const parsed = testGate ? parseTestOutput(cmd, r.stdout, r.stderr) : { tool: "custom" as const }
  const tail = testGate ? failureTailOf(r.stdout, r.stderr) : undefined
  const summary = testGate ? summarizeEvidence(parsed) : null
  return base("fail", {
    exitCode: r.exitCode,
    durationMs,
    output,
    note: summary ?? `exit ${r.exitCode}`,
    ...(parsed.tests ? { tests: parsed.tests } : {}),
    ...(parsed.failures && parsed.failures.length > 0 ? { failures: parsed.failures } : {}),
    ...(tail ? { failureTail: tail } : {}),
  })
}

export function scorePortable(gates: PortableGate[]): {
  score: number | null
  level: PortableLevel
  verdict: PortableVerdict
} {
  const scored = gates.filter((g) => g.scored !== false)
  const applicable = scored.filter((g) => g.outcome === "pass" || g.outcome === "fail")
  if (applicable.length === 0) return { score: null, level: "inconclusive", verdict: "inconclusive" }
  // Тонкого evidence недостаточно для вердикта: один голый pass без counts
  // (например, lone `npm run build`) — это inconclusive, а не 100.
  // Исключения: test-гейт с распарсенными counts несёт сотни assertions сам,
  // а одиночный fail — это состоявшееся свидетельство поломки (score 0).
  if (applicable.length === 1) {
    const g = applicable[0]
    const hasCounts = g.tests !== undefined && g.tests.passed + g.tests.failed > 0
    if (g.outcome === "pass" && !hasCounts) {
      return { score: null, level: "inconclusive", verdict: "inconclusive" }
    }
  }
  let wsum = 0
  let wtot = 0
  for (const g of applicable) {
    const w = gateWeight(g.name)
    wtot += w
    wsum += w * gateScore(g)
  }
  const score = Math.round((100 * wsum) / wtot * 10) / 10
  let level: PortableLevel = score >= 95 ? "staff" : score >= 80 ? "senior" : score >= 60 ? "middle" : "junior"
  // Красные тесты в отчёте — потолок senior, даже если математика выше.
  // staff требует буквально ноль провалов.
  if (applicable.some((g) => (g.tests?.failed ?? 0) > 0) && level === "staff") level = "senior"
  return { score, level, verdict: applicable.some((g) => g.outcome === "fail") ? "fail" : "pass" }
}

// Скор отдельного гейта: pass=1, взвешенные падения — частичный кредит.
function gateScore(g: PortableGate): number {
  if (g.outcome === "pass") return 1
  if (g.outcome !== "fail") return 0
  const t = g.tests
  if (!t || t.passed + t.failed === 0) return 0
  const weights = (g.failures ?? []).map((f) => f.weight)
  while (weights.length < t.failed) weights.push(1.0) // неизвестное = code
  const penalty = weights.reduce((a, b) => a + b, 0)
  return Math.max(0, Math.min(1, 1 - (penalty / (t.passed + t.failed)) * FAILURE_IMPACT))
}

export interface PortableOptions {
  exec?: PortableExec
  timeoutMs?: number
}

export function evaluatePortable(root: string, exec: PortableExec = defaultExec, opts: PortableOptions = {}): PortableReport {
  const started = Date.now()
  const fallback = (note: string): PortableReport => ({
    mode: "portable",
    target: root,
    stack: null,
    preflight: {},
    gates: [],
    score: null,
    level: "inconclusive",
    verdict: "inconclusive",
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - started,
  })
  try {
    const abs = path.resolve(root)
    try {
      if (!fs.statSync(abs).isDirectory()) return { ...fallback("not a directory"), target: abs }
    } catch {
      return { ...fallback("target not found"), target: abs }
    }
    const timeoutMs = opts.timeoutMs ?? PORTABLE_GATE_TIMEOUT_MS
    const contract: StackContract | null = detectContract(abs)
    const bins = contract ? PREFLIGHT_BINS[contract.stack] ?? [] : ALL_BINS
    const preflight: Record<string, boolean> = {}
    for (const b of bins) preflight[b] = binPresent(exec, b, abs)
    const gates: PortableGate[] = []
    const missing = Object.entries(preflight).filter(([, ok]) => !ok).map(([b]) => b)
    gates.push({
      name: "preflight",
      command: null,
      outcome: missing.length === 0 ? "pass" : "blocked",
      exitCode: null,
      durationMs: 0,
      note: missing.length === 0 ? `runtimes ok: ${Object.keys(preflight).join(", ") || "n/a"}` : `missing: ${missing.join(", ")}`,
      scored: false,
    })
    if (!contract) {
      gates.push({ name: "stack", command: null, outcome: "skipped", exitCode: null, durationMs: 0, note: "stack unknown — nothing applicable", scored: false })
      const s = scorePortable(gates)
      return {
        mode: "portable", target: abs, stack: null, preflight, gates,
        score: s.score, level: s.level, verdict: s.verdict,
        timestamp: new Date().toISOString(), durationMs: Date.now() - started,
      }
    }
    const table = contract.commands()
    gates.push({
      name: "stack", command: null, outcome: "pass", exitCode: null, durationMs: 0,
      note: `${contract.stack} (${contract.source})`,
      scored: false,
    })
    const cwd = contract.dir ? path.join(abs, contract.dir) : abs
    const defs: Array<[string, string | null, boolean]> = [
      ["build", table.build, false],
      ["test", null, true], // test решается отдельно (verified-источник)
      ["lint", table.lint, false],
      ["typecheck", table.typecheck, false],
    ]
    for (const [name, cmd, isTest] of defs) {
      if (name === "test") {
        const raw = table.test
        const verified = raw !== null && isVerifiedTest(contract.stack, contract.source)
        gates.push(runGate(exec, "test", verified ? raw : null, cwd, timeoutMs, true))
        if (raw !== null && !verified) {
          const g = gates[gates.length - 1]
          g.note = `unverified default (${contract.source}) — not measured`
        }
        continue
      }
      // UC-028: маркер замеряем ДО запуска — иначе успешная сборка всегда "warm".
      const warmBefore = name === "build" && cmd !== null ? detectWarm(abs, contract.stack, contract.dir) : null
      gates.push(runGate(exec, name, cmd, cwd, timeoutMs, false))
      if (warmBefore) {
        const g = gates[gates.length - 1]
        g.note = g.note ? `${g.note} · ${warmBefore}` : warmBefore
      }
    }
    const s = scorePortable(gates)
    return {
      mode: "portable",
      target: abs,
      stack: { stack: contract.stack, dir: contract.dir, source: contract.source, commands: table },
      preflight,
      gates,
      score: s.score,
      level: s.level,
      verdict: s.verdict,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - started,
    }
  } catch {
    return fallback("internal error")
  }
}

// UC-029: дробь применимости и counts — в заголовке, а не только в JSON.
function testsLine(r: PortableReport): string {
  let passed = 0
  let failed = 0
  let hasCounts = false
  const causes: Record<string, number> = {}
  for (const g of r.gates) {
    if (g.scored === false || !g.tests) continue
    hasCounts = true
    passed += g.tests.passed
    failed += g.tests.failed
    for (const f of g.failures ?? []) causes[f.cause] = (causes[f.cause] ?? 0) + 1
  }
  if (!hasCounts) return "Tests: unparsed."
  const total = passed + failed
  if (failed === 0) return `Tests: ${passed}/${total} passed.`
  const rest = failed - Object.values(causes).reduce((a, b) => a + b, 0)
  if (rest > 0) causes["unclassified"] = (causes["unclassified"] ?? 0) + rest
  const breakdown = Object.entries(causes).map(([c, n]) => `${n} ${c}`).join(", ")
  return `Tests: ${passed}/${total} passed (${failed} failed: ${breakdown}).`
}

function gatesLine(r: PortableReport): string {
  const relevant = r.gates.filter((g) => g.scored !== false)
  const applicable = relevant.filter((g) => g.outcome === "pass" || g.outcome === "fail")
  const rest: Record<string, string[]> = {}
  for (const g of relevant) {
    if (g.outcome === "pass" || g.outcome === "fail") continue
    ;(rest[g.outcome] ??= []).push(g.name)
  }
  const tail = Object.entries(rest).map(([o, names]) => `${names.length} ${o}: ${names.join(", ")}`).join("; ")
  return `Gates: ${applicable.length}/${relevant.length} applicable${tail ? ` (${tail})` : ""}.`
}

export function toPortableJson(r: PortableReport): string {
  return JSON.stringify(r, null, 2) + "\n"
}

export function toPortableMarkdown(r: PortableReport): string {
  const lines: string[] = []
  lines.push(`# Portable evaluation: ${r.target}`)
  lines.push("")
  lines.push(r.score === null
    ? `Verdict **${r.verdict}** — no applicable gates (score N/A, not comparable to lab scores).`
    : `Score **${r.score.toFixed(1)}/100** — ${r.level} (${r.verdict}).`)
  lines.push(testsLine(r))
  lines.push(gatesLine(r))
  lines.push("")
  lines.push(`Stack: ${r.stack ? `${r.stack.stack} (${r.stack.source})` : "unknown"}.`)
  lines.push(`Preflight: ${Object.entries(r.preflight).map(([b, ok]) => `${b}=${ok ? "ok" : "MISS"}`).join(", ") || "—"}.`)
  lines.push("")
  lines.push("| Gate | Command | Outcome | Note |")
  lines.push("|---|---|---|---|")
  for (const g of r.gates) {
    lines.push(`| ${g.name} | ${g.command ?? "—"} | ${g.outcome} | ${(g.note || "").slice(0, 120)} |`)
  }
  lines.push("")
  lines.push("_Portable scores cover only applicable gates (blocked / no-tests / skipped excluded) and are NOT comparable to lab 0–100._")
  return sanitizeOutput(lines.join("\n")) + "\n"
}

export interface PortableCliOptions {
  root: string
  outJson: string
  outMd: string
  timeoutMs?: number
}

// "--target <path>" из текста команды /evaluate (и флаг скрипта).
export function parseEvaluateTarget(text: string): string | null {
  const m = /(?:^|\s)--target\s+(\S+)/.exec(String(text ?? ""))
  return m ? m[1] : null
}

export function runPortableEvaluator(opts: PortableCliOptions): { exitCode: number; summary: string } {
  const report = evaluatePortable(opts.root, defaultExec, { timeoutMs: opts.timeoutMs })
  fs.mkdirSync(path.dirname(opts.outJson), { recursive: true })
  fs.writeFileSync(opts.outJson, toPortableJson(report), "utf8")
  fs.writeFileSync(opts.outMd, toPortableMarkdown(report), "utf8")
  const summary = report.score === null
    ? `verdict ${report.verdict} · no applicable gates · snapshot ${report.target}`
    : `score ${report.score.toFixed(1)}/100 · ${report.level} · ${report.verdict}`
  // 0 = pass, 1 = fail, 2 = inconclusive/blocked-only.
  const exitCode = report.verdict === "pass" ? 0 : report.verdict === "fail" ? 1 : 2
  return { exitCode, summary }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]).endsWith("portable.ts")
if (isMain) {
  const get = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag)
    return i >= 0 ? process.argv[i + 1] : undefined
  }
  try {
    const root = get("--root")
    if (!root) throw new Error("required: --root <dir>")
    const outJson = get("--out-json") ?? path.join(process.cwd(), ".opencode", "eval-portable.json")
    const outMd = get("--out-md") ?? path.join(process.cwd(), ".opencode", "eval-portable.md")
    const { exitCode, summary } = runPortableEvaluator({ root, outJson, outMd })
    console.log(summary)
    console.log(`Report: ${outJson} + ${outMd}`)
    process.exit(exitCode)
  } catch (e) {
    console.error(`portable evaluator error: ${String((e as Error).message).slice(0, 300)}`)
    process.exit(2)
  }
}
