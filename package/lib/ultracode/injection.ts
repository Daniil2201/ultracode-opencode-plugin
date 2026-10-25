// UC-003 — идемпотентная инъекция + раздельные бюджеты.
// Подсчёт токенов — единый модуль ./tokens.ts (реальный cl100k_base + fallback).
// Ранжирование переехало сюда из plugin/ultracode.ts (Фаза 4, R.5): единый путь
// сборки контекста. Старый строковый renderInjection оставлен для совместимости.
import { tokens } from "./tokens.ts"
import { redactConfidential } from "./confidential.ts"
import type { Knowledge, Lesson, Plan } from "./schema.ts"

export { tokens }
export { countTokens, isRealTokenizer, heuristicTokens } from "./tokens.ts"
export const INJECTION_VERSION = "v3"

export interface InjectionBudgets {
  knowledge: number
  lessons: number
  plan: number
  farm: number
}

export const DEFAULT_BUDGETS: InjectionBudgets = {
  knowledge: 1100,
  lessons: 400,
  plan: 300,
  farm: 200,
}

export function markerFor(sessionId: string): string {
  return `<!-- ultracode:${INJECTION_VERSION}:${sessionId} -->`
}

export function hasMarker(system: string[], sessionId: string): boolean {
  const m = markerFor(sessionId)
  return system.some((item) => typeof item === "string" && item.includes(m))
}

// Идемпотентность: повторный transform той же сессии не дублирует блок.
export function injectOnce(system: string[], sessionId: string, text: string): void {
  if (hasMarker(system, sessionId)) return
  system.push(`${markerFor(sessionId)}\n${text}`)
}

export function truncateToBudget(text: string, budgetTokens: number): { text: string; truncated: boolean } {
  const t = tokens(text)
  if (t <= budgetTokens) return { text, truncated: false }
  // режем по символам пропорционально бюджету
  const maxChars = Math.max(0, budgetTokens * 4)
  return { text: text.slice(0, maxChars), truncated: true }
}

// Раздельные бюджеты: каждая секция режется своим лимитом, общий бюджет не превышается.
export function renderInjection(
  parts: { knowledge?: string; lessons?: string; plan?: string; farm?: string },
  budgets: InjectionBudgets = DEFAULT_BUDGETS,
): { text: string; truncated: Record<keyof InjectionBudgets, boolean>; spentTokens: number; budgetTokens: number } {
  const out: string[] = []
  const truncated = { knowledge: false, lessons: false, plan: false, farm: false }
  let spent = 0
  const push = (key: keyof InjectionBudgets, title: string, body?: string) => {
    if (!body) return
    const r = truncateToBudget(body, budgets[key])
    truncated[key] = r.truncated
    spent += tokens(r.text)
    out.push(`<ultracode-${title}>\n${r.text}\n</ultracode-${title}>`)
  }
  push("knowledge", "knowledge", parts.knowledge)
  push("lessons", "lessons", parts.lessons)
  push("plan", "plan", parts.plan)
  push("farm", "farm", parts.farm)
  const budgetTokens = budgets.knowledge + budgets.lessons + budgets.plan + budgets.farm
  return { text: out.join("\n"), truncated, spentTokens: spent, budgetTokens }
}

// ─── единый путь сборки (Фаза 4): ранжирование + доли бюджета ──────────
// DEFAULT_BUDGETS — пропорции сплита, не жёсткие числа: реальная сумма из
// store.config.budgetTokens. Доля секции — минимум 1 токен (схлопывания в 0 нет).

const SHARE_SUM =
  DEFAULT_BUDGETS.knowledge + DEFAULT_BUDGETS.lessons + DEFAULT_BUDGETS.plan + DEFAULT_BUDGETS.farm

function share(totalBudget: number, part: number): number {
  return Math.max(1, Math.round((Math.max(4, Math.round(totalBudget)) * part) / SHARE_SUM))
}

