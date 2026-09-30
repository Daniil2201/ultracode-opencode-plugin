// UC-002 — модель плана и безопасные переходы статусов.
// Ponytail: чистые функции, без I/O. Персистентность — через store.ts вызывающим кодом.
import type { ContextStore, Evidence, Plan, PlanStep, StepStatus } from "./schema.ts"

export type { Plan, PlanStep, StepStatus, Evidence, ContextStore }
export const MAX_ATTEMPTS = 3

function uuid(): string {
  const c = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

export function createPlan(goal: string, stepTexts: string[], acceptanceCommand?: string): Plan {
  const title = goal.split("\n")[0].slice(0, 120).trim() || goal.slice(0, 120)
  return {
    id: `plan-${Date.now().toString(36)}`,
    ts: new Date().toISOString(),
    title,
    goal,
    steps: stepTexts.filter(Boolean).map((t, i) => ({
      id: `s${i + 1}`,
      text: String(t).replace(/^[-*\d.)]+\s*/, "").slice(0, 200),
      status: "todo" as StepStatus,
      attempts: 0,
    })),
    status: "active",
    acceptance: acceptanceCommand ? { command: acceptanceCommand } : undefined,
  }
}

export function getPlan(store: ContextStore, planId: string): Plan {
  const p = store.plans[planId]
  if (!p) throw new Error(`unknown plan: ${planId}`)
  return p
}

export function savePlan(store: ContextStore, plan: Plan): void {
  if (!plan.id || !plan.goal || plan.steps.length === 0) throw new Error("invalid plan")
  store.plans[plan.id] = plan
}

export function loadPlan(store: ContextStore, planId: string): Plan {
  return getPlan(store, planId)
}

export function findStep(plan: Plan, stepId: string): PlanStep {
  const s = plan.steps.find((x) => x.id === stepId)
  if (!s) throw new Error(`unknown step: ${stepId}`)
  return s
}

// Зависимости выполнены?
export function depsDone(plan: Plan, step: PlanStep): boolean {
  if (!step.dependsOn || step.dependsOn.length === 0) return true
  return step.dependsOn.every((d) => plan.steps.find((x) => x.id === d)?.status === "done")
}

// UC-018/UC-036: успех должен принадлежать ТЕКУЩЕЙ попытке, stale evidence не закрывает.
// Единственный предикат «попытка успешна»: и гейт, и переход берут его отсюда.
function currentSuccess(step: PlanStep): Evidence | undefined {
  const cur = step.attempts ?? 0
  return (step.evidence ?? []).find((e) => e.exitCode === 0 && (e.attempt ?? 0) === cur)
}

function hasCurrentSuccess(step: PlanStep): boolean {
  return currentSuccess(step) !== undefined
}

// UC-036 — чек достижения цели. Чистая функция: ничего не мутирует, I/O нет.
// Все шаги done — необходимое, но не достаточное условие закрытия.
export interface GoalVerdict {
  reached: boolean
  /** Тривиальный план: чек не выполнялся, закрытие не блокируется. */
  skipped: boolean
  violations: string[]
}

export const GOAL_FAIL_STEP_ID = "gf"

export function evaluateGoal(plan: Plan): GoalVerdict {
  // metadata в Plan нет, а schema.ts вне scope — читаем без смены типа.
  const meta = (plan as unknown as { metadata?: { trivial?: boolean } }).metadata
  if (plan.steps.length <= 1 || meta?.trivial === true) return { reached: true, skipped: true, violations: [] }
  const violations: string[] = []
  // Статус, а не план.blockers[]: массив — журнал, запись переживает resume.
  if (plan.status === "blocked") violations.push("открытый блокер")
  for (const s of plan.steps) {
    // Один шаг — не более одного нарушения, иначе gf собирает дубли.
    if (s.status === "failed") { violations.push(`${s.id}: failed (attempts ${s.attempts ?? 0})`); continue }
    if (s.status !== "done") { violations.push(`${s.id}: не done (${s.status})`); continue }
    if (!hasCurrentSuccess(s)) { violations.push(`${s.id}: нет успешного evidence текущей попытки`); continue }
    const acc = plan.acceptance?.command?.trim()
    if (!acc) continue
    // Направление префикса — как в applyEvidence (`acc.startsWith(cmd)`), иначе принятое
    // evidence давало бы gf. Пустая команда даёт startsWith("") === true — тоже не violation.
    const ok = currentSuccess(s)
    if (ok && ok.command.trim() !== acc && !acc.startsWith(ok.command.trim())) {
      violations.push(`${s.id}: команда evidence не совпадает с acceptance`)
    }
  }
  return { reached: violations.length === 0, skipped: false, violations }
}

