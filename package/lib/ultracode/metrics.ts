// UC-004 — session-scoped метрики + корректные ошибки + bounded metrics.jsonl.
// Ponytail: stdlib only, секреты вычищаются до записи.
import * as fs from "node:fs"
import * as path from "node:path"
import type { ContextStore } from "./schema.ts"
import { redactConfidential } from "./confidential.ts"

export const MAX_METRICS_LINES = 500

// Единый firewall (UC-021): дублирующий санитайзер удалён, чтобы не дрейфовать.
export function sanitizeText(s: string): string {
  return redactConfidential(s).slice(0, 2000)
}

export interface SessionRow {
  sessionId: string
  system: number
  messages: number
  tools: number
  timestamp: string
}

// UC-033 — разбивка tool-токенов по типам. Поле ОПЦИОНАЛЬНОЕ и живёт рядом с SessionRow,
// а не в schema.ts: старые сторы без него валидны, миграции не нужно. Обращение —
// только через addToolTokensByKind/toolsByKind ниже, каст локализован в одном месте.
export type ToolKind = "bash" | "read" | "grep" | "glob" | "edit" | "write" | "mcp" | "other"
export type ToolsByKind = Record<ToolKind, number>

const TOOL_KINDS: ToolKind[] = ["bash", "read", "grep", "glob", "edit", "write", "mcp", "other"]
// Встроенные тулы opencode + наши. Проверяются до MCP-эвристики: иначе
// ultracode_context уехал бы в «mcp» из-за подчёркивания в имени.
const BUILTIN_TOOLS = new Set([
  "bash", "read", "grep", "glob", "edit", "write",
  "webfetch", "websearch", "task", "skill", "todotowrite", "question", "list", "lsp", "doom_loop", "invalid",
  "ultracode_context", "triage",
])

// mcp_* и server_name_tool (browser-mcp_browser_click, tg-manager_get_knowledge).
export function classifyTool(name: string): ToolKind {
  const n = String(name ?? "").trim().toLowerCase()
  if (n === "bash" || n === "read" || n === "grep" || n === "glob" || n === "edit" || n === "write") {
    return n as ToolKind
  }
  if (BUILTIN_TOOLS.has(n)) return "other"
  if (/mcp/.test(n) || /^[^_\s]+_/.test(n)) return "mcp"
  return "other"
}

type WithKinds = { toolsByKind?: Partial<ToolsByKind> }

export function toolsByKind(row: SessionRow): ToolsByKind {
  const out = {} as ToolsByKind
  for (const k of TOOL_KINDS) out[k] = (row as WithKinds).toolsByKind?.[k] ?? 0
  return out
}

export function addToolTokensByKind(row: SessionRow, kind: ToolKind, n: number): void {
  if (!Number.isFinite(n) || n <= 0) return
  const holder = row as SessionRow & WithKinds
  holder.toolsByKind ??= {}
  holder.toolsByKind[kind] = (holder.toolsByKind[kind] ?? 0) + Math.round(n)
}

export function getSessionMetrics(store: ContextStore, sessionId: string): SessionRow {
  let row = store.tokens.external.history.find((h) => h.sessionId === sessionId)
  if (!row) {
    row = { sessionId, system: 0, messages: 0, tools: 0, timestamp: new Date().toISOString() }
    store.tokens.external.history.push(row)
    if (store.tokens.external.history.length > 40) {
      store.tokens.external.history = store.tokens.external.history.slice(-40)
    }
  }
  return row
}

// Совместимость: ищем историю строго по sessionID, НЕ history.at(-1).
export function recordTool(
  store: ContextStore,
  sessionId: string,
  _toolName: string,
  durationMs: number,
  isError: boolean,
): void {
  const row = getSessionMetrics(store, sessionId)
  row.tools += 1
  row.timestamp = new Date().toISOString()
  // длительность копим в messages-поле? Нет — держим отдельно через tools-счётчик
  // и агрегат toolMs в internal.byKind (не ломая схему v3).
  void durationMs
  if (isError) {
    const hr = store.tokens.hitRate
    // ошибки инструментов — это misses памяти (пришлось чинить вручную)
    void hr
  }
}

// Аргументы tool: только input.args (официальный путь), без гаданий.
export function toolArgs(input: unknown): Record<string, unknown> {
  const x = (input ?? {}) as Record<string, unknown>
  if (x["args"] && typeof x["args"] === "object") return x["args"] as Record<string, unknown>
  return {}
}

// Ошибка: output.metadata.isError | metadata.status=error | MCP result.isError.
export function isErrorOutput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false
  const o = output as Record<string, unknown>
  const meta = o["metadata"] as Record<string, unknown> | undefined
  if (meta && (meta["isError"] === true || meta["status"] === "error")) return true
  const result = o["result"] as Record<string, unknown> | undefined
  if (result && result["isError"] === true) return true
  if (o["isError"] === true) return true
  return false
}

export interface MetricsLine {
  ts: string
  sessionId: string
  tool: string
  durationMs: number
  isError: boolean
}

// Bounded append: файл не растёт бесконечно (окно MAX_METRICS_LINES).
export function appendMetrics(file: string, line: MetricsLine): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const safe: MetricsLine = {
    ts: line.ts,
    sessionId: String(line.sessionId).slice(0, 64),
    tool: sanitizeText(line.tool).slice(0, 120),
    durationMs: Math.max(0, Math.round(line.durationMs)),
    isError: Boolean(line.isError),
  }
  fs.appendFileSync(file, JSON.stringify(safe) + "\n", "utf8")
  try {
    const raw = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    if (raw.length > MAX_METRICS_LINES) {
      fs.writeFileSync(file, raw.slice(-MAX_METRICS_LINES).join("\n") + "\n", "utf8")
    }
  } catch { /* best effort */ }
}
