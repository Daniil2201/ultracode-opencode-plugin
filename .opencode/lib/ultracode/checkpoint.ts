// UC-010 — checkpoint при compaction: только компактный summary, без переписывания истории.
import type { Plan } from "./schema.ts"

export function buildCheckpoint(plan: Plan | null): string {
  if (!plan) return "No active plan"
  const current = plan.steps.find((s) => s.status === "in_progress")
  return [
    `PLAN: ${plan.id}`,
    `GOAL: ${plan.goal}`,
    `CURRENT: ${current?.id ?? "none"}`,
    `BLOCKERS: ${plan.blockers?.join("; ") ?? "none"}`,
  ].join("\n")
}

// Дедупликация: повторная compaction того же плана+текущего шага не плодит записи.
export function checkpointKey(plan: Plan | null): string {
  if (!plan) return "none"
  const current = plan.steps.find((s) => s.status === "in_progress")?.id ?? "none"
  return `${plan.id}:${current}`
}

export function appendCheckpointOnce(context: string[], plan: Plan | null, seen: Set<string>): boolean {
  const key = checkpointKey(plan)
  if (seen.has(key)) return false
  seen.add(key)
  context.push(buildCheckpoint(plan))
  return true
}
