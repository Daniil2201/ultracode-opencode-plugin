// EV-001/EV-002 — единый CLI evaluator: gates JSON → criteria → evaluateProject()
// → caps → verdict → toReportJson/toReportMarkdown → файлы. Shell-скрипт —
// только launcher/CI gate: собирает gate-результаты и возвращает код cli.
// Формулы PASS*100/(PASS+FAIL) как итогового score здесь нет и быть не должно.
import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { buildCriteria } from "./criteria.ts"
import type { GateResult } from "./criteria.ts"
import { evaluateProject } from "./scoring.ts"
import { sanitizeOutput } from "../verification.ts"
import { toReportJson, toReportMarkdown } from "./report.ts"

export interface CliOptions {
  gatesFile: string
  root: string
  goal: string
  mode: "smoke" | "all"
  outJson: string
  outMd: string
  snapshot?: string
  durationMs?: number
}

export function parseArgs(argv: string[]): CliOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const mode = get("--mode") ?? "smoke"
  if (mode !== "smoke" && mode !== "all") throw new Error(`--mode must be smoke|all, got ${mode}`)
  const gatesFile = get("--gates")
  const root = get("--root")
  if (!gatesFile || !root) throw new Error("required: --gates <json> --root <dir>")
  return {
    gatesFile,
    root,
    goal: get("--goal") ?? "Ultracode 2.0",
    mode,
    outJson: get("--out-json") ?? path.join(root, ".opencode", "eval-last.json"),
    outMd: get("--out-md") ?? path.join(root, ".opencode", "eval-last.md"),
    snapshot: get("--snapshot"),
    durationMs: get("--duration-ms") !== undefined ? Number(get("--duration-ms")) : undefined,
  }
}

// EV-006: git SHA если доступен, иначе детерминированный worktree-маркер
// (имена + размеры исходников — стабилен для одного дерева, дешёвый).
export function snapshotMetadata(root: string): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim()
    if (/^[0-9a-f]{4,40}$/.test(sha)) return `git:${sha.slice(0, 12)}`
  } catch { /* нет git — worktree marker */ }
  const h = createHash("sha256")
  const walk = (dir: string): void => {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(dir).sort()
    } catch {
      return
    }
    for (const e of entries) {
      // node_modules/target/.git шумят и нестабильны; eval-last.* — самореференция
      // (маркер обязан пережить прогон без изменений).
      if (e === "node_modules" || e === "target" || e === ".git") continue
      if (e === "eval-last.json" || e === "eval-last.md") continue
      const full = path.join(dir, e)
      let st
      try {
        st = fs.statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full)
      else if (/\.(ts|rs|sh|md)$/.test(e)) h.update(`${path.relative(root, full)}:${st.size}\n`)
    }
  }
  walk(root)
  return `worktree:${path.basename(path.resolve(root))}:${h.digest("hex").slice(0, 12)}`
}

export interface CliReport {
  exitCode: number
  summary: string
}

export function runEvaluator(opts: CliOptions): CliReport {
  const started = Date.now()
  const raw = JSON.parse(fs.readFileSync(opts.gatesFile, "utf8")) as { gates: GateResult[] }
  // Нормализация входов: кривой gates-файл не должен ронять скоринг исключением.
  const gates: GateResult[] = (raw.gates ?? []).map((g) => ({
    name: String(g?.name ?? "unknown"),
    command: String(g?.command ?? ""),
    exitCode: typeof g?.exitCode === "number" && Number.isInteger(g.exitCode) ? g.exitCode : 1,
    durationMs: typeof g?.durationMs === "number" && g.durationMs >= 0 ? g.durationMs : 0,
    output: String(g?.output ?? ""),
  }))
  const built = buildCriteria(gates, opts.mode)
  const snapshot = opts.snapshot ?? snapshotMetadata(opts.root)
  const durationMs = opts.durationMs ?? 0
  // Секреты не персистятся даже в commands отчёта.
  const commands = gates.map((g) => sanitizeOutput(g.command).slice(0, 160))
  const first = evaluateProject({
    snapshot,
    goal: opts.goal,
    criteria: built.criteria,
    hardFailed: built.hardFailed,
    softFailed: built.softFailed,
    blockers: built.blockers,
    commands,
    durationMs,
  })
  // Детерминизм: тот же вход — тот же score (regression EV-007).
  const second = evaluateProject({
    snapshot,
    goal: opts.goal,
    criteria: built.criteria,
    hardFailed: built.hardFailed,
    softFailed: built.softFailed,
    blockers: built.blockers,
    commands,
    durationMs,
  })
  if (second.score !== first.score || JSON.stringify(second) !== JSON.stringify(first)) {
    throw new Error("non-deterministic scoring: same input gave different result")
  }
  // EV-005: secrets/data loss → verdict fail (уровень уже ограничен капами,
  // verdict доводится явно — критический blocker не может получить pass).
  // EV-006: timestamp фиксируется в отчёте рядом со snapshot и durationMs.
  const stamped = {
    ...((built.hardFailed.includes("secrets") || built.hardFailed.includes("data_loss"))
      ? { ...first, verdict: "fail" as const }
      : first),
    timestamp: new Date().toISOString(),
  }
  const result = stamped
  fs.mkdirSync(path.dirname(opts.outJson), { recursive: true })
  fs.writeFileSync(opts.outJson, toReportJson(result), "utf8")
  fs.writeFileSync(opts.outMd, toReportMarkdown(result), "utf8")
  const summary = `score ${result.score}/100 · ${result.level} · ${result.verdict} · snapshot ${snapshot} · ${Date.now() - started}ms cli`
  const exitCode = result.blockers.length > 0 || result.score < 60 ? 1 : 0
  return { exitCode, summary }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]).endsWith("cli.ts")
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2))
    const { exitCode, summary } = runEvaluator(opts)
    console.log(summary)
    console.log(`Report: ${opts.outJson} + ${opts.outMd}`)
    process.exit(exitCode)
  } catch (e) {
    console.error(`evaluator error: ${String((e as Error).message).slice(0, 300)}`)
    process.exit(2)
  }
}
