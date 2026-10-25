// UC-019 — report: JSON артефакт + короткий Markdown без секретов.
import { sanitizeOutput } from "../verification.ts"
import type { EvaluationResult } from "./scoring.ts"

export function toReportJson(result: EvaluationResult): string {
  // Секреты не персистятся даже в machine-артефакт: чистим commands на границе.
  const safe = {
    ...result,
    commands: result.commands.map((c) => sanitizeOutput(c).slice(0, 160)),
  }
  return JSON.stringify(safe, null, 2) + "\n"
}

export function toReportMarkdown(result: EvaluationResult): string {
  const lines: string[] = []
  lines.push(`# Evaluation: ${result.goal}`)
  lines.push("")
  lines.push(`Score **${result.score}/100** — ${result.level} (${result.verdict}). Snapshot \`${result.snapshot}\`.`)
  lines.push("")
  lines.push("| Criterion | Score |")
  lines.push("|---|---:|")
  for (const c of result.criteria) lines.push(`| ${c.id} | ${c.score}/${c.max} |`)
  const findings = result.criteria.flatMap((c) => c.findings.map((f) => `- ${c.id}: ${f}`))
  if (findings.length) {
    lines.push("")
    lines.push("## Findings")
    for (const f of findings.slice(0, 20)) lines.push(f)
  }
  lines.push("")
  lines.push(`Gates: ${Object.entries(result.gates).map(([k, v]) => `${k}=${v}`).join(", ")}.`)
  if (result.blockers.length) {
    lines.push("")
    lines.push("## Blockers")
    for (const b of result.blockers) lines.push(`- [${b.severity}] ${b.text}`)
  }
  if (result.commands.length) {
    lines.push("")
    lines.push("## Commands")
    for (const c of result.commands.slice(0, 20)) lines.push(`- \`${sanitizeOutput(c).slice(0, 160)}\``)
  }
  if (result.timestamp) {
    lines.push("")
    lines.push(`Timestamp: ${result.timestamp} · durationMs: ${result.durationMs}`)
  }
  return sanitizeOutput(lines.join("\n")) + "\n"
}
