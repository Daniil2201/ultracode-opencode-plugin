// UC-016 — изолированный лабораторный runner: clean snapshot, timeout,
// clip+redact, минимум два прогона, ошибка команды — evidence, не падение.
import { spawnSync } from "node:child_process"
import { clipOutput, sanitizeOutput } from "../verification.ts"
import type { Evidence } from "../schema.ts"

export interface LabEvidence extends Evidence {
  durationMs: number
}

export const LAB_DEFAULT_TIMEOUT_MS = 120_000
export const LAB_MAX_OUTPUT = 4000

// Команда сохраняется без секретов: краснеем значения, оставляем форму вызова.
export function sanitizeCommand(cmd: string): string {
  return sanitizeOutput(cmd).slice(0, 500)
}

export interface LabResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export function execSafe(command: string, cwd: string, timeoutMs = LAB_DEFAULT_TIMEOUT_MS): LabResult {
  try {
    const r = spawnSync("bash", ["-c", command], { cwd, encoding: "utf8", timeout: timeoutMs })
    const timedOut = r.error != null && String((r.error as Error).message ?? "").includes("ETIMEDOUT")
    return {
      exitCode: typeof r.status === "number" ? r.status : 1,
      stdout: String(r.stdout ?? ""),
      stderr: timedOut ? `TIMEOUT after ${timeoutMs}ms` : String(r.stderr ?? r.error?.message ?? ""),
      timedOut,
    }
  } catch (e) {
    return { exitCode: 1, stdout: "", stderr: String((e as Error).message).slice(0, 500), timedOut: false }
  }
}

export function runLabCommand(command: string, cwd: string, timeoutMs = LAB_DEFAULT_TIMEOUT_MS): LabEvidence {
  const started = Date.now()
  const result = execSafe(command, cwd, timeoutMs)
  const out = clipOutput(result.stdout, LAB_MAX_OUTPUT)
  const err = clipOutput(result.stderr, LAB_MAX_OUTPUT)
  return {
    command: sanitizeCommand(command),
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
    stdout: out.text || undefined,
    stderr: err.text || undefined,
    ts: new Date().toISOString(),
    truncated: out.truncated || err.truncated || undefined,
  }
}

// Воспроизводимость: два прогона сравнимы (оба exit 0), иначе — не reproducible.
export function runsReproducible(a: LabEvidence, b: LabEvidence): boolean {
  return a.exitCode === 0 && b.exitCode === 0
}
