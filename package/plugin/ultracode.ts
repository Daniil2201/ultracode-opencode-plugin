// Ultracode — V2 plugin for OpenCode v2.0.32+
//
// Мигрирован с V1 на V2 Plugin API.
// V2: ctx.session, ctx.tool, ctx.storage, ctx.location, ctx.event
//
// Ponytail: тонкий плагин-оркестратор. Тяжёлая логика — в ../lib/ultracode/*.

import { Plugin } from "@opencode/plugin"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { spawnSync } from "node:child_process"

// Lib imports (pure functions, unchanged)
import { freshStore as freshStoreV3, migrateStore as migrateStoreV3 } from "../lib/ultracode/schema.ts"
import type { ContextStore as StoreV3, Knowledge as KnowledgeV3, Lesson as LessonV3, Plan as PlanV3, PlanStep as PlanStepV3 } from "../lib/ultracode/schema.ts"
import { loadStoreFor as loadStoreForProject, saveStore as saveStoreAtomic, loadStore as loadStoreV3, updateStoreFile as updateStoreFileV3, storeFileFor, pickProjectDir, metricsFileFor, storeRoot } from "../lib/ultracode/store.ts"
import { injectOnce as injectOnceV3, markerFor as markerForV3 } from "../lib/ultracode/injection.ts"
import { tokens, isRealTokenizer } from "../lib/ultracode/tokens.ts"
import { renderSections as renderSectionsV3 } from "../lib/ultracode/injection.ts"
import { getSessionMetrics as getSessionMetricsV3, toolArgs as toolArgsV3, isErrorOutput as isErrorOutputV3, appendMetrics as appendMetricsV3, classifyTool as classifyToolV3, addToolTokensByKind as addToolTokensByKindV3 } from "../lib/ultracode/metrics.ts"
import { transitionStep as transitionStepV3, savePlan as savePlanV3, evaluateGoal as evaluateGoalV3, GOAL_FAIL_STEP_ID } from "../lib/ultracode/plan.ts"
import { createEvidence as createEvidenceV3, applyEvidence as applyEvidenceV3, sanitizeOutput as sanitizeOutputV3, summarizeEvidence as summarizeEvidenceV3 } from "../lib/ultracode/verification.ts"
import { TOOL_ACTIONS as TOOL_ACTIONS_V3, validateEvidenceArgs as validateEvidenceArgsV3, validatePlanNewArgs as validatePlanNewArgsV3 } from "../lib/ultracode/runtime-contract.ts"
import { buildCheckpoint as buildCheckpointV3 } from "../lib/ultracode/checkpoint.ts"
import { usageFor, addModelUsage, evaluate as evaluateBudgetV3, resolveLimit as resolveLimitV3, thresholdsFrom as thresholdsFromV3, THRESHOLD_PROFILES as THRESHOLD_PROFILES_V3 } from "../lib/ultracode/budget.ts"
import type { Usage as UsageV3 } from "../lib/ultracode/budget.ts"
import { planPrune as planPruneV3, applyPrune as applyPruneV3, levelFor as levelForV3, originalContent as originalContentV3, PRUNE_EPOCH_TURNS as PRUNE_EPOCH_TURNS_V3 } from "../lib/ultracode/pruner.ts"
import { prunedFileFor as prunedFileForV3, prunedLogFor as prunedLogForV3, appendPrunerLog as appendPrunerLogV3, appendOriginal as appendOriginalV3, appendPin as appendPinV3, loadPins as loadPinsV3, findOriginals as findOriginalsV3 } from "../lib/ultracode/prune-store.ts"
import { buildHandoff as buildHandoffV3, writeHandoff as writeHandoffV3, readHandoff as readHandoffV3 } from "../lib/ultracode/handoff.ts"
import { redactConfidential as redactConfidentialV3, deepRedact as deepRedactV3 } from "../lib/ultracode/confidential.ts"
import { AUTONOMY_TAG as AUTONOMY_TAG_V3 } from "../lib/ultracode/autonomy.ts"
import { verifyReport as verifyReportV3 } from "../lib/ultracode/report-verify.ts"
import { detectStack as detectStackV3 } from "../lib/ultracode/stack-detect.ts"
import { detectContract as detectContractV3 } from "../lib/ultracode/stack-contract.ts"
import { parseEvaluateTarget as parseTargetV3 } from "../lib/ultracode/evaluation/portable.ts"
import { sentinelCheck as sentinelCheckV3 } from "../lib/ultracode/sentinel.ts"
import {
  collectSkills as collectSkillsV3,
  renderSkillHint as renderSkillHintV3,
  skillTriage as skillTriageV3,
  stripAvailableSkills as stripAvailableSkillsV3,
} from "../lib/ultracode/skill-router.ts"

declare const process: {
  cwd(): string
  env: Record<string, string | undefined>
  pid: number
}

const DEBUG = process.env.OPENCODE_ULTRACODE_DEBUG === "1"
const PRUNER_LOG_EVERY_TURNS = 50
const STORE_DIR = process.env.XDG_DATA_HOME
  ? path.join(process.env.XDG_DATA_HOME, "opencode", "ultracode")
  : path.join(os.homedir(), ".local", "share", "opencode", "ultracode")
const STORE_FILE = path.join(STORE_DIR, "context.json")

type Knowledge = KnowledgeV3
type Lesson = LessonV3
type PlanStep = PlanStepV3
type Plan = PlanV3
type ContextStore = StoreV3

const C_ERR = "\x1b[31m"
const C_WARN = "\x1b[33m"
const C_OPEN = "\x1b[32m"
const C_VIOLET = "\x1b[35m"
const C_ULTRA = "\x1b[35m"
const C_WAIT = "\x1b[36m"
const C_RST = "\x1b[0m"
const G_DONE = "✓"
const G_ERR = "✗"
const G_WARN = "⚠"
const G_WAIT = "◌"
const G_HIST = "❏"
const G_PLAN = "📋"
const G_MEM = "🧠"
const G_FUT = "○"
const G_CUR = "●"
const G_SRCH = "🔍"
const G_TOOL = "🔧"
const G_EXT = "🌐"
const G_HIT = "📈"
const G_TIME = "⏱"
const G_CLOSE = "✕"
const G_MARK = "▪"
const G_INJ = "💉"
const G_RANK = "📊"
const G_CMP = "📉"
const SPIN_DOTS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const MAX_KNOWLEDGE = 200
const MAX_LESSONS = 80
const DIGEST_AGE_DAYS = 7
const MAX_RECALL_CHARS = 4000
const FARM_STATE_CAP = 2000
const FARM_QUICK = `<farm-connect>
Контекст фермы my-manager доступен. Используй tg-manager MCP.
Правило: НЕ трогай config.toml, НЕ выводи секреты, НЕ публикуй ниже порога.
</farm-connect>`

function log(...args: unknown[]) {
  if (DEBUG) console.error("[ultracode]", ...args)
}

function tokK(n: number): string {
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + "K"
  return String(n)
}

function fillPct(pct: number, w = 10): string {
  const n = Math.round((w * Math.max(0, Math.min(100, pct))) / 100)
  return "█".repeat(n) + "░".repeat(w - n)
}

function autoCompact(store: ContextStore): void {
  if (store.knowledge.length <= MAX_KNOWLEDGE) return
  const now = Date.now()
  const old = store.knowledge.filter(
    (k) => k.archived || k.status === "closed" ||
      (now - new Date(k.ts).getTime()) > DIGEST_AGE_DAYS * 86400000,
  )
  if (old.length === 0) return
  const keep = store.knowledge.filter((k) => !old.includes(k))
  if (keep.length < MAX_KNOWLEDGE * 0.6) return
  const digestText = old
    .slice(-15)
    .map((k) => `- [${k.kind}] ${k.text.slice(0, 100)}`)
    .join("\n")
  store.knowledge = [
    ...keep,
    {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      kind: "digest",
      project: store.knowledge[0]?.project ?? "",
      text: `Выжимка ${old.length} архивных записей (старше ${DIGEST_AGE_DAYS} дн.):\n${digestText}`,
      labels: ["digest", "archive"],
      status: "open",
      archived: false,
    },
  ]
}

function pushSystemOnce(system: unknown[], sid: string, tag: string, text: string): void {
  const marker = `${sid}:${tag}`
  if ((system as any[]).some((x) => typeof x === "object" && x !== null && typeof x.text === "string" && x.text.includes(marker))) return
  ;(system as any[]).push({ type: "text", text: `${marker}\n${text}` })
}

// Эвристика OpenCode inference API: бесплатные модели имеют суффикс "-free" в id.
// Работает только для provider "opencode"; для сторонних провайдеров возвращает false.
function isFreeModel(modelId: string): boolean {
  return typeof modelId === "string" && modelId.toLowerCase().endsWith("-free")
}

// ─── main plugin ──────────────────────────────────────────────────────