// Вес типа записи + вес метки → приоритет в инъекцию (перенесено из плагина как есть).
const KIND_WEIGHT: Record<string, number> = {
  digest: 0.3, // выжимки — ниже свежих фактов
  progress: 0.5,
  fact: 0.7,
  blocker: 1.0, // блокеры — выше: это грабли, на которые нельзя наступать
  decision: 1.2, // решения — выше всего: их переопределять дорого
}
const LABEL_WEIGHT: Record<string, number> = {
  "error": 2.0,
  "plan": 1.5,
  "manual": 1.0,
  "farm": 0.8,
}

// Сколько токенов потратить на кандидата (текст + 2 служебных).
export function entryTokens(k: { text: string; kind: string }): number {
  return tokens(k.text) + 2
}

export function scoreKnowledge(k: Knowledge, projectPath: string, queryTokens: string[]): number {
  let score = KIND_WEIGHT[k.kind] ?? 0.4
  // метки: весомые повышают, + совпадение с текущей задачей
  for (const label of k.labels) {
    score += LABEL_WEIGHT[label] ?? 0.1
    if (queryTokens.some((q) => q && label.includes(q))) score += 1.0
  }
  // свежесть: экспоненциальное затухание по возрасту
  const ageDays = (Date.now() - new Date(k.ts).getTime()) / 86400000
  score *= Math.exp(-ageDays / 30) // ~полураспад: месяц
  // недавние записи и блокеры всегда выше архивных
  if (k.archived) score *= 0.3
  // Скоуп записи (UC-032): свой проект — полный вес; глобальные (project "/"
  // или пустой) — 0.3. Чужие проекты сюда не попадают: их отсекает фильтр в
  // pickKnowledge.
  if (k.project === projectPath) score *= 1.0
  else if (k.project === "/" || k.project === "") score *= 0.3
  return score
}

export interface RenderInput {
  knowledge: Knowledge[]
  lessons: Lesson[]
  plans: Plan[]
  farm?: string
  project: string
}

export interface Section {
  name: "knowledge" | "lessons" | "plans" | "farm"
  text: string
  tokens: number
  truncated: boolean
}

export interface SectionsResult {
  sections: Section[]
  totalTokens: number
  budgetTokens: number
  injected: string[]
  evicted: string[]
  truncated: Record<"knowledge" | "lessons" | "plan" | "farm", boolean>
}

// Ранжированный отбор знаний в бюджет секции (бывший contextSnippet из плагина).
export function pickKnowledge(
  list: Knowledge[],
  project: string,
  budget: number,
): { text: string; spent: number; injected: string[]; evicted: string[]; truncated: boolean } {
  // Изоляция по project (UC-032): свои + глобальные ("/", пустой). Чужие
  // проекты не рендерятся вообще — раньше любые fact/decision проходили.
  const relevant = list.filter(
    (k) => k.status !== "closed" && (k.project === project || k.project === "/" || k.project === ""),
  )
  const scored = relevant
    .map((k) => ({ k, score: scoreKnowledge(k, project, []) }))
    .sort((a, b) => b.score - a.score)
  let remaining = budget
  const picked: Knowledge[] = []
  const injected: string[] = []
  const evicted: string[] = []
  for (const { k } of scored) {
    const t = entryTokens(k)
    if (remaining - t < 0) {
      evicted.push(k.id)
      continue
    }
    remaining -= t
    picked.push(k)
    injected.push(k.id)
  }
  const spent = budget - remaining
  evicted.push(...list.filter((k) => k.status === "closed").map((k) => k.id))
  if (picked.length === 0) return { text: "", spent: 0, injected, evicted, truncated: relevant.length > 0 }
  // GitHub-style: бейджи меток, источник-цитата, тред (защитная нарезка — как было).
  const lines = picked.map((k) => {
    const labels = k.labels.map((l) => `#${l}`).join(" ")
    const src = k.source ? ` \`${k.source}\`` : ""
    const thread = k.thread?.length
      ? `\n   ▪ ${k.thread.map((c) => `${c.author}: ${c.text.slice(0, 80)}`).join(" · ")}`
      : ""
    return `- [${k.kind}]${labels} ${k.text.slice(0, 300)}${src}${thread}`
  })
  // Pentest M6: re-redact на чтении — defense in depth (сниппет идёт в модель).
  const text = redactConfidential([
    `> контекст: ${injected.length} записей / ~${spent} токенов (бюджет ${budget})`,
    ...lines,
  ].join("\n"))
  const r = truncateToBudget(text, budget)
  // ужато = символьная резка ИЛИ отсев записей (evicted непуст)
  return { text: r.text, spent: tokens(r.text), injected, evicted, truncated: r.truncated || evicted.length > 0 }
}

