// Ultracode v3 — схема хранилища. Только типы + чистая миграция, без I/O.
// Ponytail: один файл типов, никаких абстракций и ORM.
import type { DetectedStack } from "./stack-detect.ts"

export const STORE_VERSION = 3 as const

export type KnowledgeKind = "decision" | "fact" | "progress" | "blocker" | "digest"
export type LessonKind = "error" | "success" | "lesson"
export type StepStatus = "todo" | "in_progress" | "verify_required" | "done" | "failed"
export type PlanStatus = "active" | "done" | "blocked"

export interface Knowledge {
  id: string
  ts: string
  kind: KnowledgeKind
  project: string
  text: string
  labels: string[]
  source?: string
  status: "open" | "closed"
  archived: boolean
  thread?: { ts: string; author: string; text: string }[]
}

export interface Lesson {
  id: string
  ts: string
  kind: LessonKind
  project: string
  text: string
  labels: string[]
}

export interface Evidence {
  command: string
  exitCode: number
  stdout?: string
  stderr?: string
  ts: string
  truncated?: boolean
  // UC-018: привязка к попытке. done требует успеха именно текущей попытки,
  // иначе stale evidence закрыл бы новый attempt после retry.
  attempt?: number
  // UC-024: кросс-язычная структура. Все поля опциональны: старые записи
  // без них валидны, counts — только информация (гейтинг всегда по exitCode).
  tool?: EvidenceTool
  tests?: TestCounts
  coverage?: number
  // UC-027: классифицированные падения (fail-closed: неизвестное = code).
  // Кап 50 записей — скоринг использует веса, а не объём.
  failures?: TestFailure[]
}

// UC-024: раннеры с известным форматом отчёта; остальное — custom без counts.
export type EvidenceTool = "pytest" | "cargo-test" | "jest" | "playwright" | "node-test" | "go-test" | "phpunit" | "custom"

export interface TestCounts {
  passed: number
  failed: number
}

// UC-027: причина провала теста. Вес — доля "вины" проекта:
// code=полный провал, drift/environment/flaky — discounted.
export type FailureCause = "code" | "drift" | "environment" | "flaky"

export interface TestFailure {
  id: string
  cause: FailureCause
  weight: number
}

export interface PlanStep {
  id: string
  text: string
  status: StepStatus
  dependsOn?: string[]
  attempts?: number
  check?: string
  evidence?: Evidence[]
}

export interface Plan {
  id: string
  ts: string
  title: string
  goal: string
  steps: PlanStep[]
  status: PlanStatus
  blockers?: string[]
  acceptance?: { command: string }
}

export interface InjectionReport {
  ts: string
  sessionID: string
  budgetTokens: number
  spentTokens: number
  injected: string[]
  evicted: string[]
}

export interface TokenStats {
  internal: {
    current: number
    byKind: Record<string, number>
    history: { sessionId: string; size: number; timestamp: string }[]
  }
  external: {
    current: number
    history: {
      sessionId: string
      system: number
      messages: number
      tools: number
      timestamp: string
    }[]
  }
  compaction: {
    saved: number
    history: { before: number; after: number; saved: number; timestamp: string }[]
  }
  hitRate: { hits: number; misses: number }
  // Недоступность внешней памяти (agentmemory MCP): отдельный счётчик, НЕ misses
  // инструментов. Опционально — старые сторы без поля валидны (дефолт 0).
  externalMisses?: number
}

export interface ContextStore {
  version: 3
  knowledge: Knowledge[]
  plans: Record<string, Plan>
  lastCompaction: Record<string, string>
  lessons: Lesson[]
  lastInjection: InjectionReport | null
  tokens: TokenStats
  config: { budgetTokens: number; anim: boolean; modelLimit?: number; thresholdSoft?: number; thresholdHard?: number; thresholdEmergency?: number }
  // UC-023: автоопределённый стек (опционально — старые сторы без него валидны).
  stack?: DetectedStack
  // Budget Manager: последний handoff сброса контекста (опционально).
  handoff?: Handoff
}

export type HandoffReason = "soft" | "hard" | "emergency" | "crash"

export interface Handoff {
  ts: string
  sessionId: string
  reason: HandoffReason
  usagePct: number // NaN (в JSON null) = pct неизвестен, сжало без нашего ведома
  summary: string
}

export const DEFAULT_BUDGET_TOKENS = 2000

export function freshTokens(): TokenStats {
  return {
    internal: { current: 0, byKind: {}, history: [] },
    external: { current: 0, history: [] },
    compaction: { saved: 0, history: [] },
    hitRate: { hits: 0, misses: 0 },
    externalMisses: 0,
  }
}

