// context-pruner: сжатие истории сообщений перед отправкой в LLM.
//
// Чистый модуль — без I/O, времени и случайности. Массив сообщений в opencode
// каждый ход пересобирается заново из полного транскрипта, значит сжатие обязано
// быть функцией от (messages, level), а не накопленным состоянием.
//
// Результат пробрасывается мутацией на месте (applyPrune): переприсваивание
// output.messages НЕ работает — вызывающий читает локальную переменную.
// Уровень приходит из budget.evaluate(), своих порогов здесь нет.
// Запреты и проверенные факты: spec/context-pruner.md.
import type { BudgetLevel } from "./budget.ts"

export type PruneLevel = "off" | "soft" | "hard" | "emergency"

// Прикасаться нельзя ни на одном уровне, включая dedupe: вызовы этих тулов —
// запись решений, повторов не бывает, а потеря = потеря рассуждения.
export const PROTECTED_TOOLS: readonly string[] = ["task", "skill", "ultracode_context"]

export const KEEP_HEAD = 800
export const KEEP_TAIL = 800
export const TRUNCATE_HEAD = 400
export const PROTECT_RECENT = 2
// Не измерен на реальной сессии (открытый вопрос №1 в spec) — conservative.
// Правится одним числом здесь, не миграцией схемы.
export const PRUNE_EPOCH_TURNS = 5

// Уровень бюджета -> уровень сжатия. "ok" = не сжимать.
export function levelFor(level: BudgetLevel): PruneLevel {
  return level === "ok" ? "off" : level
}

export type PruneActionKind = "dedupe" | "purge-error" | "supersede" | "collapse-bash" | "truncate"

export interface PruneAction {
  kind: PruneActionKind
  messageID: string
  partID: string
  tool: string
  charsBefore: number
  charsAfter: number
}

export interface PruneReport {
  level: PruneLevel
  actions: PruneAction[]
  // Считаются по содержимому tool-part (output + error) — ровно то, что жмёт pruner.
  charsBefore: number
  charsAfter: number
}

