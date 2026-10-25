// UC-022 — debugger workflow: reproduce → isolate → hypothesize → fix →
// regression → verify. Чистые функции: состояние — обычный объект, гений
// дебага — в дисциплине (одна гипотеза за раз, fix только с регресс-тестом).
export type DebugStatus = "open" | "stuck" | "resolved"
export type HypothesisStatus = "pending" | "passed" | "failed"

export interface DebugHypothesis {
  id: string
  text: string
  check: string
  status: HypothesisStatus
}

export interface DebugAttempt {
  hypothesisId: string
  passed: boolean
  evidence: string
  ts: string
}

export interface DebugSession {
  id: string
  symptom: string
  context: string
  hypotheses: DebugHypothesis[]
  attempts: DebugAttempt[]
  status: DebugStatus
  rootCause?: string
  fix?: string
  regressionTest?: string
}

export function createDebugSession(symptom: string, context = ""): DebugSession {
  if (!symptom.trim()) throw new Error("symptom required")
  return {
    id: `dbg-${Date.now().toString(36)}`,
    symptom: symptom.slice(0, 500),
    context: context.slice(0, 1000),
    hypotheses: [],
    attempts: [],
    status: "open",
  }
}

export function addHypothesis(s: DebugSession, text: string, check: string): DebugHypothesis {
  if (!text.trim() || !check.trim()) throw new Error("hypothesis text and check required")
  const h: DebugHypothesis = {
    id: `h${s.hypotheses.length + 1}`,
    text: text.slice(0, 300),
    check: check.slice(0, 300),
    status: "pending",
  }
  s.hypotheses.push(h)
  if (s.status === "stuck") s.status = "open"
  return h
}

// Следующая непроверенная гипотеза — всегда одна, не пачкой.
export function nextHypothesis(s: DebugSession): DebugHypothesis | null {
  return s.hypotheses.find((h) => h.status === "pending") ?? null
}

export function recordAttempt(
  s: DebugSession,
  hypothesisId: string,
  passed: boolean,
  evidence: string,
): DebugStatus {
  const h = s.hypotheses.find((x) => x.id === hypothesisId)
  if (!h) throw new Error(`unknown hypothesis: ${hypothesisId}`)
  h.status = passed ? "passed" : "failed"
  s.attempts.push({ hypothesisId, passed, evidence: evidence.slice(0, 500), ts: new Date().toISOString() })
  if (passed) return s.status
  // Все гипотезы опровергнуты — не закрываем, а требуем новые (stuck, не resolved).
  if (!s.hypotheses.some((x) => x.status === "pending")) s.status = "stuck"
  return s.status
}

// Fix принимается только вместе с регресс-тестом — иначе баг вернётся.
export function resolveDebug(
  s: DebugSession,
  rootCause: string,
  fix: string,
  regressionTest: string,
): void {
  if (!rootCause.trim() || !fix.trim()) throw new Error("rootCause and fix required")
  if (!regressionTest.trim()) throw new Error("regression test required: fix without test is not accepted")
  s.rootCause = rootCause.slice(0, 500)
  s.fix = fix.slice(0, 500)
  s.regressionTest = regressionTest.slice(0, 500)
  s.status = "resolved"
}

export function debugReport(s: DebugSession): string {
  const lines = [
    `# Debug: ${s.symptom}`,
    `status: ${s.status}`,
    ...s.hypotheses.map(
      (h) => `- [${h.status}] ${h.id}: ${h.text} (check: ${h.check})`,
    ),
    ...s.attempts.map(
      (a) => `  attempt ${a.hypothesisId}: ${a.passed ? "PASS" : "FAIL"} — ${a.evidence}`,
    ),
  ]
  if (s.rootCause) lines.push(`root cause: ${s.rootCause}`)
  if (s.fix) lines.push(`fix: ${s.fix}`)
  if (s.regressionTest) lines.push(`regression: ${s.regressionTest}`)
  return lines.join("\n")
}
