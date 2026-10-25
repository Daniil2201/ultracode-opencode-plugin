// UC-017 — runtime-контракт tool `ultracode_context`: единый источник правды
// для схемы плагина и runtime-тестов. Хелперы не могут разъехаться со схемой:
// плагин строит args-схему из этих констант, тесты валидируются ими же.
import type { StepStatus } from "./schema.ts"

export const TOOL_ACTIONS = [
  "list",
  "add",
  "search",
  "view",
  "history",
  "diff",
  "close",
  "thread",
  "compact",
  "farm",
  "stats",
  "tokens",
  "budget",
  "anim",
  "plan_new",
  "plan_show",
  "plan_step",
  "evidence",
  "evaluate",
  "contract",
  "learn",
  "lessons",
] as const

export type ToolAction = (typeof TOOL_ACTIONS)[number]

// UC-017 case 3: verify_required принимается schema инструмента.
export const STEP_STATUSES: StepStatus[] = ["todo", "in_progress", "verify_required", "done", "failed"]

export function isToolAction(a: unknown): a is ToolAction {
  return typeof a === "string" && (TOOL_ACTIONS as readonly string[]).includes(a)
}

export function isStepStatus(s: unknown): s is StepStatus {
  return typeof s === "string" && (STEP_STATUSES as readonly string[]).includes(s)
}

export interface EvidenceArgs {
  planId?: string
  stepId: string
  command: string
  exitCode: number
  stdout?: string
  stderr?: string
  // UC-024: явный раннер имеет приоритет над автоопределением;
  // мусор игнорируется (lenient), не бросает.
  tool?: string
}

// UC-017 case 2: verify создаёт evidence через runtime tool schema —
// валидация тех же полей, что принимает execute().
export function validateEvidenceArgs(args: Record<string, unknown>): EvidenceArgs {
  const stepId = args["stepId"] ?? args["step"]
  if (typeof stepId !== "string" || stepId.length === 0) throw new Error("evidence: stepId required")
  if (typeof args["command"] !== "string" || (args["command"] as string).length === 0) {
    throw new Error("evidence: command required")
  }
  if (typeof args["exitCode"] !== "number" || !Number.isInteger(args["exitCode"])) {
    throw new Error("evidence: integer exitCode required")
  }
  const out: EvidenceArgs = {
    stepId,
    command: args["command"] as string,
    exitCode: args["exitCode"] as number,
  }
  if (typeof args["planId"] === "string") out.planId = args["planId"]
  else if (typeof args["plan"] === "string") out.planId = args["plan"] as string
  if (typeof args["stdout"] === "string") out.stdout = args["stdout"] as string
  if (typeof args["stderr"] === "string") out.stderr = args["stderr"] as string
  if (typeof args["tool"] === "string") out.tool = args["tool"] as string
  return out
}

export interface PlanNewArgs {
  goal: string
  steps: string[]
  stepChecks?: string[]   // per-step acceptance commands (parallel to steps)
  acceptanceCommand?: string
  dependsOn?: Record<string, string[]>
}

// UC-033: агенты пишут шаги одной строкой через | или нумерацию
// ("recon|tech|db", "1. a 2. b") — режем на шаги, иначе план из 1 шага.
// Многострочный ввод режется только по \n (там | — часть текста).
function splitStepLines(t: string): string[] {
  const lines = t.split("\n").map((s) => s.trim()).filter(Boolean)
  if (lines.length !== 1) return lines
  const one = lines[0]
  if (one.includes("|")) {
    const parts = one.split("|").map((s) => s.trim()).filter(Boolean)
    if (parts.length > 1) return parts
  }
  const numbered = one.split(/(?=\b\d{1,2}[.)]\s+)/).map((s) => s.trim()).filter(Boolean)
  if (numbered.length > 1 && /^\d{1,2}[.)]\s+/.test(numbered[0])) return numbered
  return lines
}

// UC-017 case 1: plan_new сохраняет acceptance command и зависимости.
// Принимает и legacy text-формат (заголовок + строки), и структурированные поля.
export function validatePlanNewArgs(args: Record<string, unknown>): PlanNewArgs {
  const text = typeof args["text"] === "string" ? args["text"] : ""
  const goal = typeof args["goal"] === "string" && args["goal"] ? (args["goal"] as string) : text.split("\n")[0] ?? ""
  if (!goal.trim()) throw new Error("plan_new: goal required (goal or text)")
  let steps: string[] = []
  const rawSteps = args["steps"]
  const stepChecks: string[] = []
  if (Array.isArray(rawSteps)) {
    steps = (rawSteps as unknown[]).map((s) => {
      if (typeof s === "string") return s
      const obj = s as Record<string, unknown>
      if (typeof obj["check"] === "string" && (obj["check"] as string).trim()) {
        stepChecks.push((obj["check"] as string).trim())
      } else {
        stepChecks.push("")
      }
      return String(obj["text"] ?? "")
    }).filter(Boolean)
  } else if (typeof rawSteps === "string" && rawSteps.trim()) {
    // Tool-схема не выражает массивы: JSON-array или построчный список.
    const t = rawSteps.trim()
    if (t.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(t)
        if (Array.isArray(parsed)) {
          steps = (parsed as unknown[]).map((s) => {
            if (typeof s === "string") { stepChecks.push(""); return s }
            const obj = s as Record<string, unknown>
            if (typeof obj["check"] === "string" && (obj["check"] as string).trim()) {
              stepChecks.push((obj["check"] as string).trim())
            } else {
              stepChecks.push("")
            }
            return String(obj["text"] ?? "")
          }).filter(Boolean)
        }
      } catch {
        steps = splitStepLines(t)
      }
    } else {
      steps = splitStepLines(t)
    }
  } else {
    steps = text.split("\n").slice(1).flatMap((ln) => splitStepLines(ln))
  }
  if (steps.length === 0) throw new Error("plan_new: at least one step required")
  const out: PlanNewArgs = { goal: goal.slice(0, 500), steps }
  if (stepChecks.length > 0 && stepChecks.some((c) => c)) out.stepChecks = stepChecks
  const acc = args["acceptanceCommand"] ?? args["acceptance_command"] ?? args["check"]
  if (typeof acc === "string" && acc.trim()) out.acceptanceCommand = acc.slice(0, 500)
  const rawDeps = args["dependsOn"] ?? args["depends_on"]
  if (typeof rawDeps === "string" && rawDeps.trim()) {
    try {
      const parsed: unknown = JSON.parse(rawDeps)
      if (parsed && typeof parsed === "object") out.dependsOn = parsed as Record<string, string[]>
    } catch {
      throw new Error("plan_new: dependsOn must be a JSON object")
    }
  } else if (rawDeps && typeof rawDeps === "object") {
    out.dependsOn = rawDeps as Record<string, string[]>
  }
  return out
}