// Гейт закрытия. Единственное место, где plan.status становится "done".
// Провал: gf — один раз на план, дальше терминально (blocked + blockers).
export function enforceGoal(plan: Plan): GoalVerdict {
  const verdict = evaluateGoal(plan)
  if (verdict.reached) {
    plan.status = "done"
    return verdict
  }
  const why = verdict.violations.join("; ")
  const gfText = `[GOAL_FAIL] цель не достигнута: ${why}`.slice(0, 200)
  const gf = plan.steps.find((s) => s.id === GOAL_FAIL_STEP_ID)
  if (!gf) {
    plan.steps.push({ id: GOAL_FAIL_STEP_ID, text: gfText, status: "todo", attempts: 0 })
    plan.status = "active"
  } else if (gf.status === "todo") {
    gf.text = gfText
    plan.status = "active"
  } else {
    plan.blockers ??= []
    plan.blockers.push(`GOAL_FAIL: ${why}`.slice(0, 200))
    plan.status = "blocked"
  }
  return verdict
}

// Безопасный переход. Правила:
// - неизвестный stepId -> throw
// - done только из verify_required при успешном evidence (иначе throw)
// - in_progress только когда depsDone (иначе throw)
// - verify_required — рабочий переход из in_progress после выполнения работы
export function transitionStep(plan: Plan, stepId: string, to: StepStatus): PlanStep {
  const step = findStep(plan, stepId)
  if (to === "done") {
    if (!hasCurrentSuccess(step)) throw new Error(`cannot mark ${stepId} done without successful evidence for attempt ${step.attempts ?? 0}`)
    step.status = "done"
    if (plan.steps.every((s) => s.status === "done")) enforceGoal(plan)
    return step
  }
  if (to === "in_progress") {
    if (!depsDone(plan, step)) throw new Error(`cannot start ${stepId} before dependencies: ${(step.dependsOn ?? []).join(",")}`)
    if (step.status !== "todo" && step.status !== "failed") throw new Error(`cannot restart ${stepId} from ${step.status}`)
    step.status = "in_progress"
    if (plan.status !== "active") plan.status = "active"
    return step
  }
  if (to === "verify_required") {
    if (step.status !== "in_progress") throw new Error(`only in_progress step can go verify_required (now ${step.status})`)
    step.status = "verify_required"
    return step
  }
  if (to === "failed") {
    step.status = "failed"
    return step
  }
  // to === "todo": сброс после fail для retry
  step.status = "todo"
  return step
}

export function recordAttempt(step: PlanStep): void {
  step.attempts = (step.attempts ?? 0) + 1
}

export function canRetry(step: PlanStep): boolean {
  return (step.attempts ?? 0) < MAX_ATTEMPTS
}

export function addBlocker(plan: Plan, text: string): void {
  plan.blockers ??= []
  plan.blockers.push(text)
  plan.status = "blocked"
}

export function activePlan(store: ContextStore): Plan | null {
  const ids = Object.keys(store.plans)
  if (ids.length === 0) return null
  // последний активный, иначе последний вообще
  for (let i = ids.length - 1; i >= 0; i--) {
    const p = store.plans[ids[i] as string] as Plan
    if (p.status === "active") return p
  }
  return store.plans[ids[ids.length - 1] as string] as Plan
}

export { uuid }
