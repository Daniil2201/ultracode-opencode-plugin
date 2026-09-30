// UC-017 fixtures: изолированный runtime — отдельный XDG_DATA_HOME + project dir,
// настоящий execute() плагина (тот же модуль, что грузит opencode), персистентный store-файл.
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface Runtime {
  dir: string
  project: string
  callTool: (args: Record<string, unknown>) => Promise<string>
  callToolNamed: (name: string, args: Record<string, unknown>, sessionID?: string) => Promise<string>
  tools: () => string[]
  chatMessage: (text: string) => Promise<void>
  systemTransform: (system: string[]) => Promise<string[]>
  // Хук context-pruner: массив на входе мутируется на месте, возвращается тот же.
  messagesTransform: (messages: unknown[]) => Promise<unknown[]>
  compactSession: (sessionID: string) => Promise<void>
  // Событие плагина (message.updated с tokens.total -> budget manager).
  sendEvent: (event: unknown) => Promise<void>
  storeFile: () => string
  readStoreRaw: () => string
  reload: () => Promise<Runtime>
  reopen: () => Promise<Pick<Runtime, "callTool" | "readStoreRaw" | "storeFile">>
  cleanup: () => void
}

function fakeContext(): Record<string, unknown> {
  return {
    sessionID: "lab-session",
    messageID: "m1",
    agent: "lab",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

export async function makeRuntime(opts?: { config?: Record<string, unknown> }): Promise<Runtime> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-lab-"))
  const project = path.join(dir, "proj")
  fs.mkdirSync(project, { recursive: true })
  process.env.XDG_DATA_HOME = path.join(dir, "xdg")
  // Конфиг стора задаётся ДО загрузки плагина: modelLimit и пороги приходят из
  // context.json, иначе budget всегда «ok» (лимит неизвестен).
  if (opts?.config) {
    const { saveStoreFor, loadStoreFor } = await import("../../lib/ultracode/store.ts")
    const s = loadStoreFor(project)
    Object.assign(s.config, opts.config)
    saveStoreFor(project, s)
  }
  // query-параметр обходит кэш модулей: "рестарт" = чистый инстанс поверх того же файла.
  const mod = await import(`../../plugin/ultracode.ts?lab=${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`)
  const hooks = await mod.default({ worktree: project, project: { id: project } })
  const tool = hooks.tool.ultracode_context
  const callTool = async (args: Record<string, unknown>): Promise<string> => {
    const out = await tool.execute(args, fakeContext())
    return typeof out === "string" ? out : String(out.output ?? out)
  }
  // store-файл: per-project под XDG (та же формула, что в store.ts).
  const storeFile = (): string => {
    const root = path.join(process.env.XDG_DATA_HOME as string, "opencode", "ultracode", "projects")
    const entries = fs.existsSync(root) ? fs.readdirSync(root) : []
    if (entries.length === 0) throw new Error("store dir not created yet")
    return path.join(root, entries[0] as string, "context.json")
  }
  const readStoreRaw = (): string => fs.readFileSync(storeFile(), "utf8")
  // "Рестарт": новый инстанс плагина поверх ТОГО ЖЕ файла (env не меняем).
  const reopen = async () => {
    const mod2 = await import(`../../plugin/ultracode.ts?lab=${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`)
    const hooks2 = await mod2.default({ worktree: project, project: { id: project } })
    const tool2 = hooks2.tool.ultracode_context
    return {
      storeFile,
      readStoreRaw,
      callTool: async (args: Record<string, unknown>): Promise<string> => {
        const out = await tool2.execute(args, fakeContext())
        return typeof out === "string" ? out : String(out.output ?? out)
      },
    }
  }
  return {
    dir, project, callTool, storeFile,
    readStoreRaw,
    // Произвольный тул из объекта tool: (например triage).
    // Произвольный тул из объекта tool: (например triage, recall_pruned).
    // sessionID можно задать: персистентные тулы (стор оригиналов) ищут файл
    // по sid, который сообщенияtransform задают в info.sessionID.
    callToolNamed: async (name: string, args: Record<string, unknown>, sessionID = "lab") => {
      const t = (hooks.tool as Record<string, { execute: (a: unknown, c: unknown) => Promise<unknown> }>)[name]
      if (!t) throw new Error(`tool not registered: ${name}`)
      const out = await t.execute(args, { ...fakeContext(), sessionID })
      return typeof out === "string" ? out : String((out as { output?: unknown }).output ?? out)
    },
    tools: () => Object.keys(hooks.tool as Record<string, unknown>),
    // Хук реального сообщения: output.parts несёт текст пользователя (UC-032 query).
    chatMessage: async (text: string) => {
      await hooks["chat.message"]?.({ sessionID: "test", mcpID: undefined }, { parts: [{ type: "text", text }] })
    },
    // Хук системного промпта: проверяем, что он делает с массивом system.
    systemTransform: async (system: string[]) => {
      await hooks["experimental.chat.system.transform"]?.({ sessionID: "lab" }, { system })
      return system
    },
    // Хук сжатия истории: контракт — мутирует переданный массив (in-place).
    messagesTransform: async (messages: unknown[]) => {
      await hooks["experimental.chat.messages.transform"]?.({}, { messages })
      return messages
    },
    // Компактация сессии: следующий transform на том же sid жать не должен.
    compactSession: async (sessionID: string) => {
      await hooks["experimental.session.compacting"]?.({ sessionID }, { context: [] })
    },
    sendEvent: async (event: unknown) => {
      await hooks.event?.({ event })
    },
    reload: makeRuntime,
    reopen,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } },
  }
}

// Схема tool из shipped-артефакта (не из хелперов): что реально принимает runtime.
export async function toolSchema(): Promise<{ actions: string[]; statuses: string[] }> {
  process.env.XDG_DATA_HOME = process.env.XDG_DATA_HOME || fs.mkdtempSync(path.join(os.tmpdir(), "uc-schema-"))
  const mod = await import(`../../plugin/ultracode.ts?schema=${Date.now().toString(36)}`)
  const hooks = await mod.default({ worktree: "/tmp", project: { id: "/tmp" } })
  const args = hooks.tool.ultracode_context.args as Record<string, { _def?: {
    values?: string[]; options?: string[]; entries?: Record<string, string>; innerType?: { _def?: {
      values?: string[]; options?: string[]; entries?: Record<string, string> } } } }>
  const vals = (k: string): string[] => {
    const d = args[k]?._def
    const inner = d?.innerType?._def ?? d
    if (!inner) return []
    if (Array.isArray(inner.values)) return inner.values
    if (Array.isArray(inner.options)) return inner.options
    if (inner.entries) return Object.keys(inner.entries)
    return []
  }
  return { actions: vals("action"), statuses: vals("status") }
}