export function freshStore(): ContextStore {
  return {
    version: 3,
    knowledge: [],
    plans: {},
    lastCompaction: {},
    lessons: [],
    lastInjection: null,
    tokens: freshTokens(),
    config: { budgetTokens: DEFAULT_BUDGET_TOKENS, anim: true },
  }
}

function uuid(): string {
  const c = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

export function migrateKnowledge(k: unknown): Knowledge {
  const x = (k ?? {}) as Record<string, unknown>
  const tags = Array.isArray(x["tags"]) ? (x["tags"] as unknown[]) : []
  const labels = Array.isArray(x["labels"]) ? (x["labels"] as string[]) : (tags as string[])
  const kind = x["kind"]
  return {
    id: typeof x["id"] === "string" ? (x["id"] as string) : uuid(),
    ts: typeof x["ts"] === "string" ? (x["ts"] as string) : new Date().toISOString(),
    kind: kind === "decision" || kind === "fact" || kind === "progress" || kind === "blocker" || kind === "digest"
      ? (kind as KnowledgeKind)
      : "fact",
    project: typeof x["project"] === "string" ? (x["project"] as string) : "",
    text: typeof x["text"] === "string" ? (x["text"] as string) : "",
    labels: labels.map(String),
    source: typeof x["source"] === "string" ? (x["source"] as string) : undefined,
    status: x["status"] === "closed" ? "closed" : "open",
    archived: Boolean(x["archived"]),
    thread: Array.isArray(x["thread"])
      ? (x["thread"] as unknown[]).flatMap((v) => {
          if (!v || typeof v !== "object") return []
          const t = v as Record<string, unknown>
          if (typeof t.author !== "string" || typeof t.text !== "string") return []
          return [{ ts: typeof t.ts === "string" ? t.ts : "", author: t.author, text: t.text }]
        })
      : undefined,
  }
}

export function migrateLesson(l: unknown): Lesson {
  const x = (l ?? {}) as Record<string, unknown>
  const tags = Array.isArray(x["tags"]) ? (x["tags"] as unknown[]) : []
  const labels = Array.isArray(x["labels"]) ? (x["labels"] as string[]) : (tags as string[])
  const kind = x["kind"]
  return {
    id: typeof x["id"] === "string" ? (x["id"] as string) : uuid(),
    ts: typeof x["ts"] === "string" ? (x["ts"] as string) : new Date().toISOString(),
    kind: kind === "error" || kind === "success" || kind === "lesson" ? (kind as LessonKind) : "lesson",
    project: typeof x["project"] === "string" ? (x["project"] as string) : "",
    text: typeof x["text"] === "string" ? (x["text"] as string) : "",
    labels: labels.map(String),
  }
}

export function migrateStep(s: unknown): PlanStep {
  const x = (s ?? {}) as Record<string, unknown>
  const st = x["status"]
  const ok: StepStatus =
    st === "todo" || st === "in_progress" || st === "verify_required" || st === "done" || st === "failed"
      ? (st as StepStatus)
      : "todo"
  // v2 had no verify_required separation: done steps without evidence become verify_required
  const evidence = Array.isArray(x["evidence"]) ? (x["evidence"] as Evidence[]) : undefined
  let status = ok
  if (ok === "done" && (!evidence || evidence.length === 0)) status = "verify_required"
  return {
    id: typeof x["id"] === "string" ? (x["id"] as string) : uuid(),
    text: typeof x["text"] === "string" ? (x["text"] as string) : "",
    status,
    dependsOn: Array.isArray(x["dependsOn"]) ? (x["dependsOn"] as string[]) : undefined,
    attempts: typeof x["attempts"] === "number" ? (x["attempts"] as number) : 0,
    check: typeof x["check"] === "string" ? (x["check"] as string) : undefined,
    evidence,
  }
}

export function migratePlan(p: unknown): Plan | null {
  const x = (p ?? {}) as Record<string, unknown>
  if (typeof x["id"] !== "string" || (typeof x["title"] !== "string" && typeof x["goal"] !== "string")) return null
  const stepsRaw = Array.isArray(x["steps"]) ? (x["steps"] as unknown[]) : []
  const steps = stepsRaw.map(migrateStep)
  if (steps.length === 0) return null
  const title = typeof x["title"] === "string" ? (x["title"] as string) : (x["goal"] as string)
  const goal = typeof x["goal"] === "string" ? (x["goal"] as string) : title
  const st = x["status"]
  return {
    id: x["id"] as string,
    ts: typeof x["ts"] === "string" ? (x["ts"] as string) : new Date().toISOString(),
    title,
    goal,
    steps,
    status: st === "done" || st === "blocked" ? (st as PlanStatus) : "active",
    blockers: Array.isArray(x["blockers"]) ? (x["blockers"] as string[]) : undefined,
    acceptance: x["acceptance"] && typeof (x["acceptance"] as Record<string, unknown>)["command"] === "string"
      ? { command: ((x["acceptance"] as Record<string, unknown>)["command"] as string) }
      : typeof x["check"] === "string"
        ? { command: x["check"] as string }
        : undefined,
  }
}

// Миграция v1/v2 -> v3. Повреждённый JSON обрабатывается вызывающим кодом
// (loadStore возвращает freshStore), сюда приходит уже распарсенный объект.
export function migrateStore(parsed: unknown): ContextStore {
  const base = freshStore()
  if (!parsed || typeof parsed !== "object") return base
  const x = parsed as Record<string, unknown>
  if (Array.isArray(x["knowledge"])) base.knowledge = (x["knowledge"] as unknown[]).map(migrateKnowledge)
  if (Array.isArray(x["lessons"])) base.lessons = (x["lessons"] as unknown[]).map(migrateLesson)
  if (x["plans"] && typeof x["plans"] === "object") {
    for (const [id, p] of Object.entries(x["plans"] as Record<string, unknown>)) {
      const m = migratePlan(p)
      if (m) base.plans[id] = m
    }
  }
  if (x["lastCompaction"] && typeof x["lastCompaction"] === "object") {
    base.lastCompaction = x["lastCompaction"] as Record<string, string>
  }
  if (x["lastInjection"] && typeof x["lastInjection"] === "object") {
    base.lastInjection = x["lastInjection"] as InjectionReport
  }
  if (x["tokens"] && typeof x["tokens"] === "object") {
    const t = x["tokens"] as Partial<TokenStats>
    base.tokens = { ...freshTokens(), ...t } as TokenStats
    if (!base.tokens.hitRate) base.tokens.hitRate = { hits: 0, misses: 0 }
  }
  if (x["config"] && typeof x["config"] === "object") {
    const c = x["config"] as Record<string, unknown>
    if (typeof c["budgetTokens"] === "number" && (c["budgetTokens"] as number) > 0) {
      base.config.budgetTokens = Math.round(c["budgetTokens"] as number)
    }
    if (typeof c["anim"] === "boolean") base.config.anim = c["anim"] as boolean
    // Лимит контекста модели (знаменатель Budget Manager). 0/absence = неизвестен.
    if (typeof c["modelLimit"] === "number" && (c["modelLimit"] as number) > 0) {
      base.config.modelLimit = Math.round(c["modelLimit"] as number)
    }
    // Пороги Budget Manager в процентах (опционально, дефолты в thresholdsFrom).
    // allowlist — как modelLimit выше: старые сторы без полей валидны.
    for (const k of ["thresholdSoft", "thresholdHard", "thresholdEmergency"] as const) {
      const v = c[k]
      if (typeof v === "number" && v > 0 && v <= 100) base.config[k] = v
    }
  }
  // UC-023: стек переносим как есть, если форма валидна; иначе пере-детект.
  if (x["stack"] && typeof x["stack"] === "object") {
    const s = x["stack"] as Record<string, unknown>
    const kind = s["stack"]
    if ((kind === "node" || kind === "rust" || kind === "python" || kind === "go" || kind === "php") &&
      typeof s["testCommand"] === "string" && (s["testCommand"] as string).trim() &&
      typeof s["source"] === "string" && typeof s["dir"] === "string") {
      base.stack = {
        stack: kind,
        testCommand: (s["testCommand"] as string).slice(0, 200),
        source: (s["source"] as string).slice(0, 200),
        dir: (s["dir"] as string).slice(0, 200),
        others: Array.isArray(s["others"]) ? (s["others"] as DetectedStack["others"]).slice(0, 5) : [],
        ...(typeof s["note"] === "string" ? { note: (s["note"] as string).slice(0, 200) } : {}),
      }
    }
  }
  // Handoff переносим как есть при валидной форме (образец UC-023 stack);
  // иначе отсутствует. Старые сторы без поля валидны.
  if (x["handoff"] && typeof x["handoff"] === "object") {
    const h = x["handoff"] as Record<string, unknown>
    const reason = h["reason"]
    if (typeof h["sessionId"] === "string" && typeof h["summary"] === "string" &&
      (reason === "soft" || reason === "hard" || reason === "emergency" || reason === "crash") &&
      (typeof h["usagePct"] === "number" || h["usagePct"] === null)) {
      base.handoff = {
        ts: typeof h["ts"] === "string" ? (h["ts"] as string) : "",
        sessionId: h["sessionId"] as string,
        reason: reason as Handoff["reason"],
        usagePct: typeof h["usagePct"] === "number" ? (h["usagePct"] as number) : NaN,
        summary: h["summary"] as string,
      }
    }
  }
  base.version = 3
  return base
}
