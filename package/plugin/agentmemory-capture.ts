import type { Plugin } from "@opencode-ai/plugin"
import { storeFileFor, updateStoreFile } from "../lib/ultracode/store.ts"

declare const process: {
  cwd(): string
  env: Record<string, string | undefined>
}

const API = process.env.AGENTMEMORY_URL || "http://localhost:3111"
const SECRET = process.env.AGENTMEMORY_SECRET || ""
const DEBUG = process.env.OPENCODE_AGENTMEMORY_DEBUG === "1"

let activeSessionId: string | null = null
let projectPath = process.cwd()
const contextInjectedSessions = new Set<string>()

const THROTTLE_MS = 2000
const lastCapture = new Map<string, number>()

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" }
  if (SECRET) h.Authorization = `Bearer ${SECRET}`
  return h
}

async function post(path: string, body: Record<string, unknown>, timeoutMs = 5000): Promise<void> {
  try {
    await fetch(`${API}/agentmemory${path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (DEBUG) console.error(`[agentmemory] POST ${path} failed:`, (error as Error).message)
    markExternalDown() // /observe и прочие: провал виден в stats, сессия продолжается
  }
}

async function postJson(path: string, body: Record<string, unknown>): Promise<unknown | null> {
  try {
    const response = await fetch(`${API}/agentmemory${path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })

    return response.ok ? response.json() : null
  } catch (error) {
    if (DEBUG) console.error(`[agentmemory] POST ${path} failed:`, (error as Error).message)
    return null
  }
}

function safeText(value: unknown, max: number): string {
  if (typeof value === "string") return value.slice(0, max)
  if (value == null) return ""
  try {
    return JSON.stringify(value).slice(0, max)
  } catch {
    return String(value).slice(0, max)
  }
}

// Видимый счётчик недоступности внешней памяти. Отдельно от hitRate.misses
// (тот — про неуспешный локальный поиск/инструменты). Опциональное поле,
// старые сторы валидны (дефолт 0 из freshTokens).
function markExternalDown(): void {
  try {
    updateStoreFile(storeFileFor(projectPath), (s) => {
      s.tokens.externalMisses = (s.tokens.externalMisses ?? 0) + 1
    })
  } catch { /* стор недоступен — не блокируем сессию */ }
}

async function observe(
  sessionId: string,
  hookType: string,
  data: Record<string, unknown>,
): Promise<void> {
  await post("/observe", {
    hookType,
    sessionId,
    project: projectPath,
    cwd: projectPath,
    timestamp: new Date().toISOString(),
    data,
  })
}

const AGENTMEMORY_INSTRUCTIONS = `<agentmemory-instructions>
Use agentmemory for persistent cross-session context.
- Use agentmemory_memory_recall or agentmemory_memory_smart_search before work needing prior context.
- Use agentmemory_memory_save after stable decisions, bugs, workflows, preferences, or architecture facts.
- Use agentmemory_memory_governance_delete only when user explicitly asks to forget/delete memory.
</agentmemory-instructions>`

export default (async (ctx) => {
  projectPath = (ctx as any).worktree || (ctx as any).project?.id || process.cwd()

  return {
    event: async ({ event }) => {
      const type = (event as any).type
      const props = (event as any).properties || {}

      if (type === "session.created") {
        const info = props.info || {}
        activeSessionId = info.id || props.sessionID || null
        if (!activeSessionId) return

        contextInjectedSessions.delete(activeSessionId)
        await post("/session/start", {
          sessionId: activeSessionId,
          title: info.title || null,
          parentID: info.parentID || null,
          version: info.version || null,
          project: projectPath,
          cwd: projectPath,
        })
        return
      }

      if (type === "session.status") {
        const sid = props.sessionID || activeSessionId
        const status = props.status || {}
        if (!sid) return

        if (status.type === "idle") await post("/summarize", { sessionId: sid })
        await observe(sid, "session_status", {
          status_type: status.type || null,
          attempt: status.attempt || null,
          message: safeText(status.message, 2000),
        })
        return
      }

      if (type === "session.deleted") {
        const sid = props.info?.id || props.sessionID || activeSessionId
        if (!sid) return

        await post("/session/end", { sessionId: sid })
        await post("/consolidate-pipeline", { tier: "all", force: true }, 30000)
        contextInjectedSessions.delete(sid)
        if (sid === activeSessionId) activeSessionId = null
        return
      }

      if (type === "session.error") {
        const sid = props.sessionID || activeSessionId
        if (!sid) return

        await observe(sid, "post_tool_failure", {
          tool_name: "session.error",
          tool_input: "",
          tool_output: safeText(props.error, 8000),
        })
        return
      }

      if (type === "message.updated") {
        const info = props.info || {}
        const sid = props.sessionID || info.sessionID || activeSessionId
        if (!sid || info.role !== "assistant") return

        await observe(sid, "assistant_message", {
          messageID: info.id || null,
          parentID: info.parentID || null,
          modelID: info.modelID || null,
          providerID: info.providerID || null,
          cost: info.cost || 0,
          tokens: info.tokens || {},
          finish: info.finish || null,
          error: info.error ? safeText(info.error, 4000) : null,
        })
        return
      }

      if (type === "message.part.updated") {
        const part = props.part || {}
        const sid = part.sessionID || props.sessionID || activeSessionId
        if (!sid) return

        if (part.type === "tool" && part.state?.status === "completed") {
          const toolName = part.tool || "unknown"
          const now = Date.now()
          const last = lastCapture.get(toolName) || 0
          if (now - last < THROTTLE_MS) return
          lastCapture.set(toolName, now)

          await observe(sid, "post_tool_use", {
            tool_name: part.tool || null,
            call_id: part.callID || null,
            tool_input: safeText(part.state.input, 4000),
            tool_output: safeText(part.state.output, 8000),
            title: part.state.title || null,
            metadata: part.state.metadata || {},
          })
          return
        }

        if (part.type === "tool" && part.state?.status === "error") {
          await observe(sid, "post_tool_failure", {
            tool_name: part.tool || null,
            call_id: part.callID || null,
            tool_input: safeText(part.state.input, 4000),
            tool_output: safeText(part.state.error, 8000),
          })
          return
        }
      }
    },

    "chat.message": async (input, output) => {
      const sid = (input as any).sessionID || activeSessionId
      if (!sid) return

      const parts = (output as any).parts || []
      const prompt = parts
        .filter((part: any) => part.type === "text" && !part.synthetic && !part.ignored)
        .map((part: any) => part.text || "")
        .join("\n")

      await observe(sid, "prompt_submit", {
        agent: (input as any).agent || null,
        model: (input as any).model || null,
        prompt: prompt.slice(0, 8000),
        parts_summary: parts.map((part: any) => part.type).filter(Boolean),
      })
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sid = (input as any).sessionID || activeSessionId
      if (!sid || contextInjectedSessions.has(sid) || !Array.isArray((output as any).system)) return

      ;(output as any).system.push(AGENTMEMORY_INSTRUCTIONS)
      const result = await postJson("/context", { sessionId: sid, project: projectPath })
      const context = (result as any)?.context
      if (typeof context === "string" && context.length > 0) {
        ;(output as any).system.push(context)
      } else {
        // внешняя память недоступна/пуста — видимый промах в локальном сторе,
        // а не тишина: stats покажет externalMisses, сессия продолжается на store.ts.
        // (postJson вернул null и на HTTP-ошибку, и на сетевой провал — ровно +1.)
        markExternalDown()
      }
      contextInjectedSessions.add(sid)
    },
  }
}) satisfies Plugin
