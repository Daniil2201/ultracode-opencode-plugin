import { Plugin } from "@opencode/plugin"
import { storeFileFor, updateStoreFile } from "../lib/ultracode/store.ts"
import { redactConfidential } from "../lib/ultracode/confidential.ts"

const THROTTLE_MS = 2000
const OBSERVE_TIMEOUT_MS = 1500
const CONTEXT_TIMEOUT_MS = 750
const MAX_PENDING_CAPTURES = 100
const AGENTMEMORY_INSTRUCTIONS = `<agentmemory-instructions>
Use agentmemory for persistent cross-session context.
- Use agentmemory_memory_recall or agentmemory_memory_smart_search before work needing prior context.
- Use agentmemory_memory_save after stable decisions, bugs, workflows, preferences, or architecture facts.
- Use agentmemory_memory_governance_delete only when user explicitly asks to forget/delete memory.
</agentmemory-instructions>`

export function safeText(value: unknown, max: number): string {
  if (typeof value === "string") return redactConfidential(value).slice(0, max)
  if (value == null) return ""
  try {
    return redactConfidential(JSON.stringify(value)).slice(0, max)
  } catch {
    return redactConfidential(String(value)).slice(0, max)
  }
}

export default Plugin.define({
  id: "ultracode.agentmemory-capture",
  async setup(ctx) {
    const projectPath = ctx.location.project.canonical || ctx.location.project.directory || ctx.location.directory
    const api = process.env.AGENTMEMORY_URL || "http://localhost:3111"
    const secret = process.env.AGENTMEMORY_SECRET || ""
    const debug = process.env.OPENCODE_AGENTMEMORY_DEBUG === "1"
    const activeSessions = new Set<string>()
    const contextInjectedSessions = new Set<string>()
    const lastCapture = new Map<string, number>()
    let pendingCaptures = 0
    let captureQueue = Promise.resolve()

    const headers = (): Record<string, string> => {
      const result: Record<string, string> = { "Content-Type": "application/json" }
      if (secret) result.Authorization = `Bearer ${secret}`
      return result
    }

    const markExternalDown = (): void => {
      try {
        updateStoreFile(storeFileFor(projectPath), (store) => {
          store.tokens.externalMisses = (store.tokens.externalMisses ?? 0) + 1
        })
      } catch {
        // Local metrics must never block a session.
      }
    }

    const post = async (path: string, body: Record<string, unknown>, timeoutMs = 5000): Promise<boolean> => {
      try {
        const response = await fetch(`${api}/agentmemory${path}`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (response.ok) return true
        if (debug) console.error(`[agentmemory] POST ${path} failed: HTTP ${response.status}`)
      } catch (error) {
        if (debug) console.error(`[agentmemory] POST ${path} failed:`, (error as Error).message)
      }
      markExternalDown()
      return false
    }

    const postJson = async (path: string, body: Record<string, unknown>, timeoutMs = CONTEXT_TIMEOUT_MS): Promise<unknown | null> => {
      try {
        const response = await fetch(`${api}/agentmemory${path}`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (response.ok) return response.json()
        if (debug) console.error(`[agentmemory] POST ${path} failed: HTTP ${response.status}`)
      } catch (error) {
        if (debug) console.error(`[agentmemory] POST ${path} failed:`, (error as Error).message)
      }
      markExternalDown()
      return null
    }

    const observe = async (sessionID: string, hookType: string, data: Record<string, unknown>): Promise<void> => {
      await post("/observe", {
        hookType,
        sessionId: sessionID,
        project: projectPath,
        cwd: projectPath,
        timestamp: new Date().toISOString(),
        data,
      }, OBSERVE_TIMEOUT_MS)
    }

    // Телеметрия не должна задерживать prompt/event hooks. Очередь ограничена,
    // чтобы недоступный сервис памяти не накапливал бесконечно замыкания и payload.
    const enqueue = (job: () => Promise<unknown>): boolean => {
      if (pendingCaptures >= MAX_PENDING_CAPTURES) return false
      pendingCaptures += 1
      captureQueue = captureQueue
        .then(() => job().then(() => undefined, () => undefined))
        .finally(() => { pendingCaptures -= 1 })
      return true
    }

    await ctx.session.hook("prompt", async (event) => {
      activeSessions.add(event.sessionID)
      enqueue(() => observe(event.sessionID, "prompt_submit", {
        prompt: safeText(event.prompt.text, 8000),
        files: event.prompt.files?.length ?? 0,
        agents: event.prompt.agents ?? [],
        skills: event.prompt.skills ?? [],
        delivery: event.delivery,
      }))
    })

    await ctx.session.hook("context", async (event) => {
      const sid = event.sessionID
      if (contextInjectedSessions.has(sid)) return
      event.system.push({ type: "text", text: AGENTMEMORY_INSTRUCTIONS })
      const result = await postJson("/context", { sessionId: sid, project: projectPath })
      const context = (result as { context?: unknown } | null)?.context
      if (typeof context === "string" && context.length > 0) {
        event.system.push({ type: "text", text: context })
      }
      contextInjectedSessions.add(sid)
    })

    const handleEvent = async (event: any): Promise<void> => {
      const type = event?.type
      const props = event?.properties || {}
      const fallbackSession = activeSessions.values().next().value as string | undefined

      if (type === "session.created") {
        const info = props.info || {}
        const sid = info.id || props.sessionID
        if (!sid) return
        activeSessions.add(sid)
        contextInjectedSessions.delete(sid)
        enqueue(() => post("/session/start", {
          sessionId: sid,
          title: info.title || null,
          parentID: info.parentID || null,
          version: info.version || null,
          project: projectPath,
          cwd: projectPath,
        }, OBSERVE_TIMEOUT_MS))
        return
      }

      if (type === "session.status") {
        const sid = props.sessionID || fallbackSession
        if (!sid) return
        const status = props.status || {}
        if (status.type === "idle") enqueue(() => post("/summarize", { sessionId: sid }, OBSERVE_TIMEOUT_MS))
        enqueue(() => observe(sid, "session_status", {
          status_type: status.type || null,
          attempt: status.attempt || null,
          message: safeText(status.message, 2000),
        }))
        return
      }

      if (type === "session.deleted") {
        const sid = props.info?.id || props.sessionID || fallbackSession
        if (!sid) return
        enqueue(async () => {
          await post("/session/end", { sessionId: sid }, OBSERVE_TIMEOUT_MS)
          await post("/consolidate-pipeline", { tier: "all", force: true }, 30_000)
        })
        activeSessions.delete(sid)
        contextInjectedSessions.delete(sid)
        return
      }

      if (type === "session.error") {
        const sid = props.sessionID || fallbackSession
        if (!sid) return
        enqueue(() => observe(sid, "post_tool_failure", {
          tool_name: "session.error",
          tool_input: "",
          tool_output: safeText(props.error, 8000),
        }))
        return
      }

      if (type === "message.updated") {
        const info = props.info || {}
        const sid = props.sessionID || info.sessionID || fallbackSession
        if (!sid || info.role !== "assistant") return
        enqueue(() => observe(sid, "assistant_message", {
          messageID: info.id || null,
          parentID: info.parentID || null,
          modelID: info.modelID || null,
          providerID: info.providerID || null,
          cost: info.cost || 0,
          tokens: info.tokens || {},
          finish: info.finish || null,
          error: info.error ? safeText(info.error, 4000) : null,
        }))
        return
      }

      if (type !== "message.part.updated") return
      const part = props.part || {}
      const sid = part.sessionID || props.sessionID || fallbackSession
      if (!sid || part.type !== "tool") return
      if (part.state?.status === "completed") {
        const throttleKey = `${sid}:${part.tool || "unknown"}`
        const now = Date.now()
        if (now - (lastCapture.get(throttleKey) || 0) < THROTTLE_MS) return
        lastCapture.set(throttleKey, now)
        enqueue(() => observe(sid, "post_tool_use", {
          tool_name: part.tool || null,
          call_id: part.callID || null,
          tool_input: safeText(part.state.input, 4000),
          tool_output: safeText(part.state.output, 8000),
          title: part.state.title || null,
          metadata: part.state.metadata || {},
        }))
      } else if (part.state?.status === "error") {
        enqueue(() => observe(sid, "post_tool_failure", {
          tool_name: part.tool || null,
          call_id: part.callID || null,
          tool_input: safeText(part.state.input, 4000),
          tool_output: safeText(part.state.error, 8000),
        }))
      }
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          await handleEvent(event)
        }
      } catch (error) {
        if (!controller.signal.aborted && debug) {
          console.error("[agentmemory] event subscription failed:", (error as Error).message)
        }
      }
    })()

    return () => controller.abort()
  },
})
