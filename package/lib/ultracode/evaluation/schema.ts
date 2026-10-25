// UC-015 — контракт оценки: score 0–100, критерии с весами, уровни, hard gates.
// Оценивается артефакт в snapshot, а не личность разработчика.
export type EvaluationLevel = "junior" | "middle" | "senior" | "staff"

export interface CriterionDef {
  id: string
  max: number
}

export const CRITERIA: CriterionDef[] = [
  { id: "correctness", max: 30 },
  { id: "tests", max: 20 },
  { id: "runtime", max: 15 },
  { id: "security", max: 15 },
  { id: "reliability", max: 10 },
  { id: "architecture", max: 5 },
  { id: "performance", max: 3 },
  { id: "docs", max: 2 },
]

export const TOTAL_MAX = CRITERIA.reduce((s, c) => s + c.max, 0)

export function levelForScore(score: number): EvaluationLevel {
  if (score >= 95) return "staff"
  if (score >= 80) return "senior"
  if (score >= 60) return "middle"
  return "junior"
}

export type GateId =
  | "compile"
  | "acceptance"
  | "runtime_connected"
  | "secrets"
  | "confirmation"
  | "data_loss"

export type SoftGateId =
  | "unit_only"
  | "negative_missing"
  | "persistence_missing"
  | "repro_missing"

// Hard gates: score не выше 59 при любом критическом провале.
export function hardGateCap(failed: GateId[]): number {
  return failed.length > 0 ? 59 : 100
}

// Soft gates: score не выше 79 при неполной runtime-зрелости.
export function softGateCap(failed: SoftGateId[]): number {
  return failed.length > 0 ? 79 : 100
}

export function applyGates(raw: number, hard: GateId[], soft: SoftGateId[]): number {
  return Math.min(raw, hardGateCap(hard), softGateCap(soft))
}

export type Verdict = "fail" | "needs_changes" | "pass" | "pass_with_followups"

export function verdictFor(score: number, blockers: number): Verdict {
  if (blockers > 0 || score < 60) return score < 40 ? "fail" : "needs_changes"
  if (score >= 95) return "pass"
  return "pass_with_followups"
}
