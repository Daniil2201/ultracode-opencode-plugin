// UC-019 — evaluation engine: сумма весов, hard gates, evidence refs, blockers,
// JSON + короткий Markdown-report. Score воспроизводим на одном snapshot.
import { CRITERIA, applyGates, levelForScore, verdictFor } from "./schema.ts"
import type { EvaluationLevel, GateId, SoftGateId, Verdict } from "./schema.ts"

export interface Finding {
  id: string
  severity: "critical" | "major" | "minor"
  text: string
}

export interface CriterionResult {
  id: string
  score: number
  max: number
  evidence: string[]
  findings: string[]
}

export interface EvaluationInput {
  snapshot: string
  goal: string
  criteria: CriterionResult[]
  hardFailed: GateId[]
  softFailed: SoftGateId[]
  blockers: Finding[]
  commands: string[]
  durationMs: number
}

export interface EvaluationResult {
  snapshot: string
  goal: string
  score: number
  level: EvaluationLevel
  verdict: Verdict
  gates: Record<string, "pass" | "fail">
  criteria: CriterionResult[]
  blockers: Finding[]
  evidence: string[]
  commands: string[]
  durationMs: number
  timestamp?: string
}

export function clampCriteria(input: CriterionResult[]): CriterionResult[] {
  return CRITERIA.map((def) => {
    const got = input.find((c) => c.id === def.id)
    const score = Math.max(0, Math.min(def.max, Math.round(got?.score ?? 0)))
    return { id: def.id, score, max: def.max, evidence: got?.evidence ?? [], findings: got?.findings ?? [] }
  })
}

export function collectBlockers(criteria: CriterionResult[], extra: Finding[] = []): Finding[] {
  const fromCriteria: Finding[] = []
  for (const c of criteria) {
    for (const f of c.findings) {
      if (f.startsWith("BLOCKER:")) {
        fromCriteria.push({ id: `${c.id}-blocker`, severity: "critical", text: f.slice(8).trim() })
      }
    }
  }
  return [...fromCriteria, ...extra]
}

export function evaluateProject(input: EvaluationInput): EvaluationResult {
  const criteria = clampCriteria(input.criteria)
  const raw = criteria.reduce((s, c) => s + c.score, 0)
  const score = applyGates(raw, input.hardFailed, input.softFailed)
  const blockers = collectBlockers(criteria, input.blockers)
  const gates: Record<string, "pass" | "fail"> = {
    compile: input.hardFailed.includes("compile") ? "fail" : "pass",
    tests: input.hardFailed.includes("acceptance") ? "fail" : "pass",
    runtime: input.hardFailed.includes("runtime_connected") || input.softFailed.includes("unit_only") ? "fail" : "pass",
    security: input.hardFailed.includes("secrets") || input.hardFailed.includes("data_loss") ? "fail" : "pass",
    reproducible: input.softFailed.includes("repro_missing") ? "fail" : "pass",
  }
  return {
    snapshot: input.snapshot,
    goal: input.goal,
    score,
    level: levelForScore(score),
    verdict: verdictFor(score, blockers.length),
    gates,
    criteria,
    blockers,
    evidence: criteria.flatMap((c) => c.evidence),
    commands: input.commands,
    durationMs: input.durationMs,
  }
}
