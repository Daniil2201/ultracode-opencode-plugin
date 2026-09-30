// UC-006 + UC-014 — оркестрация: готовые шаги, батчи, ретраи.
// Ponytail: чистые функции. task/MCP вызывает агент, а не этот модуль.
import type { Plan, PlanStep } from "./schema.ts"
import { canRetry, depsDone } from "./plan.ts"

export const MAX_PARALLEL = 3
export const MAX_ATTEMPTS = 3

export function buildStepPrompt(planId: string, stepId: string, goal: string): string {
  return [
    `planId=${planId}`,
    `stepId=${stepId}`,
    `Цель: ${goal}`,
    "Верни результат, команду проверки и evidence.",
  ].join("\n")
}

// Независимые шаги, готовые к запуску: todo + зависимости done.
export function readySteps(plan: Plan): PlanStep[] {
  return plan.steps.filter((s) => s.status === "todo" && depsDone(plan, s))
}

// Следующий батч для параллельного запуска одним сообщением (maxParallel=3).
export function nextBatch(plan: Plan, maxParallel: number = MAX_PARALLEL): PlanStep[] {
  return readySteps(plan).slice(0, Math.max(1, Math.min(maxParallel, MAX_PARALLEL)))
}

export function shouldRetryStep(step: PlanStep): boolean {
  if (step.status !== "failed") return false
  return (step.attempts ?? 0) < MAX_ATTEMPTS && canRetry(step)
}

// План продолжается после перезапуска: активен, пока есть незавершённые шаги без блокера.
export function planResumable(plan: Plan): boolean {
  if (plan.status === "done") return false
  return plan.steps.some((s) => s.status === "todo" || s.status === "in_progress" || s.status === "verify_required" || (s.status === "failed" && shouldRetryStep(s)))
}

// UC-014: автономный цикл в чистом виде для тестов.
// Реальный агент подставляет runTask (task вызов) и verify (acceptance command).
export async function runAutonomousGoal(
  plan: Plan,
  runTask: (step: PlanStep) => Promise<void>,
  opts: { maxIter?: number } = {},
): Promise<Plan> {
  const maxIter = opts.maxIter ?? 20
  for (let i = 0; i < maxIter; i++) {
    if (!planResumable(plan)) break
    const batch = nextBatch(plan)
    if (batch.length === 0) break
    for (const step of batch) {
      step.status = "in_progress"
      try {
        await runTask(step)
      } catch (e) {
        step.status = "failed"
        step.attempts = (step.attempts ?? 0) + 1
        if (!shouldRetryStep(step)) {
          plan.blockers ??= []
          plan.blockers.push(`${step.id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
          plan.status = "blocked"
        } else {
          step.status = "todo"
        }
      }
    }
  }
  return plan
}