// Минимальные структурные типы: info.id/role/sessionID, parts[].id/type/callID/
// tool/text и state.status/error/output/input/metadata. Импортов из SDK нет —
// lib/ultracode/ не зависит от @opencode-ai/*.
export interface PrunableState {
  status?: string
  error?: string
  output?: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface PrunablePart {
  id?: string
  type?: string
  callID?: string
  tool?: string
  text?: string
  state?: PrunableState | null
  [k: string]: unknown
}

export interface PrunableMessage {
  info?: { id?: string; role?: string; sessionID?: string }
  parts?: PrunablePart[]
  [k: string]: unknown
}

export interface PruneOptions {
  pinned?: ReadonlySet<string>
  protectRecent?: number
}

// ─── плейсхолдер ────────────────────────────────────────────────────
// Модель должна видеть, что контент существует и как его вернуть, иначе
// начинает гадать. Детерминированно: без времени и хешей от времени.
// ref — всегда та пара (messageID, partID), для которой в стор лёг оригинал,
// поэтому recall_pruned по строке из плейсхолдера всегда что-то найдёт.
export function placeholder(
  kind: PruneActionKind,
  tool: string,
  charsBefore: number,
  charsAfter: number,
  ref: { messageID: string; partID: string },
): string {
  return `[pruned ${kind}: ${tool}] ${charsBefore}→${charsAfter} симв. Оригинал: recall_pruned messageId="${ref.messageID}" partId="${ref.partID}"`
}

function toolOf(p: PrunablePart): string {
  return typeof p.tool === "string" ? p.tool : ""
}

// Туловый part = есть state (ответ/ошибка) и имя тула. Всё остальное (текст,
// reasoning, step-маркеры) pruner не жмёт.
function isToolPart(p: PrunablePart | null | undefined): p is PrunablePart {
  return !!p && typeof p === "object" && p.state != null && typeof p.state === "object" && toolOf(p) !== ""
}

function outputOf(p: PrunablePart): string {
  const o = p.state?.output
  return typeof o === "string" ? o : ""
}

function errorOf(p: PrunablePart): string {
  const e = p.state?.error
  return typeof e === "string" ? e : ""
}

function contentLen(p: PrunablePart): number {
  return outputOf(p).length + errorOf(p).length
}

function isProtectedTool(tool: string): boolean {
  return PROTECTED_TOOLS.includes(tool)
}

// Новый part с плейсхолдером. Исходный объект не мутируется: транскрипт
// пересобирается каждый ход, общий part-объект уехал бы в стор под другим id.
function replacedPart(p: PrunablePart, output: string, kind: PruneActionKind, clearError = false): PrunablePart {
  const state = p.state as PrunableState
  return {
    ...p,
    state: {
      ...state,
      output,
      metadata: { ...(state.metadata ?? {}), ultracodePruned: kind },
      ...(clearError ? { error: "" } : {}),
    },
  }
}

function inputKey(p: PrunablePart): string {
  const input = p.state?.input
  try {
    return JSON.stringify(input ?? null)
  } catch {
    // Несериализуемый input (цикл/функция) — дедупе не мешает, но и не ломает хук.
    return ""
  }
}

// Ключ «того же самого места» для supersede: записи одного пути/команды.
function targetKey(p: PrunablePart): string | null {
  const input = (p.state?.input ?? {}) as Record<string, unknown>
  for (const k of ["filePath", "path", "patch", "command"] as const) {
    const v = input[k]
    if (typeof v === "string" && v !== "") return v
  }
  return null
}

const isBash = (tool: string): boolean => tool === "bash" || tool === "shell" || tool === "Bash"

// Индекс первого защищённого сообщения: последние protectRecent user-сообщений
// и всё после них. Прецедент — нативный SessionCompaction.prune тоже не трогает
// последние ходы.
function protectedFrom(messages: readonly PrunableMessage[], protectRecent: number): number {
  if (protectRecent <= 0) return messages.length
  const users: number[] = []
  messages.forEach((m, i) => {
    if (m?.info?.role === "user") users.push(i)
  })
  if (users.length <= protectRecent) return 0
  return users[users.length - protectRecent] as number
}

interface Edit {
  kind: PruneActionKind
  output: string
  clearError: boolean
  charsBefore: number
  charsAfter: number
}

interface Candidate {
  mi: number
  pi: number
  part: PrunablePart
}

// Единственный источник оригинала для стора: до prune ещё жива ссылка на
// pre-prune сообщения (их читает хук, пока не вызвал applyPrune). Ошибка и
// output склеиваются: у части могут быть оба, а purge-error чистит error —
// без склейки текст ошибки исчез бы и из контекста, и из стора.
export function originalContent(messages: readonly PrunableMessage[], messageID: string, partID: string): string {
  for (const m of messages) {
    if (m?.info?.id !== messageID) continue
    for (const p of m.parts ?? []) {
      if (p?.id !== partID) continue
      const out = outputOf(p)
      const err = errorOf(p)
      if (out !== "" && err !== "") return `${out}\n${err}`
      return out !== "" ? out : err
    }
  }
  return ""
}

// Пять преобразований, каскад по уровню: soft ⊂ hard ⊂ emergency.
// Чистая функция: тот же вход — тот же выход, побайтово.
export function planPrune(
  messages: readonly PrunableMessage[],
  level: PruneLevel,
  opts: PruneOptions = {},
): { messages: PrunableMessage[]; report: PruneReport } {
  const report: PruneReport = { level, actions: [], charsBefore: 0, charsAfter: 0 }
  const list = Array.isArray(messages) ? messages : []
  report.charsBefore = totalContent(list)
  if (level === "off" || list.length === 0) {
    report.charsAfter = report.charsBefore
    return { messages: list.slice(), report }
  }

  const pinned = opts.pinned ?? new Set<string>()
  const cutoff = protectedFrom(list, opts.protectRecent ?? PROTECT_RECENT)

  // Собираем кандидатов: вне защищённого окна, не защищённый тул, не пин.
  const cands: Candidate[] = []
  list.forEach((m, mi) => {
    if (mi >= cutoff) return
    const mid = typeof m?.info?.id === "string" ? m.info.id : ""
    if (pinned.has(mid)) return
    const parts = Array.isArray(m?.parts) ? m.parts : []
    parts.forEach((p, pi) => {
      if (isToolPart(p) && !isProtectedTool(toolOf(p))) cands.push({ mi, pi, part: p })
    })
  })

  const edits = new Map<number, Map<number, Edit>>()
  // charsAfter — сколько символов контента осталось (0 = содержимое убрано,
  // остался только плейсхолдер). То же число печатается внутри плейсхолдера.
  const plan = (c: Candidate, kind: PruneActionKind, output: string, after: number, clearError = false): void => {
    let perMessage = edits.get(c.mi)
    if (!perMessage) {
      perMessage = new Map<number, Edit>()
      edits.set(c.mi, perMessage)
    }
    // Одно правило на part: правило с большим приоритетом уже сжало — не трогаем.
    if (perMessage.has(c.pi)) return
    perMessage.set(c.pi, {
      kind,
      output,
      clearError,
      charsBefore: contentLen(c.part),
      charsAfter: after,
    })
  }
  const planned = (mi: number, pi: number): boolean => edits.get(mi)?.has(pi) === true
  const ref = (c: Candidate): { messageID: string; partID: string } => ({
    messageID: String(list[c.mi]?.info?.id ?? ""),
    partID: String(c.part.id ?? ""),
  })

  // 1. purge-error (soft): стек-трейсы провайдера в контексте не нужны, но
  //    сообщение «тул падал» остаётся — плейсхолдер с именем тула.
  for (const c of cands) {
    if (c.part.state?.status !== "error") continue
    const err = errorOf(c.part)
    if (err === "") continue
    const t = toolOf(c.part)
    plan(c, "purge-error", placeholder("purge-error", t, err.length, 0, ref(c)), 0, true)
  }

  // 2. dedupe (soft): одинаковые tool+input — все, кроме последнего.
  {
    const groups = new Map<string, Candidate[]>()
    for (const c of cands) {
      if (planned(c.mi, c.pi)) continue
      const k = `${toolOf(c.part)}\u0000${inputKey(c.part)}`
      const g = groups.get(k)
      if (g) g.push(c)
      else groups.set(k, [c])
    }
    for (const g of groups.values()) {
      for (let i = 0; i < g.length - 1; i++) {
        const c = g[i] as Candidate
        const t = toolOf(c.part)
        const before = contentLen(c.part)
        plan(c, "dedupe", placeholder("dedupe", t, before, 0, ref(c)), 0)
      }
    }
  }

  // 3. supersede (hard): несколько записей одного пути/команды — все, кроме
  //    последней. Плейсхолдер ссылается на САМ сжатый part (его оригинал лежит
  //    в сторе), актуальная версия называется рядом словами: recall по её id
  //    нечего возвращать — она и так в контексте.
  if (level === "hard" || level === "emergency") {
    const groups = new Map<string, Candidate[]>()
    for (const c of cands) {
      if (planned(c.mi, c.pi)) continue
      const target = targetKey(c.part)
      if (target === null) continue
      const k = `${toolOf(c.part)}\u0000${target}`
      const g = groups.get(k)
      if (g) g.push(c)
      else groups.set(k, [c])
    }
    for (const g of groups.values()) {
      const last = g[g.length - 1] as Candidate
      const note = `Актуальная версия: ${toolOf(last.part)} в partId="${String(last.part.id ?? "")}" (в этом же сообщении)`
      for (let i = 0; i < g.length - 1; i++) {
        const c = g[i] as Candidate
        const t = toolOf(c.part)
        const before = contentLen(c.part)
        plan(c, "supersede", `${placeholder("supersede", t, before, 0, ref(c))}\n${note}`, 0)
      }
    }
  }

  // 4. collapse-bash (hard): голова+хвост лога, elision — плейсхолдер.
  //    На emergency не каскадит: там truncate (400) сильнее и дешевле.
  if (level === "hard") {
    for (const c of cands) {
      if (planned(c.mi, c.pi)) continue
      if (!isBash(toolOf(c.part))) continue
      const out = outputOf(c.part)
      if (out.length <= KEEP_HEAD + KEEP_TAIL) continue
      const ph = placeholder("collapse-bash", toolOf(c.part), out.length, KEEP_HEAD + KEEP_TAIL, ref(c))
      plan(c, "collapse-bash", `${out.slice(0, KEEP_HEAD)}\n${ph}\n${out.slice(out.length - KEEP_TAIL)}`, KEEP_HEAD + KEEP_TAIL)
    }
  }

  // 5. truncate (emergency): дальний горизонт — первые TRUNCATE_HEAD символов
  //    плюс строка плейсхолдера. Маркер обязателен: без него модель видит
  //    обрыв и не знает, что хвост лежит в сторе и достаётся одним вызовом.
  if (level === "emergency") {
    for (const c of cands) {
      if (planned(c.mi, c.pi)) continue
      const out = outputOf(c.part)
      if (out.length <= TRUNCATE_HEAD) continue
      const head = out.slice(0, TRUNCATE_HEAD)
      plan(c, "truncate", `${head}\n${placeholder("truncate", toolOf(c.part), out.length, TRUNCATE_HEAD, ref(c))}`, TRUNCATE_HEAD)
    }
  }

  // Сборка: нетронутые сообщения сохраняют идентичность, сжатые — новые part.
  const result: PrunableMessage[] = []
  list.forEach((m, mi) => {
    const perMessage = edits.get(mi)
    if (!perMessage) {
      result.push(m)
      return
    }
    const parts = Array.isArray(m?.parts) ? m.parts.slice() : []
    parts.forEach((p, pi) => {
      const e = perMessage.get(pi)
      if (!e) return
      parts[pi] = replacedPart(p, e.output, e.kind, e.clearError)
      report.actions.push({
        kind: e.kind,
        messageID: String(m?.info?.id ?? ""),
        partID: String(p?.id ?? ""),
        tool: toolOf(p),
        charsBefore: e.charsBefore,
        charsAfter: e.charsAfter,
      })
    })
    result.push({ ...m, parts })
  })

  report.charsAfter = totalContent(result)
  return { messages: result, report }
}

function totalContent(messages: readonly PrunableMessage[]): number {
  let n = 0
  for (const m of messages) {
    for (const p of m?.parts ?? []) {
      if (isToolPart(p)) n += contentLen(p)
    }
  }
  return n
}

// Мутация на месте — единственный способ пробрать результат в opencode.
// Длина и порядок сохраняются: ни один tool-part не удаляется (контракт
// tool_use/tool_result), правится только содержимое.
export function applyPrune(output: { messages: unknown[] }, result: { messages: PrunableMessage[] }): void {
  const target = output?.messages
  const next = result?.messages
  if (!Array.isArray(target) || !Array.isArray(next)) return
  const n = Math.min(target.length, next.length)
  for (let i = 0; i < n; i++) target[i] = next[i]
  if (next.length > target.length) target.push(...next.slice(target.length))
  else if (next.length < target.length) target.length = next.length
}