// Отбор уроков в бюджет секции (бывший lessonsSnippet из плагина).
export function pickLessons(
  list: Lesson[],
  project: string,
  budget: number,
): { text: string; spent: number; truncated: boolean } {
  const relevant = list.filter((l) => l.project === project)
  if (relevant.length === 0) return { text: "", spent: 0, truncated: false }
  // последние уроки в пределах бюджета
  let remaining = budget
  const picked: Lesson[] = []
  for (const l of relevant.slice(-16).reverse()) {
    const t = tokens(l.text)
    if (remaining - t < 0) break
    remaining -= t
    picked.push(l)
  }
  if (picked.length === 0) return { text: "", spent: 0, truncated: true }
  // Pentest M6: re-redact на чтении.
  const text = redactConfidential(picked.map((l) => `- [${l.kind}] ${l.text}`).join("\n"))
  const r = truncateToBudget(text, budget)
  // ужато = символьная резка ИЛИ отсев уроков
  return { text: r.text, spent: tokens(r.text), truncated: r.truncated || picked.length < relevant.length }
}

// Компактный листинг планов в бюджет секции (раньше планы только считались,
// в системный промпт не попадали — теперь секция по порядку R.5).
export function renderPlans(
  plans: Plan[],
  budget: number,
): { text: string; spent: number; truncated: boolean } {
  if (plans.length === 0) return { text: "", spent: 0, truncated: false }
  const lines = plans.slice(-8).map((p) => {
    const done = p.steps.filter((s) => s.status === "done").length
    const cur = p.steps.find((s) => s.status === "in_progress")?.id ?? "none"
    return `- [plan ${p.id}] ${p.goal.slice(0, 120)} (steps ${done}/${p.steps.length}, ${p.status}, current ${cur})`
  })
  const r = truncateToBudget(lines.join("\n"), budget)
  return { text: r.text, spent: tokens(r.text), truncated: r.truncated }
}

export function renderSections(input: RenderInput, totalBudget: number): SectionsResult {
  const total = Math.max(4, Math.round(totalBudget))
  const k = pickKnowledge(input.knowledge, input.project, share(total, DEFAULT_BUDGETS.knowledge))
  const l = pickLessons(input.lessons, input.project, share(total, DEFAULT_BUDGETS.lessons))
  const p = renderPlans(input.plans, share(total, DEFAULT_BUDGETS.plan))
  const f = input.farm
    ? truncateToBudget(input.farm, share(total, DEFAULT_BUDGETS.farm))
    : { text: "", truncated: false }
  const farmTokens = f.text ? tokens(f.text) : 0
  const sections: Section[] = [
    { name: "knowledge", text: k.text, tokens: k.spent, truncated: k.truncated },
    { name: "lessons", text: l.text, tokens: l.spent, truncated: l.truncated },
    { name: "plans", text: p.text, tokens: p.spent, truncated: p.truncated },
    { name: "farm", text: f.text, tokens: farmTokens, truncated: f.truncated },
  ]
  return {
    sections,
    totalTokens: k.spent + l.spent + p.spent + farmTokens,
    budgetTokens: total,
    injected: k.injected,
    evicted: k.evicted,
    truncated: { knowledge: k.truncated, lessons: l.truncated, plan: p.truncated, farm: f.truncated },
  }
}