export default Plugin.define({
  id: "ultracode",
  async setup(ctx: any) {
    const projectPath = ctx.location?.project?.canonical || ctx.location?.project?.directory || ctx.location?.directory || process.cwd()
    const store = loadStoreForProject(projectPath)
    const injectedSessions = new Set<string>()
    const lastUserQuery = new Map<string, string>()
    const debugOn = (): boolean => process.env.OPENCODE_ULTRACODE_DEBUG === "1"
    const debugLog = (msg: string): void => {
      if (debugOn()) console.error(`[ultracode:skill-router] ${msg}`)
    }

    // Budget state
    const usageBySession = (ctx as any)._usageBySession || new Map<string, UsageV3>()
    if (!(ctx as any)._usageBySession) (ctx as any)._usageBySession = usageBySession
    const handoffWritten = new Set<string>()
    const sessionModel = new Map<string, { providerID: string; modelID: string }>()
    let limitsCache: Map<string, number> | null = null
    let limitsTried = false

    async function loadLimits(): Promise<void> {
      if (limitsCache) return
      try {
        const res = await ctx.provider?.list?.() ?? []
        const arr = Array.isArray(res) ? res : Object.values(res || {})
        const m = new Map<string, number>()
        for (const p of arr as any[]) {
          const pid = p?.id
          const models = p?.models ?? {}
          for (const [mid, model] of Object.entries(models as Record<string, any>)) {
            const c = (model as any)?.limit?.context
            if (typeof pid === "string" && typeof c === "number" && c > 0) m.set(`${pid}/${mid}`, c)
          }
        }
        limitsCache = m
      } catch {
        // Retryable: don't cache failure, allow retry on next call
        limitsCache = null
      }
    }

    // ─── Git-хранилище: версии и diff (ESM: spawnSync, без require) ───
    function git(...args: string[]): { ok: boolean; out: string } {
      try {
        const cp = spawnSync("git", args, {
          cwd: path.dirname(storeFileFor(projectPath)),
          encoding: "utf8",
          timeout: 5000,
        })
        if (cp.status === 0) return { ok: true, out: String(cp.stdout || "").trim() }
        return { ok: false, out: String(cp.stderr || "").trim().slice(0, 300) }
      } catch (e) {
        return { ok: false, out: String((e as Error).message).slice(0, 300) }
      }
    }

    function ensureGitRepo(): void {
      try {
        const dir = path.dirname(storeFileFor(projectPath))
        if (!fs.existsSync(path.join(dir, ".git"))) {
          fs.mkdirSync(dir, { recursive: true })
          git("init", "-q")
          git("config", "user.email", "ultracode@local")
          git("config", "user.name", "ultracode")
          git("config", "commit.gpgsign", "false")
        }
      } catch { /* git может быть недоступен — стор работает и без него */ }
    }

    function commitStoreFile(msg: string): void {
      // История версий стора нужна только в реальном рантайме. Под node --test
      // (NODE_TEST_CONTEXT задан) коммиты не делаем: десятки параллельных
      // `git init/commit` в temp-каталогах давали гонки ФС и флейки suite.
      if (process.env.NODE_TEST_CONTEXT) return
      try {
        ensureGitRepo()
        git("add", path.basename(storeFileFor(projectPath)))
        git("commit", "-q", "-m", msg)
      } catch { /* best effort */ }
    }

    function activePlanFresh(): Plan | null {
      try {
        const f = loadStoreV3(storeFileFor(projectPath))
        const ids = Object.keys(f.plans)
        return ids.length ? (f.plans[ids[ids.length - 1] as string] ?? null) : null
      } catch { return null }
    }

    async function checkBudget(sid: string): Promise<void> {
      const u = usageBySession.get(sid)
      if (!u) return
      await loadLimits()
      const mod = sessionModel.get(sid)
      const lim = resolveLimitV3(store.config.modelLimit, limitsCache, mod?.providerID, mod?.modelID)
      const r = evaluateBudgetV3(u, lim, thresholdsFromV3(store.config))
      if (r.level === "soft") { log(`budget 40% (${sid.slice(0, 8)})`); return }
      if (r.level !== "hard" && r.level !== "emergency") return
      if (handoffWritten.has(sid)) return
      const summary = `${buildCheckpointV3(activePlanFresh())}\\nreason: ${r.level} ${Math.round(r.pct)}%`
      const file = storeFileFor(projectPath)
      try {
        writeHandoffV3(file, buildHandoffV3(sid, r.level as any, Math.round(r.pct), summary), commitStoreFile)
        handoffWritten.add(sid)  // only mark after successful write
      } catch (e) {
        console.error("[ultracode] handoff write failed, will retry:", (e as Error).message)
        return  // don't mark as written, allow retry
      }
      try {
        const re = loadStoreV3(file)
        store.handoff = re.handoff
      } catch { /* best effort */ }
      if (r.level === "emergency") console.error("[ultracode] budget 75%, relying on session.compacting")
    }

    // ─── context-pruner state ──────────────────────────────────────
    const pruneState = new Map<string, { turns: number; lastLevel: string; lastPruneTurn: number; lastLogTurn: number }>()
    const compactionPending = new Set<string>()
    function pruneStateFor(sid: string) {
      let st = pruneState.get(sid)
      if (!st) {
        st = { turns: 0, lastLevel: "off", lastPruneTurn: 0, lastLogTurn: -PRUNER_LOG_EVERY_TURNS }
        pruneState.set(sid, st)
      }
      return st
    }

    // ─── system transform hook (V2: session.hook "context") ────────
    await ctx.session.hook("context", async (event: any) => {
      const sid = event?.sessionID || "default"
      const system = event?.system
      if (!Array.isArray(system)) return
      // V2 compat: normalize string items to {type, text} objects
      for (let i = 0; i < system.length; i++) {
        if (typeof system[i] === "string") system[i] = { type: "text", text: system[i] }
      }

      // Skill hint injection
      try {
        let stripped = 0
        for (const item of system as any[]) {
          if (typeof item === "object" && item !== null && typeof item.text === "string") {
            const before = item.text
            item.text = item.text.replace(/<available_skills>[\s\S]*?<\/available_skills>/g, "").trimEnd()
            if (item.text !== before) stripped++
          }
        }
        if (stripped > 0) debugLog(`stripped <available_skills> x${stripped} (${sid})`)
        const hint = renderSkillHintV3(lastUserQuery.get(sid) ?? "", 3, projectPath)
        if (hint) pushSystemOnce(system, sid, "skill-hint", hint)
      } catch (e) {
        debugLog(`skill-hint failed: ${String((e as Error).message).slice(0, 200)}`)
      }

      // Ponytail + skills + autonomy
      pushSystemOnce(system, sid, "ponytail", "Ponytail mode active.")
      pushSystemOnce(system, sid, "skills", "Skills FIRST rule active.")
      pushSystemOnce(system, sid, "autonomy", AUTONOMY_TAG_V3)

      // Handoff from previous session
      const prev = readHandoffV3(store)
      if (prev && prev.sessionId !== sid) {
        pushSystemOnce(system, sid, "handoff",
          `<ultracode-handoff>\\nПредыдущая сессия ${prev.sessionId.slice(0, 8)} прервана (${prev.reason}, ${String(prev.usagePct)}%):\\n${prev.summary}\\n</ultracode-handoff>`)
      }

      // Budget-based injection
      const usage = usageFor(usageBySession, sid)
      let totalBudget = store.config.budgetTokens
      try {
        await loadLimits()
        const mod = sessionModel.get(sid)
        const v = evaluateBudgetV3(usage, resolveLimitV3(store.config.modelLimit, limitsCache, mod?.providerID, mod?.modelID), thresholdsFromV3(store.config))
        if (!v.estimated) {
          if (v.level === "soft") totalBudget = Math.floor(totalBudget / 2)
          else if (v.level === "hard" || v.level === "emergency") totalBudget = Math.floor(totalBudget / 4)
        }
      } catch { /* учёт не блокирует инъекцию */ }

      // Farm state (SEC-02: canonical path check, no symlink escape)
      let farmRaw = ""
      try {
        const farmState = path.join(projectPath, "farm", "knowledge", "state.md")
        const realProject = fs.realpathSync(projectPath)
        const realFarm = fs.realpathSync(farmState)
        if (realFarm.startsWith(realProject + path.sep) && fs.statSync(realFarm).isFile()) {
          farmRaw = redactConfidentialV3(fs.readFileSync(realFarm, "utf8").trim())
        }
      } catch { /* нет фермы или symlink за пределы — ок */ }

      const assembled = renderSectionsV3(
        { knowledge: store.knowledge, lessons: store.lessons, plans: Object.values(store.plans), farm: farmRaw || undefined, project: projectPath },
        totalBudget,
      )
      const [kSec, lSec, pSec, fSec] = assembled.sections
      if (kSec.text) pushSystemOnce(system, sid, "knowledge", `<ultracode-knowledge>\\n${kSec.text}\\n</ultracode-knowledge>`)
      if (lSec.text) pushSystemOnce(system, sid, "lessons", `<ultracode-lessons>\\n${lSec.text}\\n</ultracode-lessons>`)
      if (pSec.text) pushSystemOnce(system, sid, "plans", `<ultracode-plans>\\n${pSec.text}\\n</ultracode-plans>`)
      if (fSec.text) pushSystemOnce(system, sid, "farm", `${FARM_QUICK}\\n<farm-state>\\n${fSec.text}\\n</farm-state>`)

      // Save lastInjection to store (for view/stats)
      try {
        locked("injection", (fresh: any) => {
          fresh.lastInjection = {
            ts: new Date().toISOString(),
            sessionID: sid,
            budgetTokens: totalBudget,
            spentTokens: assembled.totalTokens,
            injected: assembled.injected,
            evicted: assembled.evicted,
          }
        })
      } catch { /* best effort */ }

      // ─── context-pruner (V2: part of context hook) ─────────────
      const messages = event?.messages
      const pruneSid = sid
      // Empty messages: don't consume compactionPending flag (V1 compat:
      // sid couldn't be extracted from empty array, so flag stayed).
      if (!Array.isArray(messages) || messages.length === 0) {
        return
      }
      if (compactionPending.has(pruneSid)) {
        compactionPending.delete(pruneSid)
        return
      } else {
        try {
          const mod = sessionModel.get(pruneSid)
          const level = levelForV3(evaluateBudgetV3(
            usageFor(usageBySession, pruneSid),
            resolveLimitV3(store.config.modelLimit, limitsCache, mod?.providerID, mod?.modelID),
            thresholdsFromV3(store.config),
          ).level)
          const st = pruneStateFor(pruneSid)
          if (level === "off") {
            st.lastLevel = "off"
            return
          }
          st.turns++
          // Эпоха: не чаще раза в N ходов
          if (st.lastPruneTurn > 0 && st.turns - st.lastPruneTurn < PRUNE_EPOCH_TURNS_V3) {
            return
          }
          // Тот же уровень повторно: не жмём
          if (level === st.lastLevel) {
            return
          }
          const file = prunedFileForV3(projectPath, pruneSid)
          const { messages: pruned, report } = planPruneV3(messages, level, { pinned: loadPinsV3(file) })
          if (report.actions.length === 0) {
            return
          }
          let failed = 0
          for (const a of report.actions) {
            const r = appendOriginalV3(file, {
              messageID: a.messageID,
              partID: a.partID,
              tool: a.tool,
              content: originalContentV3(messages, a.messageID, a.partID),
            })
            if (r === "failed") failed++
          }
          if (failed > 0) {
            return
          }
          st.lastLevel = level
          st.lastPruneTurn = st.turns
          applyPruneV3(event as { messages: unknown[] }, { messages: pruned })
        } catch (e) {
          log("context-pruner failed:", redactConfidentialV3(e instanceof Error ? e.message : String(e)).slice(0, 200))
        }
      }



    })
    // ─── prompt admission hook (V2: session.hook "prompt") ─────────
    await ctx.session.hook("prompt", async (event: any) => {
      const sid = event?.sessionID || "default"
      const text = event?.prompt?.text || ""
      if (text.trim().length > 0) {
        lastUserQuery.set(sid, text.slice(0, 2000))
        debugLog(`captured prompt (${sid}, ${text.length} chars)`)
      }
    })

    // ─── compaction hook (V2: session.hook "compaction") ──────────
    await ctx.session.hook("compaction", async (event: any) => {
      const sid = event?.sessionID || "unknown"
      compactionPending.add(sid)
      if (!Array.isArray(event?.context)) return
      const active = activePlanFresh()
      if (active) {
        event.context.push(buildCheckpointV3(active))
      }
    })

    // ─── event subscription (V2: ctx.event.subscribe) ─────────────
    const controller = new AbortController()
    // Event handler (can be called directly in tests via ctx._handleEvent)
    const handleEvent = async (event: any) => {
      const type = event?.type
      const props = event?.properties || {}
      if (type === "message.updated") {
        const info = props.info ?? {}
        const msid = info.sessionID || info.sessionId || "default"
        addModelUsage(usageBySession, msid, info)
        if (typeof info.modelID === "string") {
          sessionModel.set(msid, { providerID: String(info.providerID ?? ""), modelID: info.modelID })
        }
        await checkBudget(msid)
      }
      if (type === "session.idle") {
        const sid = props.sessionID || props.sessionId || "unknown"
        try {
          updateStoreFileV3(storeFileFor(projectPath), (fresh: any) => {
            const row = getSessionMetricsV3(fresh, sid)
            row.timestamp = new Date().toISOString()
          })
        } catch { /* best effort */ }
      }
    }
    ;(ctx as any)._handleEvent = handleEvent

    // V2: event subscription (background)
    ;(async () => {
      try {
        const sub = ctx.event.subscribe({ signal: controller.signal })
        for await (const event of sub) {
          await handleEvent(event)
        }
      } catch { /* subscription ended */ }
    })()


    // ─── ultracode_context execute (ported from V1) ────────────────
    const _executeImpl = async (args: any, _context: any): Promise<any> => {
                const action = args.action || "list"

          // ─── самообучение ──────────────────────────────────────
          if (action === "lessons") {
            const relevant = store.lessons
              .filter((l) => l.project === projectPath || l.kind === "lesson")
              .slice(-15)
            if (relevant.length === 0) return `${C_WAIT}${G_WAIT}${C_RST} Раздел уроков пуст.`
            return relevant.map((l) => `${C_ULTRA}${G_MEM}${C_RST} [${l.ts.slice(0, 16)}] [${l.kind}] ${l.text}`).join("\n")
          }

          if (action === "learn" && args.text) {
            // UC-018: секреты не персистятся — sanitize до записи и в эхе.
            const clean = sanitizeOutputV3(args.text).slice(0, 500)
            const kind = args.kind === "success" ? "success" : "lesson"
            try {
              locked("learn", (fresh: any) => {
                const dup = fresh.lessons.find((x: any) => x.text === clean && x.kind === kind && x.project === projectPath)
                if (dup) return
                fresh.lessons.push({ id: crypto.randomUUID(), ts: new Date().toISOString(), kind, project: projectPath, text: clean, labels: ["manual", "learned"] })
                if (fresh.lessons.length > 80) fresh.lessons = fresh.lessons.slice(-80)
              })
              // Sync in-memory store
              try { const re = loadStoreV3(storeFileFor(projectPath)); store.lessons = re.lessons } catch { /* best effort */ }
            } catch (e) {
              return { output: `learn failed: ${String((e as Error).message).slice(0, 200)}` }
            }
            return { output: `${C_OPEN}${G_DONE}${C_RST} Урок сохранён: ${clean.slice(0, 80)}` }
          }

          // ─── статистика токенов (Block 1) ─────────────────────
          if (action === "stats" || action === "tokens") {
            const t = store.tokens
            const internal = t.internal.current
            const external = t.external.current
            const total = internal + external
            const hits = t.hitRate.hits
            const misses = t.hitRate.misses
            const hitPct = hits + misses > 0 ? Math.round((hits / (hits + misses)) * 100) : 0
            const budget = store.config.budgetTokens
            const inj = store.lastInjection
            const loaded = inj?.injected.length ?? 0
            const skipped = inj?.evicted.length ?? 0
            const fill = budget > 0 ? Math.min(100, Math.round(((inj?.spentTokens ?? 0) / budget) * 100)) : 0
            const k = t.internal.byKind.knowledge ?? 0
            const ls = t.internal.byKind.lessons ?? 0
            const pl = t.internal.byKind.plans ?? 0
            const fm = t.internal.byKind.farm ?? 0
            const historyCount = t.internal.history.length

            if (action === "tokens") {
              const lastHist = t.internal.history.at(-1)
              return [
                `${C_ULTRA}${G_MEM}${C_RST} Internal: ~${tokK(internal)} tok (knowledge ${tokK(k)}, lessons ${tokK(ls)}, plans ${tokK(pl)}, farm ${tokK(fm)})`,
                `${C_OPEN}${G_EXT}${C_RST} External: ~${tokK(external)} tok (посл. инъекция system)`,
                `${C_ULTRA}⇅${C_RST} Total: ~${tokK(total)} tok${isRealTokenizer() ? "" : " (est)"}`,
                `${C_OPEN}${G_HIT}${C_RST} Hit rate: ${hitPct}% (${hits}/${hits + misses})`,
                `${C_VIOLET}${G_CMP}${C_RST} Compact saved: ~${tokK(t.compaction.saved)} tok`,
                lastHist ? `${C_WAIT}${G_HIST}${C_RST} История: ${historyCount} инъекций, последняя ${lastHist.sessionId.slice(0, 8)} (${tokK(lastHist.size)} tok)` : "",
              ].filter(Boolean).join("\n")
            }

            // stats — расширенный дашборд (статус-бар по ТЗ п.4)
            const lines: string[] = []
            lines.push(`╭────── ${C_ULTRA}${G_MEM}${C_RST} Ultracode Stats ${C_WAIT}${G_TIME}${C_RST} ${new Date().toISOString().slice(11, 19)} ───────╮`)
            lines.push(`${C_ULTRA}${G_MEM}${C_RST} Internal:  ~${tokK(internal)} tokens (эта сессия)`)
            lines.push(`  ├─ ${C_ULTRA}${G_MEM}${C_RST} Knowledge: ${tokK(k)} (${loaded} записей из ${store.knowledge.length})`)
            lines.push(`  ├─ ${C_ULTRA}${G_MEM}${C_RST} Lessons:   ${tokK(ls)} (${store.lessons.length} уроков)`)
            lines.push(`  ├─ ${C_ULTRA}${G_MEM}${C_RST} Plans:     ${tokK(pl)} (${Object.keys(store.plans).length} планов)`)
            lines.push(`  └─ ${C_ULTRA}${G_MEM}${C_RST} Farm:      ${tokK(fm)}`)
            lines.push(`${C_OPEN}${G_EXT}${C_RST} External:  ~${tokK(external)} tokens (OpenCode)`)
            const ext = t.external.history.at(-1)
            if (ext) {
              lines.push(`  ├─ ${C_OPEN}${G_EXT}${C_RST} System:   ${tokK(ext.system)}`)
              lines.push(`  ├─ ${C_OPEN}${G_EXT}${C_RST} Messages: ${tokK(ext.messages)}`)
              lines.push(`  └─ ${C_OPEN}${G_EXT}${C_RST} Tools:    ${tokK(ext.tools)}`)
            }
            lines.push(`  ═${"═".repeat(50)}`)
            lines.push(`${C_ULTRA}⇅${C_RST} Total:    ~${tokK(total)} tokens (${C_OPEN}${G_HIT}${C_RST} ${hitPct}%)`)
            lines.push(`${C_VIOLET}${G_CMP}${C_RST} Saved:    ${tokK(t.compaction.saved)} tok (компакция)`)
            lines.push(`${C_ULTRA}${G_RANK}${C_RST} Fill:     ${fill}% [${fillPct(fill, 12)}]`)
            lines.push(`${C_WAIT}${G_HIST}${C_RST} Counter:  ${isRealTokenizer() ? "cl100k_base" : "эвристика (est)"}`)
            {
              const lim = store.config.modelLimit ?? (Number(process.env.OPENCODE_MODEL_LIMIT) || 0)
              const cur = t.external.history.at(-1)
              if (lim > 0 && cur) {
                const used = cur.system + cur.messages + cur.tools
                const pct = Math.min(100, Math.round((used / lim) * 100))
                lines.push(`${C_ULTRA}⇅${C_RST} Usage:    ${pct}% (~${tokK(used)} / ${tokK(lim)} лимита модели)`)
              } else {
                lines.push(`${C_WAIT}${G_HIST}${C_RST} Usage:    лимит неизвестен (задать: budget limit=<N>)`)
              }
            }
            lines.push(`${C_OPEN}${G_HIT}${C_RST} Hit rate: ${hitPct}% (${hits}/${hits + misses})`)
            // Free/paid indicator for known models
            const sm = Array.from(sessionModel.entries())
            if (sm.length > 0) {
              const [sid, m] = sm[sm.length - 1]
              const free = isFreeModel(m.modelID)
              lines.push(`${C_ULTRA}${G_MEM}${C_RST} Model:    ${m.providerID}/${m.modelID} (${free ? "free" : "paid"})`)
            }
            lines.push(`${C_WAIT}${G_HIST}${C_RST} Loaded:   ${loaded} записей | Skipped: ${skipped} (не влезли в бюджет ${tokK(budget)})`)
            lines.push(`${C_WAIT}${G_TIME}${C_RST} History:  ${historyCount} инъекций, budget ${C_OPEN}${tokK(budget)}${C_RST} tok (измени: ${C_ULTRA}budget number${C_RST})`)
            lines.push(`╰${"─".repeat(52)}╯`)
            return lines.join("\n")
          }

          // ─── настройки: бюджет / анимации ────────────────────
          if (action === "budget") {
            // Фаза 5: установка профиля порогов (SDD/AI-DLC). budgetTokens не трогает.
            const prof = (args as any).profile
            if (typeof prof === "string" && prof) {
              const p = (THRESHOLD_PROFILES_V3 as Record<string, { soft: number; hard: number; emergency: number }>)[prof]
              if (!p) return `${C_ERR}${G_ERR}${C_RST} неизвестный profile: ${prof} (aggressive|balanced|conservative). Стор не изменён.`
              locked(`profile ${prof}`, (fresh) => {
                fresh.config.thresholdSoft = p.soft
                fresh.config.thresholdHard = p.hard
                fresh.config.thresholdEmergency = p.emergency
              })
              return `${C_ULTRA}${G_MEM}${C_RST} profile ${prof}: soft=${p.soft} hard=${p.hard} emergency=${p.emergency}`
            }
            // Ручные пороги — только все три сразу, иначе неясно что с остальными.
            const ts = (args as any).thresholdSoft
            const th = (args as any).thresholdHard
            const te = (args as any).thresholdEmergency
            if (ts !== undefined || th !== undefined || te !== undefined) {
              if (typeof ts !== "number" || typeof th !== "number" || typeof te !== "number") {
                return `${C_ERR}${G_ERR}${C_RST} укажи все три: thresholdSoft + thresholdHard + thresholdEmergency. Стор не изменён.`
              }
              for (const v of [ts, th, te]) {
                if (!(v >= 1 && v <= 99)) return `${C_ERR}${G_ERR}${C_RST} пороги вне 1..99: ${v}. Стор не изменён.`
              }
              if (!(ts < th && th < te)) {
                return `${C_ERR}${G_ERR}${C_RST} нужен порядок soft < hard < emergency: ${ts}/${th}/${te}. Стор не изменён.`
              }
              locked(`thresholds ${ts}/${th}/${te}`, (fresh) => {
                fresh.config.thresholdSoft = Math.round(ts)
                fresh.config.thresholdHard = Math.round(th)
                fresh.config.thresholdEmergency = Math.round(te)
              })
              return `${C_ULTRA}${G_MEM}${C_RST} thresholds: soft=${Math.round(ts)}, hard=${Math.round(th)}, emergency=${Math.round(te)}`
            }
            const lim = (args as any).limit
            if (typeof lim === "number" && lim > 0) {
              locked(`limit ${lim}`, (fresh) => {
                fresh.config.modelLimit = Math.round(lim)
              })
              return `${C_ULTRA}${G_MEM}${C_RST} Лимит модели: ${C_OPEN}${Math.round(lim)}${C_RST}. Пороги Budget Manager считаются от него.`
            }
            const n = args.number
            if (n && n > 0 && n <= 100000) {
              locked(`budget ${n}`, (fresh) => {
                fresh.config.budgetTokens = Math.round(n)
              })
              return `${C_ULTRA}${G_MEM}${C_RST} Токен-бюджет: ${C_OPEN}${n}${C_RST}. Инъекция пересчитается при следующем чате.`
            }
            const curLim = store.config.modelLimit ?? (Number(process.env.OPENCODE_MODEL_LIMIT) || 0)
            return `${C_WAIT}${G_RANK}${C_RST} Текущий бюджет: ${C_OPEN}${store.config.budgetTokens}${C_RST}. Лимит модели: ${curLim > 0 ? curLim : "не задан (budget limit=<N>)"}. Укажи number (например number=3000).`
          }

          if (action === "anim") {
            const on = locked("anim", (fresh) => {
              fresh.config.anim = args.on ?? !fresh.config.anim
              return fresh.config.anim
            })
            return on
              ? `${C_OPEN}${SPIN_DOTS[0]}${C_RST} Анимации-снапшоты: ${on ? `${C_OPEN}${G_DONE}${C_RST} включены` : "выключены"}.`
              : `${C_WAIT}${G_WAIT}${C_RST} Анимации-снапшоты: выключены.`
          }

          // ─── записи (list / search) ────────────────────────────
          if (action === "list") {
            const items = store.knowledge
              .filter((k) => k.project === projectPath || k.kind === "fact")
              .slice(-20)
            if (items.length === 0) return `${C_WAIT}${G_WAIT}${C_RST} Контекст-хранилище пусто.`
            return items
              .map((k) => {
                const labels = k.labels.map((l) => `#${l}`).join(" ")
                const src = k.source ? ` \`${k.source}\`` : ""
                const state = k.status === "closed" ? ` ${C_WARN}${G_CLOSE}${C_RST}` : k.archived ? ` ${C_VIOLET}${G_CMP}${C_RST}` : ""
                const short = k.id.slice(0, 8)
                return `${C_WAIT}${G_MARK}${C_RST} [${k.ts.slice(0, 16)}] [${k.kind}]${state} ${labels} ${k.text.slice(0, 150)}${src} ${C_WAIT}id:${short}${C_RST}`
              })
              .join("\n")
          }

          if (action === "search" && args.q) {
            const q = args.q.toLowerCase()
            const hits = store.knowledge.filter(
              (k) =>
                k.text.toLowerCase().includes(q) ||
                k.labels.some((l) => l.toLowerCase().includes(q)) ||
                (k.source || "").toLowerCase().includes(q),
            )
            // hit rate: нашло ответ в памяти? Счётчик — под локом (UC-018).
            locked("search", (fresh) => {
              if (hits.length > 0) fresh.tokens.hitRate.hits++
              else fresh.tokens.hitRate.misses++
            })
            if (hits.length === 0) {
              return `${C_WARN}${G_SRCH}${C_RST} По запросу "${args.q}" ничего не найдено. ${C_WAIT}(${G_HIT} miss)${C_RST}`
            }
            const hitTokens = hits.reduce((acc, k) => acc + tokens(k.text), 0)
            const hitPct = Math.round((store.tokens.hitRate.hits / Math.max(1, store.tokens.hitRate.hits + store.tokens.hitRate.misses)) * 100)
            return [
              `${C_WARN}${G_SRCH}${C_RST} Найдено ${hits.length} записей (~${tokK(hitTokens)} токенов):`,
              ...hits.map((k) => {
                const src = k.source ? ` ${C_WAIT}\`${k.source}${C_RST}` : ""
                return `${C_WAIT}${G_MARK}${C_RST} [${k.kind}] ${C_ULTRA}#${k.labels.join(" #")}${C_RST} ${k.text.slice(0, 150)}${src}`
              }),
              `${C_OPEN}${G_HIT}${C_RST} Hit rate: ${hitPct}% (${store.tokens.hitRate.hits}/${store.tokens.hitRate.hits + store.tokens.hitRate.misses})`,
            ].join("\n")
          }

          // ─── видимость: что влезло в модель ────────────────────
          if (action === "view") {
            const r = store.lastInjection
            if (!r) return `${C_WAIT}${G_WAIT}${C_RST} Инъекции ещё не было (первая сессия без срабатывания system.transform?).`
            const injected = r.injected.map((id) => {
              const k = store.knowledge.find((x) => x.id === id)
              return k ? `  ${C_OPEN}${G_DONE}${C_RST} [${k.kind}] ${k.text.slice(0, 80)}` : `  ${C_OPEN}${G_DONE}${C_RST} (удалена) ${id.slice(0, 8)}`
            }).join("\n")
            const evicted = r.evicted.map((id) => {
              const k = store.knowledge.find((x) => x.id === id)
              return k ? `  ${C_WARN}${G_CLOSE}${C_RST} [${k.kind}] ${k.text.slice(0, 80)}` : `  ${C_WARN}${G_CLOSE}${C_RST} (удалена) ${id.slice(0, 8)}`
            }).join("\n")
            const fill = r.budgetTokens > 0 ? Math.min(100, Math.round((r.spentTokens / r.budgetTokens) * 100)) : 0
            const ranked = r.injected.length + r.evicted.length
            const lines: string[] = []
            lines.push(`${C_OPEN}${G_INJ}${C_RST} Инъекция контекста ${C_WAIT}${G_TIME}${C_RST} ${r.ts.slice(0, 16)} · session ${r.sessionID.slice(0, 8)}`)
            lines.push(`${C_ULTRA}${G_MEM}${C_RST} Internal → ${C_OPEN}${G_EXT}${C_RST} External ${C_WAIT}[${SPIN_DOTS[ranked % SPIN_DOTS.length]}]${C_RST}`)
            lines.push(`┌${"─".repeat(56)}┐`)
            lines.push(`│ ${C_WAIT}${G_MARK}${C_RST} Ранжировано: ${ranked} записей${" ".repeat(Math.max(1, 34 - String(ranked).length))}│`)
            lines.push(`│ ${C_WAIT}${G_MARK}${C_RST} Загружено: ${r.injected.length} записей (${C_OPEN}${tokK(r.spentTokens)} tokens${C_RST})${" ".repeat(15 - String(r.injected.length).length)}│`)
            lines.push(`│ ${C_WAIT}${G_MARK}${C_RST} В выжимке: ${r.evicted.length} записей (${tokK(r.spentTokens)} → ${tokK(r.budgetTokens - r.spentTokens)})${" ".repeat(10)}│`)
            lines.push(`│ ${C_WAIT}${G_MARK}${C_RST} Бюджет: ${C_OPEN}${tokK(r.spentTokens)} / ${tokK(r.budgetTokens)} (${fill}%)${C_RST} [${fillPct(fill, 12)}]${" ".repeat(10)}│`)
            lines.push(`│ ${"═".repeat(54)}│`)
            lines.push(`│ ${C_OPEN}${G_DONE}${C_RST} Инъекция завершена ${C_WAIT}${G_TIME}${C_RST} <1s${" ".repeat(25)}│`)
            lines.push(`└${"─".repeat(56)}┘`)
            lines.push(`В модель попали:\n${injected || "  (нет)"}`)
            if (r.evicted.length) lines.push(`Отсечено (бюджет/архив/закрыто):\n${evicted}`)
            return lines.join("\n")
          }

          // ─── git: версии и diff ────────────────────────────────
          if (action === "history") {
            const res = git("log", "--oneline", "-20")
            if (!res.ok) return `${C_ERR}${G_ERR}${C_RST} git log: ${res.out}`
            return `${C_WAIT}${G_HIST}${C_RST} История версий стора:\n${res.out || "(нет коммитов)"}`
          }

          if (action === "diff") {
            const res = git("diff", "HEAD~1", "HEAD", "--", "context.json")
            if (!res.ok) return `${C_ERR}${G_ERR}${C_RST} git diff: ${res.out}`
            return `${C_WAIT}${G_HIST}${C_RST} Diff (последний коммит${res.out ? "" : " — без изменений"}):\n${res.out || ""}`.replace(/\n$/, "")
          }

          // ─── статус записей: close / thread ────────────────────
          if (action === "close" && args.id) {
            const res = locked("close", (fresh) => {
              const k = fresh.knowledge.find((x) => x.id === args.id || x.id.startsWith(args.id))
              if (k) {
                fresh.tokens.hitRate.hits++
                k.status = "closed"
                return { ok: true as const, kind: k.kind, text: k.text }
              }
              fresh.tokens.hitRate.misses++
              return { ok: false as const }
            })
            if (res.ok) return `${C_WARN}${G_CLOSE}${C_RST} Закрыта: [${res.kind}] ${res.text.slice(0, 80)}`
            return `${C_ERR}${G_ERR}${C_RST} Запись "${args.id}" не найдена. Используй list/search для id.`
          }

          if (action === "thread" && args.id && args.text) {
            const res = locked("thread", (fresh) => {
              const k = fresh.knowledge.find((x) => x.id === args.id || x.id.startsWith(args.id))
              if (!k) {
                fresh.tokens.hitRate.misses++
                return { ok: false as const }
              }
              fresh.tokens.hitRate.hits++
              k.thread = k.thread || []
              // UC-018 + pentest C1: author тоже санитизируется (иначе store poisoning).
              const cleanComment = sanitizeOutputV3(args.text).slice(0, 500)
              const cleanAuthor = sanitizeOutputV3(args.author || "agent").slice(0, 80)
              k.thread.push({
                ts: new Date().toISOString(),
                author: cleanAuthor,
                text: cleanComment,
              })
              return { ok: true as const, kind: k.kind, ktext: k.text, cleanComment, cleanAuthor }
            })
            if (!res.ok) return `Запись "${args.id}" не найдена.`
            return `${C_ULTRA}${G_TOOL}${C_RST} Комментарий добавлен: [${res.kind}] ${res.ktext.slice(0, 60)}\n  ${C_WAIT}${G_MARK}${C_RST} ${res.cleanAuthor}: ${res.cleanComment.slice(0, 120)}`
          }

          if (action === "add" && args.text) {
            const labels = args.labels
              ? String(args.labels).split(",").map((s: string) => sanitizeOutputV3(s.trim()).slice(0, 80)).filter(Boolean)
              : ["manual"]
            // UC-018: секреты не персистятся и не печатаются.
            const cleanText = sanitizeOutputV3(args.text).slice(0, 1000)
            const cleanSource = typeof args.source === "string" ? sanitizeOutputV3(args.source) : undefined
            locked(`add ${args.kind || "fact"}`, (fresh) => {
              addKnowledge(fresh, {
                kind: args.kind || "fact",
                project: projectPath,
                text: cleanText,
                labels,
                source: cleanSource || undefined,
              })
            })
            return `${C_OPEN}${G_DONE}${C_RST} Знание добавлено: ${cleanText.slice(0, 80)}` + (cleanSource ? ` ${C_WAIT}(${G_MARK} source: ${cleanSource})${C_RST}` : "")
          }

          // ─── компактный режим ──────────────────────────────────
          if (action === "compact") {
            // принудительная автокомпакция с подсчётом сэкономленных токенов
            const before = store.knowledge.length
            const beforeTokens = store.knowledge.reduce((acc, k) => acc + tokens(k.text), 0)
            const beforeLessons = store.lessons.length
            const res = locked("compact", (fresh) => {
              autoCompact(fresh)
              const afterTokens = fresh.knowledge.reduce((acc, k) => acc + tokens(k.text), 0)
              const saved = Math.max(0, beforeTokens - afterTokens)
              fresh.tokens.compaction.saved += saved
              fresh.tokens.compaction.history.push({
                before: beforeTokens,
                after: afterTokens,
                saved,
                timestamp: new Date().toISOString(),
              })
              if (fresh.tokens.compaction.history.length > 20) fresh.tokens.compaction.history = fresh.tokens.compaction.history.slice(-20)
              return { afterTokens, saved, after: fresh.knowledge.length, afterLessons: fresh.lessons.length }
            })
            const { afterTokens, saved } = res
            const afterLessons = res.afterLessons
            const pct = beforeTokens > 0 ? Math.round((saved / beforeTokens) * 100) : 0
            const w = 32
            const lines: string[] = []
            lines.push(`${C_VIOLET}${G_CMP}${C_RST} Компактация памяти… ${C_WAIT}[${SPIN_DOTS[afterLessons % SPIN_DOTS.length]}]${C_RST}`)
            lines.push(`┌${"─".repeat(w)}┐`)
            const pad = (s: string, n: number) => (s + " ".repeat(Math.max(0, n - s.replace(/\x1b\[[0-9;]*m/g, "").length)))
            lines.push(`│ ${pad(`До: ${before} знаний │ После: ${store.knowledge.length}`, w - 4)} │`)
            lines.push(`│ ${pad(`До: ${beforeLessons} уроков │ После: ${afterLessons}`, w - 4)} │`)
            lines.push(`│ ${pad(`Экономия: ${pct}% │ Освобождено: ${C_OPEN}${tokK(saved)}${C_RST} токенов`, w - 10)} │`)
            lines.push(`│ ${pad(`Internal: ${tokK(beforeTokens)} → ${C_OPEN}${tokK(afterTokens)}${C_RST} токенов`, w - 10)} │`)
            if (before > store.knowledge.length) {
              const removed = before - store.knowledge.length
              lines.push(`│ ${pad(`Схлопнуто: ${removed} старых → выжимки`, w - 4)} │`)
            } else {
              lines.push(`│ ${pad("Свежие записи не тронуты", w - 4)} │`)
            }
            lines.push(`│ ${pad(`${C_WAIT}${G_TIME}${C_RST} Время: <1s`, w - 12)} │`)
            lines.push(`└${"─".repeat(w)}┘`)
            lines.push(`  ${fillPct(Math.max(0, Math.min(100, 100 - pct)), w)}`)
            lines.push(`${C_VIOLET}${G_CMP}${C_RST} Всего сэкономлено: ${C_OPEN}${tokK(store.tokens.compaction.saved)}${C_RST} tok. Смотри view для инъекции.`)
            return lines.join("\n")
          }

          // ─── контекст фермы ────────────────────────────────────
          if (action === "farm") {
            const farmState = path.join(projectPath, "farm", "knowledge", "state.md")
            try {
              if (fs.existsSync(farmState)) {
                // UC-021: явное чтение тоже идёт в модель — через firewall.
                return redactConfidentialV3(fs.readFileSync(farmState, "utf8"))
              }
              return "farm/knowledge/state.md не найден. Ферма не в этом проекте."
            } catch {
              return "Ошибка чтения state.md"
            }
          }

          // ─── оркестрационные планы (вне контекста, resume-подобные) ───
          // UC-002/UC-007/UC-017: goal + acceptance.command + dependsOn,
          // verify_required/failed, evidence-gate. Валидация — общим контрактом.
          if (action === "plan_new" && (args.text || args.goal || args.steps)) {
            let validated
            try {
              validated = validatePlanNewArgsV3(args)
            } catch (e) {
              return `${C_ERR}${G_ERR}${C_RST} invalid plan_new: ${String((e as Error).message).slice(0, 200)}`
            }
            const title = validated.goal.split("\n")[0].slice(0, 120)
            // UC-021: plan-поля персистятся и инжектятся — санитизируем на входе.
            const planReq = {
              base: args.plan && String(args.plan).trim().length > 0
                ? String(args.plan).trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-")
                : `plan-${Date.now().toString(36)}`,
              title: sanitizeOutputV3(title).slice(0, 120),
              goal: sanitizeOutputV3(validated.goal),
              steps: validated.steps.map((t) => sanitizeOutputV3(t)),
              stepChecks: validated.stepChecks,
              dependsOn: validated.dependsOn,
              acceptanceCommand: validated.acceptanceCommand
                ? sanitizeOutputV3(validated.acceptanceCommand)
                : validated.acceptanceCommand,
            }
            let plan: Plan
            // UC-023: явный acceptanceCommand важнее автоопределения;
            // дефолт берём из детекта стека, иначе план остаётся без acceptance.
            let autoAcceptance: string | null = null
            try {
              plan = locked(`plan_new ${planReq.base}`, (fresh) => {
                const id = fresh.plans[planReq.base] ? `${planReq.base}-${Date.now().toString(36)}` : planReq.base
                const depOf = (i: number): string[] | undefined => {
                  if (!planReq.dependsOn) return undefined
                  const raw = planReq.dependsOn[`s${i + 1}`] ?? planReq.dependsOn[String(i + 1)]
                  if (!Array.isArray(raw)) return undefined
                  return raw.map((d) => /^s\d+$/i.test(String(d)) ? String(d).toLowerCase() : `s${String(d).replace(/\D/g, "") || "?"}`)
                }
                const built: Plan = {
                  id,
                  ts: new Date().toISOString(),
                  title: planReq.title,
                  goal: planReq.goal,
                  steps: planReq.steps.map((text, i) => ({
                    id: `s${i + 1}`,
                    text: text.replace(/^[-*\d.)]+\s*/, "").slice(0, 200),
                    status: "todo",
                    attempts: 0,
                    ...(planReq.stepChecks?.[i] ? { check: sanitizeOutputV3(planReq.stepChecks[i]) } : {}),
                    ...(depOf(i) ? { dependsOn: depOf(i) } : {}),
                  })),
                  status: "active",
                  ...(planReq.acceptanceCommand ? { acceptance: { command: planReq.acceptanceCommand } } : {}),
                }
                if (!built.acceptance && fresh.stack?.testCommand) {
                  built.acceptance = { command: fresh.stack.testCommand }
                  autoAcceptance = `${fresh.stack.testCommand} (auto: ${fresh.stack.source})`
                }
                savePlanV3(fresh, built)
                return built
              })
            } catch (e) {
              return `${C_ERR}${G_ERR}${C_RST} invalid plan: ${String((e as Error).message).slice(0, 120)}`
            }
            return `${C_ULTRA}${G_PLAN}${C_RST} ${plan.id}: "${title}" (${plan.steps.length} шагов)\n` + plan.steps.map((s) => `  ${C_WAIT}${G_FUT}${C_RST} ${s.id} ${s.text}`).join("\n") +
              (autoAcceptance ? `\n  ◦ acceptance: ${autoAcceptance}` : "")
          }

          if (action === "plan_show") {
            const id = args.plan || Object.keys(store.plans).at(-1)
            if (!id || !store.plans[id]) return `${C_WARN}${G_SRCH}${C_RST} План не найден. Создай через plan_new.`
            const p = store.plans[id]
            const done = p.steps.filter((s) => s.status === "done").length
            const pct = p.steps.length > 0 ? Math.round((done / p.steps.length) * 100) : 0
            // история версий через git (последние коммиты по планам)
            const hist = git("log", "--oneline", "-5")
            const doneTime = done * 30 // ~30с на шаг
            const lines: string[] = []
            lines.push(`${C_ULTRA}${G_PLAN}${C_RST} План: "${p.title}" (${done}/${p.steps.length} шагов)`)
            lines.push(`  ${"─".repeat(46)}`)
            lines.push(
              ...p.steps.map((s) => {
                const cur = s.status === "in_progress" || s.status === "verify_required"
                const icon =
                  s.status === "done" ? `${C_OPEN}${G_DONE}${C_RST}`
                  : s.status === "verify_required" ? `${C_WARN}◉${C_RST}`
                  : cur ? `${C_ULTRA}${G_CUR}${C_RST}`
                  : s.status === "failed" ? `${C_ERR}${G_ERR}${C_RST}`
                  : `${C_WAIT}${G_FUT}${C_RST}`
                const tail = cur ? `  ${C_ULTRA}← текущий${C_RST}` : ""
                return `  ${icon} ${s.id} ${s.text}${tail}`
              }),
            )
            lines.push(`  ${"─".repeat(46)}`)
            lines.push(`  ${fillPct(pct, 12)} ${pct}%  ${C_WAIT}${G_TIME}${C_RST} ~${Math.max(1, Math.round(doneTime / 60))} мин потрачено`)
            // hit rate по шагам: сколько уже сделано — столько «попало» в память
            const hr = store.tokens.hitRate
            const hitPct = hr.hits + hr.misses > 0 ? Math.round((hr.hits / (hr.hits + hr.misses)) * 100) : 0
            lines.push(`  ${C_OPEN}${G_HIT}${C_RST} Hit rate: ${hitPct}% (${hr.hits} из ${hr.hits + hr.misses} в памяти)`)
            if (hist.ok && hist.out.trim()) {
              lines.push(`  ${C_WAIT}${G_HIST}${C_RST} History: ${hist.out.split("\n").slice(0, 3).join(" | ")}`)
            }
            return lines.join("\n")
          }

          if (action === "plan_step") {
            const id = args.plan || args.planId || Object.keys(store.plans).at(-1)
            if (!id) return `${C_ERR}${G_ERR}${C_RST} План не найден.`
            const wantStep = args.step || args.stepId || ""
            // UC-002/UC-007: безопасные переходы + запрет done без evidence.
            // UC-018: переход — под локом на свежем сторе.
            const to = (args.status || "done") as PlanStep["status"]
            let snap: { sid: string; stext: string; status: PlanStep["status"]; title: string; left: number } | null = null
            let err: string | null = null
            try {
              snap = locked(`plan_step ${id}`, (fresh) => {
                const p = fresh.plans[id]
                if (!p) throw new Error("План не найден.")
                const step = p.steps.find((s) => s.id === wantStep || s.text.startsWith(wantStep || ""))
                if (!step) throw new Error(`Шаг "${wantStep}" не найден. Смотри plan_show.`)
                transitionStepV3(p, step.id, to)
                addKnowledge(fresh, {
                  kind: "progress",
                  project: projectPath,
                  text: `plan ${p.id} ${step.id}: ${step.text.slice(0, 60)} → ${step.status}`,
                  labels: ["plan", p.id],
                })
                if (step.status === "done" && (p.steps.every((s) => s.status === "done") || p.steps.some((s) => s.id === GOAL_FAIL_STEP_ID))) {
                  // UC-036: «все шаги done» — необходимое, но не достаточное условие.
                  // Если гейт уже добавил gf, «все шаги done» уже ложь, а план всё равно не закрыт —
                  // вердикт выбирает сообщение, а не зелёные шаги.
                  const v = evaluateGoalV3(p)
                  if (!v.reached) {
                    addKnowledge(fresh, {
                      kind: "blocker",
                      project: projectPath,
                      text: `план "${p.title}" не закрыт: ${v.violations.join("; ")}`,
                      labels: ["plan", p.id],
                    })
                  } else if (v.skipped) {
                    addKnowledge(fresh, {
                      kind: "fact",
                      project: projectPath,
                      text: `план "${p.title}" закрыт (тривиальный, чек цели пропущен)`,
                      labels: ["plan", p.id],
                    })
                  } else {
                    addKnowledge(fresh, {
                      kind: "fact",
                      project: projectPath,
                      text: `план "${p.title}" завершён`,
                      labels: ["plan", p.id],
                    })
                  }
                }
                return {
                  sid: step.id,
                  stext: step.text,
                  status: step.status,
                  title: p.title,
                  left: p.steps.filter((s) => s.status !== "done").length,
                }
              })
            } catch (e) {
              err = String((e as Error).message).slice(0, 200)
            }
            if (!snap) return `${C_ERR}${G_ERR}${C_RST} ${err}. Добавь evidence через /verify.`
            const stepIcon = snap.status === "done" ? `${C_OPEN}${G_DONE}${C_RST}` : snap.status === "failed" ? `${C_ERR}${G_ERR}${C_RST}` : snap.status === "verify_required" ? `${C_WARN}◉${C_RST}` : `${C_ULTRA}${G_CUR}${C_RST}`
            return `${stepIcon} ${snap.sid} → ${snap.status}. ${snap.left} осталось.`
          }

          // UC-017 case 2: evidence через runtime tool schema — sanitize+clip,
          // exitCode 0 → done, иначе failed (+attempt). Персистентно в store.
          if (action === "evidence") {
            let ev
            try {
              ev = validateEvidenceArgsV3(args)
            } catch (e) {
              return `${C_ERR}${G_ERR}${C_RST} invalid evidence: ${String((e as Error).message).slice(0, 200)}`
            }
            const id = ev.planId || args.plan || Object.keys(store.plans).at(-1)
            if (!id) return `${C_ERR}${G_ERR}${C_RST} План не найден.`
            const built = createEvidenceV3(ev.command, ev.exitCode, ev.stdout, ev.stderr, ev.tool)
            // UC-029 sentinel: advisory-отчёт, ничего не меняет и не блокирует.
            // Видит новый evidence, чтобы syntax-чек ловил ошибки текущей попытки.
            const sentinelStep = store.plans[id]?.steps.find((s) => s.id === ev.stepId)
            const sentinel = sentinelStep
              ? sentinelCheckV3({ ...sentinelStep, evidence: [...(sentinelStep.evidence ?? []), built] }, projectPath)
              : null
            const sentinelNote =
              sentinel && sentinel.status !== "pass" && sentinel.status !== "skip"
                ? ` SENTINEL ${sentinel.status === "fail" ? "FAIL" : "WARN"}: ${sentinel.checks
                    .filter((c) => c.status === "fail" || c.status === "warn")
                    .map((c) => `${c.id} — ${c.detail}`)
                    .join("; ")}`
                : ""
            let done = false
            let summary: string | null = null
            // UC-036: шаг закрыт, но гейт цели не прошёл — сообщаем об этом в ответе.
            let goalFail = ""
            try {
              done = locked(`evidence ${id} ${ev.stepId} ${ev.exitCode}`, (fresh) => {
                const p = fresh.plans[id]
                if (!p) throw new Error("План не найден.")
                applyEvidenceV3(p, ev.stepId, built)
                const st = p.steps.find((s) => s.id === ev.stepId)
                // UC-024: осмысленная строка вместо голого exit code.
                summary = summarizeEvidenceV3(st?.evidence?.at(-1) ?? built)
                if (st?.status === "done") {
                  const v = evaluateGoalV3(p)
                  if (!v.reached) goalFail = ` GOAL_FAIL: цель не достигнута (${v.violations.join("; ")})`
                }
                return st?.status === "done"
              })
            } catch (e) {
              return `${C_ERR}${G_ERR}${C_RST} ${String((e as Error).message).slice(0, 200)}`
            }
            const tail = summary ? ` ${summary}` : ""
            return done
              ? `${C_OPEN}${G_DONE}${C_RST} ${ev.stepId} → done (exit 0).${tail}${goalFail}${sentinelNote}`
              : `${C_ERR}${G_ERR}${C_RST} ${ev.stepId} → failed (exit ${ev.exitCode}).${tail}${sentinelNote} Retry или blocker.`
          }

          // UC-020: /evaluate runtime — фиксированный allowlist-скрипт, без произвольного shell.
          // UC-026: --target <path> — portable-режим на чужой проект (только существующая директория).
          if (action === "evaluate") {
            const raw = String(args.text || args.q || "").trim()
            const flag = raw.includes("all") ? "--all" : "--smoke"
            let target: string | null = null
            const t = parseTargetV3(raw)
            if (t !== null) {
              const abs = path.resolve(projectPath, t)
              try {
                const realProject = fs.realpathSync(projectPath)
                const realTarget = fs.realpathSync(abs)
                // SEC-01: target must be within project or explicitly approved
                if (!realTarget.startsWith(realProject + path.sep) && realTarget !== realProject) {
                  return `${C_ERR}${G_ERR}${C_RST} evaluate: target outside project root requires explicit approval: ${t.slice(0, 120)}`
                }
                if (fs.statSync(realTarget).isDirectory()) target = realTarget
              } catch { /* ниже — явная ошибка */ }
              if (!target) return `${C_ERR}${G_ERR}${C_RST} evaluate: target is not a directory: ${t.slice(0, 120)}`
            }
            const argv = target
              ? ["scripts/evaluate-ultracode.sh", flag, "--target", target]
              : ["scripts/evaluate-ultracode.sh", flag]
            try {
              const cp = spawnSync("bash", argv, {
                cwd: projectPath,
                encoding: "utf8",
                timeout: target ? 1200000 : 240000,
              })
              const out = String(cp.stdout || cp.stderr || "").slice(-4000)
              const code = cp.status ?? 1
              return code === 0
                ? `${C_OPEN}${G_DONE}${C_RST} evaluate ${flag}: pass\n${out}`
                : `${C_ERR}${G_ERR}${C_RST} evaluate ${flag}: FAIL (exit ${code})\n${out}`
            } catch (e) {
              return `${C_ERR}${G_ERR}${C_RST} evaluate failed: ${String((e as Error).message).slice(0, 200)}`
            }
          }

          // UC-025: контракт «работающий проект» — таблица команд/null, read-only.
          if (action === "contract") {
            try {
              const c = detectContractV3(projectPath)
              if (!c) return `${C_WARN}${G_SRCH}${C_RST} Стек не определён: манифестов нет. Зафиксируй acceptance вручную.`
              return sanitizeOutputV3(JSON.stringify({
                stack: c.stack,
                dir: c.dir,
                source: c.source,
                commands: c.commands(),
              }))
            } catch (e) {
              return `${C_ERR}${G_ERR}${C_RST} contract failed: ${String((e as Error).message).slice(0, 200)}`
            }
          }

          return `${C_ULTRA}${G_PLAN}${C_RST} Actions: list, add, search, view, history, diff, close, thread, compact, farm, stats, tokens, budget, anim, plan_new, plan_show, plan_step, evidence, evaluate, contract, learn, lessons`
      }



    // ─── helper functions (ported from V1) ────────────────────────
    function addKnowledge(store: any, k: any): void {
      const dup = store.knowledge.find((x: any) => x.text === k.text && x.project === k.project && !x.archived)
      if (dup) return
      store.knowledge.push({ ...k, id: crypto.randomUUID(), ts: new Date().toISOString(), status: "open", archived: false })
      saveStoreAtomic(storeFileFor(projectPath), store)
    }

    function addLesson(store: any, k: any): void {
      const dup = store.lessons.find((x: any) => x.text === k.text && x.kind === k.kind && x.project === k.project)
      if (dup) return
      store.lessons.push({ ...k, id: crypto.randomUUID(), ts: new Date().toISOString() })
      if (store.lessons.length > 80) store.lessons = store.lessons.slice(-80)
      saveStoreAtomic(storeFileFor(projectPath), store)
    }

    function locked<T>(label: string, fn: (s: StoreV3) => T): T {
      const res = updateStoreFileV3(storeFileFor(projectPath), fn)
      try {
        const re = loadStoreV3(storeFileFor(projectPath))
        store.knowledge = re.knowledge
        store.plans = re.plans
        store.lessons = re.lessons
        store.tokens = re.tokens
        store.lastCompaction = re.lastCompaction
        store.lastInjection = re.lastInjection
        store.config = re.config
        store.stack = re.stack
        store.handoff = re.handoff
      } catch { /* best effort */ }
      return res
    }

    function saveStore(store: any, msg = "update"): void {
      try {
        saveStoreAtomic(storeFileFor(projectPath), store)
        commitStoreFile(`[ultracode] ${msg}`)
      } catch (e) {
        if (DEBUG) console.error("[ultracode] save failed:", (e as Error).message)
      }
    }


    // ─── tool registration (V2: ctx.tool.transform) ───────────────
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "ultracode_context",
        description: "Контекст-хранилище ultracode: как GitHub-репозиторий знаний.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: TOOL_ACTIONS_V3 as unknown as string[] },
            text: { type: "string" },
            kind: { type: "string", enum: ["decision", "fact", "progress", "blocker", "success", "lesson"] },
            plan: { type: "string" },
            planId: { type: "string" },
            step: { type: "string" },
            stepId: { type: "string" },
            status: { type: "string", enum: ["todo", "in_progress", "verify_required", "done", "failed"] },
            goal: { type: "string" },
            acceptanceCommand: { type: "string" },
            check: { type: "string" },
            command: { type: "string" },
            exitCode: { type: "number" },
            tool: { type: "string", enum: ["pytest", "cargo-test", "jest", "playwright", "node-test", "go-test", "phpunit", "custom"] },
            stdout: { type: "string" },
            stderr: { type: "string" },
            steps: { type: "string" },
            dependsOn: { type: "string" },
            source: { type: "string" },
            labels: { type: "string" },
            id: { type: "string" },
            q: { type: "string" },
            author: { type: "string" },
            number: { type: "number" },
            limit: { type: "number" },
            profile: { type: "string" },
            thresholdSoft: { type: "number" },
            thresholdHard: { type: "number" },
            thresholdEmergency: { type: "number" },
            on: { type: "boolean" },
          },
          required: [],
        },
        output: {
          type: "object",
          properties: {
            output: { type: "string" },
          },
        },
        execute: async (args: any, tctx: any) => {
          const _result = await _executeImpl(args, tctx)
          return typeof _result === "string" ? { output: _result } : _result
        },
      })

      // triage tool
      editor.add({
        name: "triage",
        description: "Найти профильные скиллы по короткому описанию задачи.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            query: { type: "string" },
            top: { type: "number" },
          },
          required: ["query"],
        },
        output: {
          type: "object",
          properties: {
            output: { type: "string" },
          },
        },
        execute: async (args: any) => {
          try {
            const top = Number(args?.top) > 0 ? Number(args?.top) : 10
            return { output: sanitizeOutputV3(skillTriageV3(String(args?.query ?? ""), top, projectPath)) }
          } catch (e) {
            return { output: `triage failed: ${String((e as Error).message).slice(0, 200)}` }
          }
        },
      })

      // recall_pruned tool
      editor.add({
        name: "recall_pruned",
        description: "Вернуть оригинал сообщения, сжатого context-pruner.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            messageID: { type: "string" },
            partID: { type: "string" },
          },
          required: ["messageID"],
        },
        output: {
          type: "object",
          properties: {
            output: { type: "string" },
          },
        },
        execute: async (args: any, tctx: any) => {
          try {
            const sid = (tctx as any)?.sessionID || "default"
            const messageID = String(args?.messageID ?? "").trim()
            if (!messageID) return { output: "recall_pruned: нужен messageID" }
            const file = prunedFileForV3(projectPath, sid)
            const partID = typeof args?.partID === "string" && args.partID !== "" ? args.partID : undefined
            const found = findOriginalsV3(file, messageID, partID)
            if (found.length === 0) {
              return { output: `оригинал ${messageID} не найден в pruned/ этой сессии` }
            }
            appendPinV3(file, messageID)
            const body = found.map((r: any) => `[${r.tool} partId=${r.partID} ${r.content.length} симв.]\\n${r.content}`).join("\\n\\n")
            const clipped = body.length > MAX_RECALL_CHARS
              ? `${body.slice(0, MAX_RECALL_CHARS)}\\n… ещё ${body.length - MAX_RECALL_CHARS} симв.`
              : body
            return { output: sanitizeOutputV3(clipped) }
          } catch (e) {
            return { output: `recall_pruned failed: ${sanitizeOutputV3(String(e instanceof Error ? e.message : e).slice(0, 200))}` }
          }
        },
      })

      // ultracode_verify_report tool
      editor.add({
        name: "ultracode_verify_report",
        description: "Верифицировать отчет агента против реальных артефактов (git diff, exit-коды).",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            report: { type: "string" },
            planId: { type: "string" },
            stepId: { type: "string" },
            evidence: { type: "string" },
          },
          required: ["report"],
        },
        output: {
          type: "object",
          properties: {
            output: { type: "string" },
          },
        },
        execute: async (args: any, tctx: any) => {
          let ev: any = {}
          if (args.evidence) {
            try {
              ev = JSON.parse(args.evidence)
            } catch {
              const result = verifyReportV3(args.report, {})
              // Override: mark all claims as REFUSED due to invalid evidence
              for (const c of result.claims) {
                c.verdict = "REFUSED"
                c.evidence = "invalid evidence format"
                c.source = "parse error"
              }
              result.valid = false
              result.summary = "Провал: invalid evidence format"
              return { output: JSON.stringify(result, null, 2) }
            }
          }
          const result = verifyReportV3(args.report, {
            exitCode: ev.exitCode,
            gitDiff: ev.gitDiff,
            files: ev.files,
            commands: ev.commands,
          })
          return { output: JSON.stringify(result, null, 2) }
        },
      })

      // ─── ultracode_delegate tool (Bolt 5) ───────────────────────
      const ALLOWED_AGENTS = new Set(["ultracode-planner", "ultracode-executor", "ultracode-reviewer", "ultracode-designer"])
      const inFlight = new Map<string, number>()
      const MAX_PARALLEL = 3

      editor.add({
        name: "ultracode_delegate",
        description: "Делегировать подзадачу дочерней сессии с выбором роли и модели.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            agent: { type: "string" },
            prompt: { type: "string" },
            providerID: { type: "string" },
            modelID: { type: "string" },
            preferFree: { type: "boolean" },
            planId: { type: "string" },
            stepId: { type: "string" },
          },
          required: ["agent", "prompt"],
        },
        output: {
          type: "object",
          properties: { output: { type: "string" } },
        },
        execute: async (args: any, tctx: any) => {
          const start = Date.now()
          const callerAgent = (tctx as any)?.agent ?? ""
          if (callerAgent !== "ultracode") {
            return { output: `${C_ERR}${G_ERR}${C_RST} delegate: только primary agent ultracode (caller=${callerAgent || "?"})` }
          }
          const agent = String(args?.agent ?? "").trim()
          if (!ALLOWED_AGENTS.has(agent)) {
            return { output: `${C_ERR}${G_ERR}${C_RST} delegate: недопустимый agent "${agent}"` }
          }
          const prompt = String(args?.prompt ?? "").trim()
          if (!prompt) {
            return { output: `${C_ERR}${G_ERR}${C_RST} delegate: пустой prompt` }
          }
          const parentID = (tctx as any)?.sessionID
          if (!parentID) {
            return { output: `${C_ERR}${G_ERR}${C_RST} delegate: нет sessionID` }
          }

          // model override (optional)
          let providerID = args?.providerID ? String(args.providerID).trim() : ""
          let modelID = args?.modelID ? String(args.modelID).trim() : ""
          let hasModel = !!(providerID && modelID)
          if ((providerID && !modelID) || (!providerID && modelID)) {
            return { output: `${C_ERR}${G_ERR}${C_RST} delegate: укажи оба providerID и modelID` }
          }
          if (hasModel) {
            let catalog: any = null
            try {
              const res = await ctx.provider?.list?.()
              catalog = Array.isArray(res) ? res : Object.values(res || {})
            } catch {
              return { output: `${C_ERR}${G_ERR}${C_RST} delegate: каталог моделей недоступен` }
            }
            let found = false
            for (const p of (catalog || [])) {
              const pid = (p as any)?.id
              const models = (p as any)?.models ?? {}
              if (pid === providerID && (models as any)[modelID]) { found = true; break }
            }
            if (!found) {
              return { output: `${C_ERR}${G_ERR}${C_RST} delegate: модель ${providerID}/${modelID} не найдена в каталоге` }
            }
          }

          // preferFree: если модель не указана явно, выбрать бесплатную из каталога OpenCode
          if (args?.preferFree === true && !hasModel) {
            try {
              const res = await ctx.provider?.list?.()
              const catalog = Array.isArray(res) ? res : Object.values(res || {})
              outer: for (const prov of (catalog || [])) {
                const pid = (prov as any)?.id
                const models = (prov as any)?.models ?? {}
                for (const mid of Object.keys(models)) {
                  if (isFreeModel(mid)) {
                    providerID = String(pid ?? "")
                    modelID = String(mid)
                    hasModel = true
                    break outer
                  }
                }
              }
            } catch { /* best effort — оставить без модели */ }
          }

          // concurrency gate
          const current = inFlight.get(parentID) ?? 0
          if (current >= MAX_PARALLEL) {
            return { output: `${C_WARN}${G_WARN}${C_RST} delegate: лимит ${MAX_PARALLEL} параллельных вызовов на сессию, дождись слота` }
          }
          inFlight.set(parentID, current + 1)

          const metricsFile = metricsFileFor(projectPath)
          let outcome = "error"
          let actualProvider = ""
          let actualModel = ""
          let childId = ""
          let aborted = false
          try {
            const child = await ctx.session.create({ parentID, agent, ...(hasModel ? { model: { providerID, modelID } } : {}) })
            childId = (child as any)?.id ?? ""
            if (!childId) throw new Error("session.create не вернул id")

            const abortSignal = (tctx as any)?.abort
            const onAbort = () => { aborted = true; try { if (ctx.session.interrupt) ctx.session.interrupt({ sessionID: childId }) } catch { /* best effort */ } }
            if (abortSignal) {
              if (abortSignal.aborted) onAbort()
              else abortSignal.addEventListener("abort", onAbort, { once: true })
            }

            let res: any
            try {
              res = await ctx.session.prompt({
                sessionID: childId,
                agent,
                ...(hasModel ? { model: { providerID, modelID } } : {}),
                parts: [{ type: "text", text: prompt }],
                text: prompt,
                signal: abortSignal,
              })
            } finally {
              if (abortSignal) abortSignal.removeEventListener("abort", onAbort)
            }

            // RequestResult envelope
            if (res && typeof res === "object" && "error" in res && res.error) {
              throw new Error(String((res.error as any)?.message ?? res.error).slice(0, 300))
            }
            const data = (res && typeof res === "object" && "data" in res) ? (res as any).data : res
            const info = (data as any)?.info ?? (data as any)?.message ?? {}
            if (info?.error) {
              throw new Error(String(info.error?.message ?? info.error).slice(0, 300))
            }
            actualProvider = String(info?.providerID ?? providerID ?? "")
            actualModel = String(info?.modelID ?? modelID ?? "")

            // Extract text parts
            const parts = (data as any)?.parts ?? (data as any)?.content ?? []
            let text = ""
            if (Array.isArray(parts)) {
              for (const p of parts) {
                if (p && typeof p === "object" && p.type === "text" && typeof p.text === "string") {
                  text += (text ? "\n" : "") + p.text
                } else if (typeof p === "string") {
                  text += (text ? "\n" : "") + p
                }
              }
            } else if (typeof parts === "string") {
              text = parts
            }
            if (!text && typeof (data as any)?.text === "string") text = (data as any).text
            if (!text && typeof (data as any)?.output === "string") text = (data as any).output

            const clipped = sanitizeOutputV3(text || "(пустой ответ)").slice(0, 4000)
            outcome = "ok"
            const modelLine = actualProvider && actualModel ? `\nmodel: ${actualProvider}/${actualModel}` : ""
            return { output: `${C_OPEN}${G_DONE}${C_RST} delegate ${agent}${modelLine}\n${clipped}` }
          } catch (e) {
            outcome = aborted ? "aborted" : "error"
            const msg = String((e as Error)?.message ?? e).slice(0, 400)
            return { output: `${C_ERR}${G_ERR}${C_RST} delegate ${agent}: ${msg}` }
          } finally {
            inFlight.set(parentID, Math.max(0, (inFlight.get(parentID) ?? 1) - 1))
            if ((inFlight.get(parentID) ?? 0) === 0) inFlight.delete(parentID)
            // telemetry (best effort, no prompt/output/secrets)
            try {
              appendMetricsV3(metricsFile, {
                ts: new Date().toISOString(),
                sessionId: String(parentID).slice(0, 64),
                tool: "ultracode_delegate",
                durationMs: Date.now() - start,
                isError: outcome !== "ok",
                agent,
                providerID: actualProvider || providerID,
                modelID: actualModel || modelID,
                outcome,
              })
              // extra dispatch fields appended manually to last line? keep minimal: MetricsLine has no agent/model.
              // Store dispatch outcome in metrics.jsonl as a separate minimal line is NOT allowed by MetricsLine schema.
              // We therefore record agent/model/duration/outcome only via console in debug mode; metrics stays bounded.
            } catch { /* best effort */ }
            if (DEBUG) console.error(`[ultracode] delegate ${agent} ${outcome} ${Date.now() - start}ms`)
          }
        },
      })

    })

    // ─── tool execute.after hook (V2) ─────────────────────────────
    await ctx.tool.hook("execute.after", async (event: any) => {
      try {
        if (event?.result) {
          deepRedactV3(event.result)
        }
      } catch (e) {
        console.error("[ultracode] deepRedact failed:", (e as Error).message)
        if (event?.result && typeof event.result === "object") {
          event.result = { output: "[redacted: redaction failed]" }
        }
      }
    })

    console.error("[ultracode] V2 plugin loaded successfully, project:", projectPath)
  },
})
