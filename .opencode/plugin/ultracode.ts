// Ultracode — универсальный оркестратор my-manager.
//
// Не только код. Опирается на задачу пользователя, разбивает, выбирает
// инструменты/скилы/MCP, доводит до проверяемого результата.
//
// Ключевые способности:
// 1. Контекст-хранилище v3 (GitHub-стиль + принцип моделей): записи как issues
//    (labels/метки, source-цитаты, треды, статус open/closed), хранится в git-репо
//    (история/diff через git), инъекция ранжированная в токен-бюджете, старые
//    автокомпактятся в digest, видимость (view) показывает что влезло в модель.
// 2. Автосжатие контекста: хук experimental.session.compacting синтезирует
//    компактную выжимку из контекст-хранилища, чтобы LLM не потерял суть.
// 3. Связь со ВСЕМ: ponytail-режим, farm.ts, quality-gate, tg-manager MCP,
//    agentmemory MCP, CodeGraph, любые установленные плагины/скилы.
// 4. Команда /farm — мгновенное подключение к контексту фермы.
//
// Ponytail: тонкий плагин-оркестратор. Тяжёлая логика — в ../lib/ultracode/*,
// чтобы её покрывали тесты без загрузки плагина.

import { type Plugin, tool } from "@opencode-ai/plugin"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { freshStore as freshStoreV3, migrateStore as migrateStoreV3 } from "../lib/ultracode/schema.ts"
import type { ContextStore as StoreV3, Knowledge as KnowledgeV3, Lesson as LessonV3, Plan as PlanV3, PlanStep as PlanStepV3 } from "../lib/ultracode/schema.ts"
import { loadStoreFor as loadStoreForProject, saveStore as saveStoreAtomic, loadStore as loadStoreV3, updateStoreFile as updateStoreFileV3, storeFileFor, pickProjectDir, metricsFileFor, storeRoot } from "../lib/ultracode/store.ts"
import { injectOnce as injectOnceV3, markerFor as markerForV3 } from "../lib/ultracode/injection.ts"
import { tokens, isRealTokenizer } from "../lib/ultracode/tokens.ts"
import { renderSections as renderSectionsV3, pickKnowledge as pickKnowledgeV3, pickLessons as pickLessonsV3 } from "../lib/ultracode/injection.ts"
import { getSessionMetrics as getSessionMetricsV3, toolArgs as toolArgsV3, isErrorOutput as isErrorOutputV3, appendMetrics as appendMetricsV3, classifyTool as classifyToolV3, addToolTokensByKind as addToolTokensByKindV3 } from "../lib/ultracode/metrics.ts"
import { transitionStep as transitionStepV3, savePlan as savePlanV3, evaluateGoal as evaluateGoalV3, GOAL_FAIL_STEP_ID } from "../lib/ultracode/plan.ts"
import { createEvidence as createEvidenceV3, applyEvidence as applyEvidenceV3, sanitizeOutput as sanitizeOutputV3, summarizeEvidence as summarizeEvidenceV3 } from "../lib/ultracode/verification.ts"
import { TOOL_ACTIONS as TOOL_ACTIONS_V3, validateEvidenceArgs as validateEvidenceArgsV3, validatePlanNewArgs as validatePlanNewArgsV3 } from "../lib/ultracode/runtime-contract.ts"
import { buildCheckpoint as buildCheckpointV3, checkpointKey as checkpointKeyV3 } from "../lib/ultracode/checkpoint.ts"
import { usageFor, addModelUsage, evaluate as evaluateBudgetV3, resolveLimit as resolveLimitV3, thresholdsFrom as thresholdsFromV3, THRESHOLD_PROFILES as THRESHOLD_PROFILES_V3 } from "../lib/ultracode/budget.ts"
import type { Usage as UsageV3 } from "../lib/ultracode/budget.ts"
// context-pruner: сжатие истории перед запросом. Ядро чистое (тестируется без
// плагина), здесь только хук, гейт эпох и стор оригиналов.
import { planPrune as planPruneV3, applyPrune as applyPruneV3, levelFor as levelForV3, originalContent as originalContentV3, PRUNE_EPOCH_TURNS as PRUNE_EPOCH_TURNS_V3 } from "../lib/ultracode/pruner.ts"
import { prunedFileFor as prunedFileForV3, appendOriginal as appendOriginalV3, appendPin as appendPinV3, loadPins as loadPinsV3, findOriginals as findOriginalsV3 } from "../lib/ultracode/prune-store.ts"
import { buildHandoff as buildHandoffV3, writeHandoff as writeHandoffV3, readHandoff as readHandoffV3 } from "../lib/ultracode/handoff.ts"
import { redactConfidential as redactConfidentialV3, deepRedact as deepRedactV3 } from "../lib/ultracode/confidential.ts"
import { AUTONOMY_TAG as AUTONOMY_TAG_V3 } from "../lib/ultracode/autonomy.ts"
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
import type { DetectedStack as DetectedStackV3 } from "../lib/ultracode/stack-detect.ts"

declare const process: {
  cwd(): string
  env: Record<string, string | undefined>
  pid: number
}

const DEBUG = process.env.OPENCODE_ULTRACODE_DEBUG === "1"
// Стор уважает XDG_DATA_HOME (песочницы/тесты) — иначе живёт в ~/.local/share.
const STORE_DIR = process.env.XDG_DATA_HOME
  ? path.join(process.env.XDG_DATA_HOME, "opencode", "ultracode")
  : path.join(os.homedir(), ".local", "share", "opencode", "ultracode")
// Legacy single-file (миграция v2 -> per-project v3). Новые данные — только per-project.
const STORE_FILE = path.join(STORE_DIR, "context.json")

// ─── контекст-хранилище v3 ─────────────────────────────────────────
// Типы — из ../lib/ultracode/schema.ts (единственный источник правды).
// Локальные алиасы оставлены для совместимости тела плагина.
type Knowledge = KnowledgeV3
type Lesson = LessonV3
type PlanStep = PlanStepV3
type Plan = PlanV3
type ContextStore = StoreV3

// Урок: зафиксированная ошибка/успех/вывод агента. Автонакапливаются
// (ошибки ловятся автоматически), затем агент возводит их в уроки через
// learn, и они инжектятся в следующие сессии — самообучение без ручных правил.
interface Lesson {
  id: string
  ts: string
  kind: "error" | "success" | "lesson"
  project: string
  text: string
  labels: string[]
}

// Что реально попало в модель в последней инъекции (видимость контекста).
interface InjectionReport {
  ts: string
  sessionID: string
  budgetTokens: number
  spentTokens: number
  injected: string[]        // id записей, которые влезли
  evicted: string[]         // id записей, которые не влезли (или closed/archived)
}

// Токены: Internal (наши знания) + External (контекст OpenCode). История по сессиям,
// hit rate — сколько раз память нашла ответ vs пришлось спрашивать LLM.
// Типы — из schema.ts; локальные алиасы для тела плагина.
import type { InjectionReport as InjectionReportV3, TokenStats as TokenStatsV3 } from "../lib/ultracode/schema.ts"
type TokenStats = TokenStatsV3
type InjectionReport = InjectionReportV3
import { freshTokens as freshTokensV3 } from "../lib/ultracode/schema.ts"

// Бюджет инъекции как у модели: не весь стор, а топ записей в пределах токенов.
const CONTEXT_BUDGET_TOKENS = 2000          // дефолт, переопределяется store.config.budgetTokens
const MAX_KNOWLEDGE = 200     // предел до автокомпакции (вместо жёсткого среза)
const MAX_LESSONS = 80
const DIGEST_AGE_DAYS = 30    // старше этого — кандидаты в digest

// ─── фирменный стиль (единый для веба и «десктопа») ─────────────
// Глифы из одного семейства Unicode-блоков: память ▤, сервис ◈, циклы ▣◉,
// стрелки ⇅⇉⇡, письмо ✎, метрики ↯❏◷▪⌘. Без эмодзи.
const C_ULTRA = "\x1b[34m"    // синий         Internal (память)
const C_OPEN  = "\x1b[32m"    // зелёный       External (сервис)
const C_ERR   = "\x1b[31m"    // красный       ошибка
const C_WAIT  = "\x1b[90m"    // серый         ожидание/служебное
const C_VIOLET= "\x1b[35m"    // фиолетовый    компактация/архив
const C_TOOL  = "\x1b[33;1m"  // оранжевый     вызов тула
const C_WARN  = "\x1b[33m"    // жёлтый        поиск/предупреждение
const C_RST   = "\x1b[0m"     // сброс

const G_MEM   = "▤"   // Ultracode · Internal (память)
const G_EXT   = "◈"   // OpenCode · External (сервис)
const G_WAIT  = "◌"   // ожидание (пустой круг)
const G_RANK  = "⇅"   // ранжирование
const G_INJ   = "⇉"   // инъекция (двойная стрелка внутрь)
const G_CMP   = "▣"   // компактация (закрашенный квадрат = сжато)
const G_SRCH  = "◉"   // поиск (прицел)
const G_ERR   = "✕"   // ошибка (чистый крест)
const G_SEND  = "⇡"   // отправка запроса
const G_GEN   = "✎"   // генерация
const G_TOOL  = "⌘"   // вызов тулы
// recall_pruned отдаёт оригинал в контекст — кап, чтобы один вызов не съел
// бюджет (та же конвенция, что у stdout в evidence: последние 4000 символов).
const MAX_RECALL_CHARS = 4000
const G_PLAN  = "≡"   // план
const G_DONE  = "✓"   // шаг выполнен
const G_CUR   = "▸"   // шаг текущий
const G_FUT   = "○"   // шаг будущий
const G_MARK  = "▪"   // маркер строки
const G_HIT   = "↯"   // hit rate
const G_HIST  = "❏"   // история
const G_TIME  = "◷"   // время / ETA
const G_CLOSE = "✕"   // закрыто (тоже крест, без эмодзи-варианта)

// спиннеры (кадры) — анимации на месте через \r
const SPIN_DOTS: string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPIN_LINE: string[] = ["─", "\\", "|", "/"]
const SPIN_PULSE: string[] = ["█", "▓", "▒", "░", "▒", "▓", "█"]
const SPIN_BOUNCE: string[] = ["●", "○"]
// ████████░░░░░░ — прогресс-бар (fill по ТЗ п.3)
function fillPct(pct: number, w = 10): string {
  const n = Math.round((w * Math.max(0, Math.min(100, pct))) / 100)
  return "█".repeat(n) + "░".repeat(w - n)
}
// компактные числа: 1560 → "1.6K"
function tokK(n: number): string {
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + "K"
  return String(n)
}
// краткая форма инъекции как в ТЗ п.7
function injShort(r: InjectionReport | null, budget: number): string {
  if (!r) return `${C_OPEN}${G_INJ}${C_RST} Инъекция ещё не была`
  const fill = budget > 0 ? Math.round((r.spentTokens / budget) * 100) : 0
  return `${C_OPEN}${G_INJ}${C_RST} Инъекция: ${r.injected.length} записей (${tokK(r.spentTokens)}) · Бюджет ${tokK(r.spentTokens)}/${tokK(r.budgetTokens)} (${fill}%) ${C_OPEN}${G_DONE}${C_RST}`
}

function freshTokens(): TokenStats {
  return freshTokensV3()
}

// UC-001: per-project store v3. Активный файл выбирается плагином под projectPath;
// модульные функции по умолчанию пишут в него (атомарно через lib).
let ACTIVE_STORE_FILE: string = STORE_FILE
function setActiveStoreFile(f: string): void {
  ACTIVE_STORE_FILE = f
}

// UC-032: наследование лимита/порогов для свежих проектов. Источник — стор с
// самым свежим mtime, у которого задан modelLimit. Формат хранения не меняется:
// копируются только значения в config нового стора. Возвращает true, если
// что-то унаследовал (вызывающий должен сразу сохранить — иначе инъекция
// перечитает файл без лимита).
function inheritConfig(store: ContextStore): boolean {
  if (store.config.modelLimit != null) return false
  try {
    const dir = path.join(storeRoot(), "projects")
    if (!fs.existsSync(dir)) return false
    let best: { mtime: number; cfg: ContextStore["config"] } | null = null
    for (const slug of fs.readdirSync(dir)) {
      try {
        const f = path.join(dir, slug, "context.json")
        const s = loadStoreV3(f)
        if (s.config.modelLimit == null) continue
        const st = fs.statSync(f)
        if (!best || st.mtimeMs > best.mtime) best = { mtime: st.mtimeMs, cfg: s.config }
      } catch { /* повреждённый стор пропускаем */ }
    }
    if (best) {
      const { modelLimit, thresholdSoft, thresholdHard, thresholdEmergency } = best.cfg
      Object.assign(store.config, { modelLimit, thresholdSoft, thresholdHard, thresholdEmergency })
      return true
    }
  } catch { /* наследование не блокирует запуск */ }
  return false
}

function ensureStore(projectRoot?: string): ContextStore {
  try {
    if (projectRoot) {
      const f = storeFileFor(projectRoot)
      setActiveStoreFile(f)
      const fresh = !fs.existsSync(f)
      const s = loadStoreForProject(projectRoot)
      // UC-032: свежий проект наследует modelLimit/пороги (иначе пороги спят,
      // estimated: true). Сразу сохраняем — инъекция перечитает файл с лимитом.
      if (fresh && inheritConfig(s)) saveStoreAtomic(f, s)
      return s
    }
    if (fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"))
      return migrateStoreV3(parsed)
    }
  } catch { /* пустой старт */ }
  return freshStoreV3()
}

// ─── Git-хранилище: версии и diff ────────────────────────────────────
// Стор живёт в git-репо: каждая saveStore = коммит, история и diff через
// git (бесплатные версии записей без своей системы контроля версий).
function storeGitDir(): string {
  try {
    return path.dirname(ACTIVE_STORE_FILE)
  } catch {
    return STORE_DIR
  }
}
function git(...args: string[]): { ok: boolean; out: string } {
  try {
    const cp = require("node:child_process").spawnSync("git", args, {
      cwd: storeGitDir(),
      encoding: "utf8",
      timeout: 5000,
    })
    if (cp.status === 0) return { ok: true, out: (cp.stdout || "").trim() }
    return { ok: false, out: (cp.stderr || "").trim().slice(0, 300) }
  } catch (e) {
    return { ok: false, out: String((e as Error).message).slice(0, 300) }
  }
}

function ensureGitRepo(): void {
  try {
    const dir = storeGitDir()
    if (!fs.existsSync(path.join(dir, ".git"))) {
      fs.mkdirSync(dir, { recursive: true })
      git("init", "-q")
      // локальная идентичность — коммиты не уходят в сеть
      git("config", "user.email", "ultracode@local")
      git("config", "user.name", "ultracode")
      git("config", "commit.gpgsign", "false")
    }
  } catch { /* git может быть недоступен — стор работает и без него */ }
}

// UC-001: атомарно через tmp+rename (lib), обрезанный context.json невозможен.
function saveStore(store: ContextStore, msg = "update"): void {
  try {
    saveStoreAtomic(ACTIVE_STORE_FILE, store)
    ensureGitRepo()
    git("add", path.basename(ACTIVE_STORE_FILE))
    const res = git("commit", "-q", "-m", `[ultracode] ${msg}`)
    if (DEBUG && !res.ok && !res.out.includes("nothing to commit")) {
      console.error("[ultracode] git:", res.out)
    }
  } catch (e) {
    if (DEBUG) console.error("[ultracode] save failed:", (e as Error).message)
  }
}

// ─── добавление записей с дедупликацией и лимитами ───────────────────

function addKnowledge(store: ContextStore, k: Omit<Knowledge, "id" | "ts" | "status" | "archived">): void {
  const dup = store.knowledge.find(
    (x) => x.text === k.text && x.project === k.project && !x.archived,
  )
  if (dup) return
  store.knowledge.push({
    ...k,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    status: "open",
    archived: false,
  })
  autoCompact(store)
  saveStore(store, `add ${k.kind}`)
}

// Автокомпакция как в модели: старые записи (>= DIGEST_AGE_DAYS) и архивные
// сворачиваются в одну digest-запись, свежий контекст остаётся в полном виде.
function autoCompact(store: ContextStore): void {
  if (store.knowledge.length <= MAX_KNOWLEDGE) return
  const now = Date.now()
  const old = store.knowledge.filter(
    (k) => k.archived || k.status === "closed" ||
      (now - new Date(k.ts).getTime()) > DIGEST_AGE_DAYS * 86400000,
  )
  if (old.length === 0) return
  // сохраняем открытые записи — срезаем до лимита только архив/закрытые/старые
  const keep = store.knowledge.filter((k) => !old.includes(k))
  if (keep.length < MAX_KNOWLEDGE * 0.6) return // не выбрасываем свежее ради лимита
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

// ─── раздел уроков (самообучение) ─────────────────────────────────

function addLesson(store: ContextStore, k: Omit<Lesson, "id" | "ts">): void {
  const dup = store.lessons.find(
    (x) => x.text === k.text && x.kind === k.kind && x.project === k.project,
  )
  if (dup) return
  store.lessons.push({
    ...k,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
  })
  // хранить не более 80 последних уроков
  if (store.lessons.length > MAX_LESSONS) {
    store.lessons = store.lessons.slice(-MAX_LESSONS)
  }
  saveStore(store, `learn ${k.kind}`)
}

function lessonsSnippet(store: ContextStore, projectPath: string): string | null {
  // Адаптер над pickLessonsV3 для compacting: тот же отбор, тот же бюджет 600
  // (бывший LESSONS_BUDGET_TOKENS — удалён, доля живёт в renderSections).
  const r = pickLessonsV3(store.lessons, projectPath, 600)
  return r.text || null
}

// ─── ранжирование и отбор — в lib/ultracode/injection.ts (Фаза 4, R.5) ───
// Здесь только тонкие адаптеры прежней формы для session.compacting
// (тело хука заморожено Фазой 3): та же сборка, те же бюджеты.
// ─── вес типа записи + вес метки → приоритет в инъекцию ────
// (веса, entryTokens, scoreKnowledge — в injection.ts; здесь был их дом до Фазы 4)

// ─── инъекция контекста: топ-N в токен-бюджете ───────────────────────
// Работает как контекст модели: ранжирует записи, берёт лучшее в бюджет,
// остальное не попадает в модель (и это видно в lastInjection → view).
function contextSnippet(
  store: ContextStore,
  projectPath: string,
  budgetTokens?: number,
): { snippet: string | null; report: InjectionReport } {
  // Адаптер над pickKnowledgeV3 для compacting: тот же отбор и бюджет.
  const budget = budgetTokens ?? store.config.budgetTokens
  const r = pickKnowledgeV3(store.knowledge, projectPath, budget)
  const report: InjectionReport = {
    ts: new Date().toISOString(),
    sessionID: "compacting",
    budgetTokens: budget,
    spentTokens: r.spent,
    injected: r.injected,
    evicted: r.evicted,
  }
  if (!r.text) return { snippet: null, report }
  return { snippet: r.text, report }
}

// ─── ponytail-инструкция ────────────────────────────────────────────

const PONYTAIL_TAG = `<ultracode-ponytail>
При любой задаче с кодом — сначала спроси себя: "Можно ли это сделать проще?". Лестница ponytail:
1. Существует ли уже в проекте? → найти и переиспользовать.
2. Стандартная библиотека? → stdlib/native.
3. Уже установленная зависимость? → не добавлять новую.
4. Одна строка? → одна строка.
5. Только тогда — писать новый код (минимально).
Если пользователь включил ponytail-режим (lite/full/ultra) — следуй соответствующему уровню.
Не добавляй непрошенных абстракций, boilerplate, scaffolding. Удаляй, не добавляй.
</ultracode-ponytail>`

// ─── skills-first: обязательный протокол выбора скиллов ──────────────
// Инжектится В КАЖДУЮ сессию (не только через агент-файл), чтобы агент
// загружал профильные скиллы до любой разработки.
// UC-032: полный блок available_skills срезан из system prompt ради экономии
// ~14k токенов (stripAvailableSkillsV3 ниже по потоку). Модель видит только
// короткий <skill_hint> с топ-3 — поэтому и инструкция здесь про hint, а не
// про полный список.
const SKILLS_TAG = `<ultracode-skills>
ПРАВИЛО SKILLS FIRST (обязательное): НИКАКАЯ разработка не начинается, пока не загружен подходящий скилл.
1. В <skill_hint> (топ-3 релевантных скилла на текущий запрос, инжектится автоматически) выбери подходящий по описанию/стеку/триггерным словам.
2. Если hint пустой или не подходит — вызови triage({ query: "<задача 3-10 слов>" }) для явного поиска; triage детерминированный, без сети.
3. Загрузи выбранный скилл через skill("имя") ДО написания кода; загружай 2-3 профильных, если задача многослойная.
4. Следуй воркфлоу скилла — не изобретай процесс заново.
5. В ответе укажи, какой скилл загрузил.
Полный список скиллов срезан из промпта ради экономии токенов — искать скиллы в нём нельзя, только в hint или через triage.
Примеры: React/TS → react-expert+typescript-pro; фича → add-feature; E2E → add-e2e-test; тесты → write-tests; ревью → code-reviewer; PHP → php-pro; Python → python-pro; Go → golang-pro; харден типов → harden-types; качество поста → quality-gate.
Если ни один скилл не подходит — работай по методу агента и зафиксируй урок через ultracode_context learn.
</ultracode-skills>`

// ─── farm-инъекция ──────────────────────────────────────────────────

const FARM_QUICK = `<farm-connect>
Контекст фермы my-manager доступен. Используй tg-manager MCP:
  get_knowledge state — состояние, get_knowledge pricing — прайс,
  get_knowledge reference — эталон, get_knowledge style — стиль.
  generate_post / quality_check / publish — создание/проверка/публикация.
  learn_channel / learn_style — обучение, fetch_history — история.
Ферма автономна: авто-шедулер learn→generate→quality-gate→publish.
Правило: НЕ трогай config.toml, НЕ выводи секреты, НЕ публикуй ниже порога.
</farm-connect>`

const FARM_STATE_CAP = 2000        // лимит символов при компакции (хук заморожен Фазой 3)

// ─── компактная выжимка для сжатия контекста ─────────────────────────

const COMPACTION_PREFIX = `<ultracode-compaction-context>
Это компактная выжимка предыдущей части разговора. Воспринимай как краткий
журнал решений и прогресса. Если сейчас решается та же задача — продолжай.
</ultracode-compaction-context>`

// ─── основной плагин ────────────────────────────────────────────────

export default (async (ctx) => {
  const projectPath =
    pickProjectDir((ctx as any).worktree, (ctx as any).directory, process.cwd())
  const store = ensureStore(projectPath)
  const injectedSessions = new Set<string>()
  const checkpointSeen = new Set<string>()
  // UC-032: последний текст пользователя — источник query для <skill_hint>.
  // В system.transform приходит только sessionID, поэтому берём текст из chat.message.
  const lastUserQuery = new Map<string, string>()
  const debugOn = (): boolean => process.env.OPENCODE_ULTRACODE_DEBUG === "1"
  const debugLog = (msg: string): void => {
    if (debugOn()) console.error(`[ultracode:skill-router] ${msg}`)
  }

  function log(...args: unknown[]) {
    if (DEBUG) console.error("[ultracode]", ...args)
  }

  // UC-003: идемпотентный push в system — по маркеру сессии, без дублей.
  function pushSystemOnce(system: unknown[], sid: string, tag: string, text: string): void {
    const marker = `${markerForV3(sid)}:${tag}`
    if ((system as unknown[]).some((x) => typeof x === "string" && (x as string).includes(marker))) return
    injectOnceV3(system as string[], `${sid}:${tag}`, `${marker}\n${text}`)
  }

  // UC-018 case 4: любая персистентность мутаций — reload-modify-save под
  // lockfile. In-memory копия после этого синхронизируется с файлом, чтобы
  // ранжирование/план_show видели чужие записи. Вложенных locked() нет
  // (внутри fn только чистые мутации + saveStore-free хелперы), дедлока нет.
    function locked<T>(label: string, fn: (s: ContextStore) => T): T {
    const res = updateStoreFileV3(ACTIVE_STORE_FILE, fn)
    try {
      const re = loadStoreV3(ACTIVE_STORE_FILE)
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
    try {
      ensureGitRepo()
      git("add", path.basename(ACTIVE_STORE_FILE))
      git("commit", "-q", "-m", `[ultracode] ${label}`)
    } catch { /* best effort */ }
    return res
  }

  // ─── Budget Manager (Фаза 3, R.3/R.4) ────────────────────────────
  // Аккумулятор usage — in-memory (сессия короткая, не персистим).
  // handoffWritten — handoff один раз на сессию (уточнение 2).
  const usageBySession = new Map<string, UsageV3>()
  const handoffWritten = new Set<string>()
  const sessionModel = new Map<string, { providerID: string; modelID: string }>()
  let limitsCache: Map<string, number> | null = null
  let limitsTried = false

  // context-pruner: состояние гейта эпох на сессию. turns считает ходы с
  // не-"off" уровнем, lastPruneTurn — ход последнего реального prune.
  // Прыжок уровня вниз (ok) сбрасывает lastLevel, иначе после отката бюджета
  // pruner больше никогда не включится на том же уровне.
  const pruneState = new Map<string, { turns: number; lastLevel: string; lastPruneTurn: number }>()
  // Сессия, для которой сейчас идёт компактация: следующий transform на ней
  // жать нельзя (портим саммари и дублируем стор).
  const compactionPending = new Set<string>()
  function pruneStateFor(sid: string): { turns: number; lastLevel: string; lastPruneTurn: number } {
    let st = pruneState.get(sid)
    if (!st) {
      st = { turns: 0, lastLevel: "off", lastPruneTurn: 0 }
      pruneState.set(sid, st)
    }
    return st
  }

  // Лимиты моделей: ctx.client.config.providers() → Provider.models[id].limit.context
  // (SDK gen types). Лениво, один раз на инстанс; провал → estimated-режим.
  async function loadLimits(): Promise<void> {
    if (limitsCache || limitsTried) return
    limitsTried = true
    try {
      const res = await (ctx as any).client?.config?.providers?.()
      const data = (res as any)?.data ?? res ?? {}
      const raw = (data as any)?.providers ?? {}
      const arr = Array.isArray(raw) ? raw : Object.values(raw)
      const m = new Map<string, number>()
      for (const p of arr as any[]) {
        const pid = (p as any)?.id
        const models = (p as any)?.models ?? {}
        for (const [mid, model] of Object.entries(models as Record<string, any>)) {
          const c = (model as any)?.limit?.context
          if (typeof pid === "string" && typeof c === "number" && c > 0) m.set(`${pid}/${mid}`, c)
        }
      }
      limitsCache = m
    } catch { limitsCache = new Map() }
  }

  function commitStoreFile(msg: string): void {
    try {
      ensureGitRepo()
      git("add", path.basename(ACTIVE_STORE_FILE))
      git("commit", "-q", "-m", msg)
    } catch { /* best effort */ }
  }

  function activePlanFresh(): Plan | null {
    try {
      const f = loadStoreV3(ACTIVE_STORE_FILE)
      const ids = Object.keys(f.plans)
      return ids.length ? (f.plans[ids[ids.length - 1] as string] ?? null) : null
    } catch { return null }
  }

  // Пороговая проверка. soft — только лог (сужение инъекции — Фаза 4).
  // hard/emergency — writeHandoff один раз на сессию (locked внутри нет:
  // writeHandoff сам делает updateStoreFile + коммит, вложенных locked нет).
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
    handoffWritten.add(sid)
    const summary = `${buildCheckpointV3(activePlanFresh())}\nreason: ${r.level} ${Math.round(r.pct)}%`
    writeHandoffV3(ACTIVE_STORE_FILE, buildHandoffV3(sid, r.level, Math.round(r.pct), summary), commitStoreFile)
    try {
      const re = loadStoreV3(ACTIVE_STORE_FILE)
      store.handoff = re.handoff
    } catch { /* best effort */ }
    if (r.level === "emergency") console.error("[ultracode] budget 75%, relying on session.compacting")
  }

  return {
    // ─── инъекция в системный промпт ─────────────────────────────
    "experimental.chat.system.transform": async (input: any, output: any) => {
      if (!Array.isArray(output?.system)) return
      const sid = (input as any)?.sessionID || "default"
      // UC-032: полный список скиллов (~17k токенов на 111 скиллов) уходит из промпта
      // на каждом сообщении; вместо него — короткий <skill_hint> с топ-3. Идемпотентно.
      try {
        const stripped = stripAvailableSkillsV3(output.system)
        if (stripped > 0) debugLog(`stripped <available_skills> x${stripped} (${sid})`)
        const hint = renderSkillHintV3(lastUserQuery.get(sid) ?? "", 3)
        if (hint) pushSystemOnce(output.system as unknown[], sid, "skill-hint", hint)
      } catch (e) {
        // Скоринг/сбор скиллов не должны ронять сессию.
        debugLog(`skill-hint failed: ${String((e as Error).message).slice(0, 200)}`)
      }
      // UC-003: повторный transform той же сессии — один блок, без дублей.
      if (injectedSessions.has(sid)) return
      const system = output.system as unknown[]

      // ponytail всегда
      pushSystemOnce(system, sid, "ponytail", PONYTAIL_TAG)

       // skills-first всегда: протокол выбора скиллов до любой разработки
       pushSystemOnce(system, sid, "skills", SKILLS_TAG)

       // autonomy guardrails: самостоятельность только внутри явных границ
       pushSystemOnce(system, sid, "autonomy", AUTONOMY_TAG_V3)

      // Handoff прошлой сессии — контекст восстановления (только чтение,
      // без evaluate: уточнение 1).
      const prev = readHandoffV3(store)
      if (DEBUG) console.error(`[ultracode] handoff inject: sid=${sid.slice(0, 8)} prev=${prev?.sessionId?.slice(0, 8) ?? "none"} decision=${prev && prev.sessionId !== sid ? "inject" : "skip"}`)
      if (prev && prev.sessionId !== sid) {
        pushSystemOnce(system, sid, "handoff",
          `<ultracode-handoff>\nПредыдущая сессия ${prev.sessionId.slice(0, 8)} прервана (${prev.reason}, ${String(prev.usagePct)}%):\n${prev.summary}\n</ultracode-handoff>`)
      }

      // Единая сборка контекста (Фаза 4, R.5): один renderSections вместо трёх
      // независимых капов. Soft → бюджет/2, hard+ → бюджет/4; estimated — без
      // ужима. evaluate только читает вердикт, writeHandoff отсюда запрещён.
      const usage = usageFor(usageBySession, sid)
      let totalBudget = store.config.budgetTokens
      try {
        await loadLimits()
        const mod = sessionModel.get(sid)
        const v = evaluateBudgetV3(
          usage,
          resolveLimitV3(store.config.modelLimit, limitsCache, mod?.providerID, mod?.modelID),
          thresholdsFromV3(store.config),
        )
        if (!v.estimated) {
          if (v.level === "soft") totalBudget = Math.floor(totalBudget / 2)
          else if (v.level === "hard" || v.level === "emergency") totalBudget = Math.floor(totalBudget / 4)
        }
      } catch { /* учёт не блокирует инъекцию */ }
      // farm-state: чтение + firewall здесь, резка — долей бюджета внутри.
      let farmRaw = ""
      try {
        const farmState = path.join(projectPath, "farm", "knowledge", "state.md")
        // UC-021: farm-state идёт в модель — пропускаем через firewall.
        if (fs.existsSync(farmState)) farmRaw = redactConfidentialV3(fs.readFileSync(farmState, "utf8").trim())
      } catch { /* нет фермы — ок */ }
      const assembled = renderSectionsV3(
        {
          knowledge: store.knowledge,
          lessons: store.lessons,
          plans: Object.values(store.plans),
          farm: farmRaw || undefined,
          project: projectPath,
        },
        totalBudget,
      )
      const [kSec, lSec, pSec, fSec] = assembled.sections
      if (kSec.text) pushSystemOnce(system, sid, "knowledge", `<ultracode-knowledge>\n${kSec.text}\n</ultracode-knowledge>`)
      if (lSec.text) pushSystemOnce(system, sid, "lessons", `<ultracode-lessons>\n${lSec.text}\n</ultracode-lessons>`)
      if (pSec.text) pushSystemOnce(system, sid, "plans", `<ultracode-plans>\n${pSec.text}\n</ultracode-plans>`)
      let farmTokens = 0
      if (fSec.text) {
        farmTokens = tokens(FARM_QUICK) + fSec.tokens
        pushSystemOnce(system, sid, "farm", `${FARM_QUICK}\n<farm-state>\n${fSec.text}\n</farm-state>`)
      }
      const injectedTokens = kSec.tokens
      const lessonsTokens = lSec.tokens
      const plansTokens = pSec.tokens
      // Фаза 4.5: своих оценок не копим — платформа отдаёт готовый total
      // в message.updated, дублировать его своими подсчётами нельзя.
      const report = {
        ts: new Date().toISOString(),
        sessionID: sid,
        budgetTokens: assembled.budgetTokens,
        spentTokens: assembled.totalTokens,
        injected: assembled.injected,
        evicted: assembled.evicted,
      }

      // UC-023: стек проекта — детект раз за сессию, persist только при изменении.
      // Явный acceptanceCommand пользователя всегда важнее этого дефолта.
      try {
        const detected = detectStackV3(projectPath)
        const same = JSON.stringify(detected ?? null) === JSON.stringify(store.stack ?? null)
        if (!same) {
          locked("stack detect", (fresh) => {
            if (detected) fresh.stack = detected
            else delete fresh.stack
          })
        }
        const cur: DetectedStackV3 | undefined = detected ?? store.stack
        if (cur) {
          const line = sanitizeOutputV3(
            `<ultracode-stack>stack=${cur.stack} dir=${cur.dir || "."} test=${cur.testCommand} src=${cur.source}` +
            `${cur.note ? ` note=${cur.note}` : ""}</ultracode-stack>`,
          )
          pushSystemOnce(system, sid, "stack", line)
        }
      } catch { /* детект не блокирует сессию */ }

      // statistics per session (Block 1) — персистентно под локом,
      // чтобы не затереть чужие plan/evidence (UC-018 case 4).
      try {
        const internalTotal = injectedTokens + lessonsTokens + farmTokens + plansTokens
        const systemText = (output.system as unknown[]).map(String).join("\n")
        const systemTokens = tokens(systemText)
        const injection = { ...report, sessionID: sid }
        locked(`inject ${sid.slice(0, 8)}`, (fresh) => {
          fresh.tokens.internal.current = internalTotal
          fresh.tokens.internal.byKind = {
            knowledge: injectedTokens,
            lessons: lessonsTokens,
            plans: plansTokens,
            farm: farmTokens,
          }
          fresh.tokens.internal.history.push({ sessionId: sid, size: internalTotal, timestamp: new Date().toISOString() })
          if (fresh.tokens.internal.history.length > 40) fresh.tokens.internal.history = fresh.tokens.internal.history.slice(-40)
          fresh.tokens.external.current = systemTokens
          const cur = fresh.tokens.external.history.find((h) => h.sessionId === sid)
          if (cur) { cur.system = systemTokens; cur.timestamp = new Date().toISOString() }
          else { fresh.tokens.external.history.push({ sessionId: sid, system: systemTokens, messages: 0, tools: 0, timestamp: new Date().toISOString() }) }
          if (fresh.tokens.external.history.length > 40) fresh.tokens.external.history = fresh.tokens.external.history.slice(-40)
          fresh.lastInjection = injection
        })
      } catch { /* не критично для инъекции */ }

      injectedSessions.add(sid)
      log("session", sid, "context injected")
    },

    // ─── context-pruner: сжатие истории перед запросом ─────────────
    // Хук НЕ ИМЕЕТ ПРАВА БРОСАТЬ: Plugin.trigger оборачивает его в
    // Effect.promise без catch, исключение здесь валит весь run. Всё тело — в
    // try/catch, catch только пишет в лог.
    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      try {
        const messages = output?.messages
        const sid = (Array.isArray(messages) && messages.length > 0 ? messages.at(-1)?.info?.sessionID : undefined) || "default"

        // Путь компактации: жать нельзя (ухудшаем саммари, дублируем стор).
        // Флаг снимается здесь же, до проверки на пустой массив: иначе пустой
        // transform после компактации оставил бы флаг висеть и отключил prune.
        if (compactionPending.has(sid)) {
          compactionPending.delete(sid)
          return
        }
        if (!Array.isArray(messages) || messages.length === 0) return

        await loadLimits()
        const mod = sessionModel.get(sid)
        const level = levelForV3(evaluateBudgetV3(
          usageFor(usageBySession, sid),
          resolveLimitV3(store.config.modelLimit, limitsCache, mod?.providerID, mod?.modelID),
          thresholdsFromV3(store.config),
        ).level)

        const st = pruneStateFor(sid)
        if (level === "off") {
          st.lastLevel = "off"
          return
        }
        st.turns++
        // Эпоха: не чаще раза в N ходов, иначе prompt cache инвалидируется
        // каждый ход. Первый не-"off" ход сжимает сразу — ждать 5 ходов при уже
        // переполненном бюджете незачем.
        if (st.lastPruneTurn > 0 && st.turns - st.lastPruneTurn < PRUNE_EPOCH_TURNS_V3) return
        // Тот же уровень повторно: правила уже применены, а транскрипт каждый ход
        // пересобирается заново — второй проход дал бы тот же результат и только
        // сжёг бы кеш.
        if (level === st.lastLevel) return

        const file = prunedFileForV3(projectPath, sid)
        const { messages: pruned, report } = planPruneV3(messages, level, { pinned: loadPinsV3(file) })
        if (report.actions.length === 0) return
        let stored = 0
        let failed = 0
        for (const a of report.actions) {
          const r = appendOriginalV3(file, {
            messageID: a.messageID,
            partID: a.partID,
            tool: a.tool,
            content: originalContentV3(messages, a.messageID, a.partID),
          })
          if (r === "stored") stored++
          else if (r === "failed") failed++
        }
        // Оригиналы не записались -> prune не применяем: плейсхолдер без
        // оригинала в сторе обещает recall, которого не будет. Следующая
        // эпоха попробует снова (уровень/счётчик намеренно не тронуты).
        if (failed > 0) {
          log("prune skipped", sid.slice(0, 8), `${failed}/${report.actions.length} originals unwritable`)
          return
        }
        st.lastLevel = level
        st.lastPruneTurn = st.turns
        // Только мутация на месте: вызывающий читает локальную переменную
        // массива, output.messages = [...] не пробрасывает ничего.
        applyPruneV3(output as { messages: unknown[] }, { messages: pruned })
        log("prune", level, sid.slice(0, 8), `${report.actions.length} parts (${stored} new), ${report.charsBefore}->${report.charsAfter} chars`)
      } catch (e) {
        // Текст ошибки через firewall: содержимое сообщений сюда попасть не должно.
        log("context-pruner failed:", redactConfidentialV3(e instanceof Error ? e.message : String(e)).slice(0, 200))
      }
    },

    // ─── автосжатие контекста ────────────────────────────────────
    "experimental.session.compacting": async (input: any, output: any) => {
      const sid = (input as any)?.sessionID || (input as any)?.id || "unknown"
      // context-pruner на этом же sid жать не должен: transform придёт сразу
      // после компактации, уже по сжатой истории. Флаг ставится ДО проверки
      // output: opencode всё равно компактит, даже если context не массив.
      compactionPending.add(sid)
      if (!Array.isArray(output?.context)) return

      // UC-010: checkpoint активного плана — только компактный summary, без дублей.
      try {
        const ids = Object.keys(store.plans)
        const active = ids.length ? (store.plans[ids[ids.length - 1] as string] ?? null) : null
        const key = active ? checkpointKeyV3(active) : "none"
        if (!checkpointSeen.has(`${sid}:${key}`)) {
          checkpointSeen.add(`${sid}:${key}`)
          // Pentest M6: checkpoint идёт в контекст — через firewall.
          ;(output.context as string[]).push(redactConfidentialV3(buildCheckpointV3(active)))
        }
      } catch { /* checkpoint не блокирует сжатие */ }

      // собираем компактную выжимку из контекст-хранилища
      const { snippet } = contextSnippet(store, projectPath)
      if (snippet) {
        ;(output.context as string[]).push(
          COMPACTION_PREFIX + "\n" + snippet,
        )
      }

      // уроки при сжатии не теряются
      const lessons = lessonsSnippet(store, projectPath)
      if (lessons) {
        ;(output.context as string[]).push(
          `<ultracode-lessons>\n${lessons}\n</ultracode-lessons>`,
        )
      }

      // добавляем текущий farm-state если есть (сжатие не должен его потерять)
      const farmState = path.join(projectPath, "farm", "knowledge", "state.md")
      try {
        if (fs.existsSync(farmState)) {
          const content = redactConfidentialV3(fs.readFileSync(farmState, "utf8").trim()).slice(0, FARM_STATE_CAP)
          ;(output.context as string[]).push(
            `<farm-state-compacted>\n${content}\n</farm-state-compacted>`,
          )
        }
      } catch { /* */ }

      // записываем что компактация произошла
      try {
        locked(`compact ${sid.slice(0, 8)}`, (fresh) => {
          fresh.lastCompaction[sid] = new Date().toISOString()
        })
      } catch { /* best effort */ }
      // Последний рубеж (R.4.2): платформенное сжатие без нашего hard-handoff —
      // пишем напрямую в обход handoffWritten (флага может не быть: другой процесс).
      try {
        const cur = readHandoffV3(store)
        if (!cur || cur.sessionId !== sid) {
          let pct = NaN
          const uu = usageBySession.get(sid)
          if (uu) {
            await loadLimits()
            const mod = sessionModel.get(sid)
            pct = evaluateBudgetV3(uu, resolveLimitV3(store.config.modelLimit, limitsCache, mod?.providerID, mod?.modelID)).pct
          }
          const ids = Object.keys(store.plans)
          const active = ids.length ? (store.plans[ids[ids.length - 1] as string] ?? null) : null
          writeHandoffV3(
            ACTIVE_STORE_FILE,
            buildHandoffV3(sid, "crash", pct,
              `${buildCheckpointV3(active)}\nreason: crash (platform compacted without hard threshold)`),
            commitStoreFile,
          )
        }
      } catch { /* handoff не блокирует сжатие */ }
      log("compacting session", sid)
    },

    // ─── перехват tool вызовов (связь с другими плагинами/MCP) ───
    "tool.execute.after": async (input: any, output: any) => {
      const tool = (input as any)?.tool || ""
      const sid = (input as any)?.sessionID || (input as any)?.sessionId || "default"
      const started = Number((input as any)?.started ?? Date.now())
      const durationMs = Math.max(0, Date.now() - started)

      // UC-004: session-scoped метрики — ищем историю строго по sessionID,
      // аргументы только из input.args, ошибки включая MCP isError.
      // UC-018: вся персистентность — одним locked-блоком (merge под локом).
      const args = toolArgsV3(input)
      const argText = JSON.stringify(args).slice(0, 2000)
      const outText = JSON.stringify(output).slice(0, 2000)
      const failed = isErrorOutputV3(output)
      // Фаза 4.5: своих оценок не копим (дублировали бы platform total).
      // Пороги проверяются в event, где приходит реальный usage.
      // UC-021: firewall — модель видит структуру ответа, секреты вырезаны
      // до модели. Рекурсивно по любой форме (C2): output/result/content/data.
      try {
        deepRedactV3(output)
      } catch { /* */ }
      // bounded агрегаты — в metrics.jsonl, а не в state.md (append-only, без лока)
      try {
        appendMetricsV3(metricsFileFor(projectPath), { ts: new Date().toISOString(), sessionId: sid, tool: String(tool), durationMs, isError: failed })
      } catch { /* */ }
      const skillName = tool === "skill"
        ? String((input as any)?.args?.name || (input as any)?.input?.name || "?").slice(0, 60)
        : null
      const farmStatus = tool.includes("generate_post") || tool.includes("quality_check") || tool.includes("publish")
        ? String((output as any)?.metadata?.status || "unknown")
        : null
      const errText = failed
        ? sanitizeOutputV3(String((output as any)?.metadata?.error || "unknown")).slice(0, 200)
        : null
      try {
        locked(`metrics ${sid.slice(0, 8)}`, (fresh) => {
          const row = getSessionMetricsV3(fresh, sid)
          const toolTokens = tokens(argText) + tokens(outText)
          row.tools += toolTokens
          // UC-033: та же сумма, но с разбивкой по типу тула (для решения про Headroom).
          addToolTokensByKindV3(row, classifyToolV3(String(tool)), toolTokens)
          row.timestamp = new Date().toISOString()
          if (skillName) {
            addKnowledge(fresh, {
              kind: "fact",
              project: projectPath,
              text: `загружен скилл: ${skillName}`,
              labels: ["skill", "usage", skillName],
            })
          }
          if (farmStatus) {
            addKnowledge(fresh, {
              kind: "progress",
              project: projectPath,
              text: `MCP ${tool} → ${farmStatus}`,
              labels: ["farm", "mcp", tool],
            })
          }
          if (errText) {
            addKnowledge(fresh, {
              kind: "blocker",
              project: projectPath,
              text: `tool ${tool} failed: ${errText}`,
              labels: ["error", tool],
            })
            addLesson(fresh, {
              kind: "error",
              project: projectPath,
              text: `Ошибка при ${tool}: ${errText}`,
              labels: ["error", tool],
            })
          }
        })
      } catch { /* */ }
    },

    // ─── перехват сообщений (автоматическое извлечение фактов) ────
    "chat.message": async (input: any, output: any) => {
      // UC-004: messages копим в истории текущей сессии по sessionID, не at(-1).
      // UC-018: персистентность — под локом.
      const sid = (input as any)?.sessionID || (input as any)?.sessionId || (output as any)?.sessionID || "default"
      const msgText = JSON.stringify(input).slice(0, 3000)
      const msgTokens = tokens(msgText)

      // UC-032: запоминаем текст пользователя для <skill_hint>. Только в памяти, без стора.
      for (const part of (output as any)?.parts || []) {
        if (part?.type !== "text" || part.synthetic) continue
        const text = String(part.text || "").trim()
        if (text.length > 0) {
          lastUserQuery.set(sid, text.slice(0, 2000))
          break
        }
      }

      // пользователь назвал решение или факт — сохраняем
      const parts = (output as any)?.parts || []
      let decision: string | null = null
      for (const part of parts) {
        if (part?.type !== "text" || part.synthetic) continue
        const text: string = part.text || ""
        if (text.length < 20) continue

        // ищем маркеры решений
        const decisionMatch = text.match(
          /(?:решени[ея]|вывод|итог|важно|запомни|fact:|decision:|решили)\s*[:—]\s*(.+)/i,
        )
        if (decisionMatch) {
          decision = sanitizeOutputV3(decisionMatch[1].trim()).slice(0, 500)
          break
        }
      }
      try {
        locked("chat", (fresh) => {
          const row = getSessionMetricsV3(fresh, sid)
          row.messages += msgTokens
          row.timestamp = new Date().toISOString()
          if (decision) {
            addKnowledge(fresh, {
              kind: "decision",
              project: projectPath,
              text: decision as string,
              labels: ["auto-extracted"],
            })
          }
        })
      } catch { /* */ }
      // Фаза 4.5: своих оценок не копим; пороги — в event по реальному total.
    },

    // ─── событийный хук (сессии) ─────────────────────────────────
    event: async ({ event }: any) => {
      const type = event?.type
      const props = event?.properties || {}

      // Budget Manager: info.tokens.total — готовый снимок диалога (Фаза 4.5).
      if (type === "message.updated") {
        const info = props.info ?? {}
        const msid = info.sessionID || info.sessionId || "default"
        addModelUsage(usageBySession, msid, info)
        if (typeof info.modelID === "string") {
          sessionModel.set(msid, { providerID: String(info.providerID ?? ""), modelID: info.modelID })
        }
        await checkBudget(msid)
        return
      }
      if (type === "message.part.updated") {
        const part = props.part ?? {}
        if (part.type === "step-finish" || part.type === "step_finish") {
          const msid = props.sessionID || props.sessionId || part.sessionID || "default"
          addModelUsage(usageBySession, msid, part)
          await checkBudget(msid)
        }
        return
      }

      if (type === "session.idle") {
        const sid = (props as any)?.sessionID || (props as any)?.sessionId || "unknown"
        // Пульс сессии — только timestamp строки в tokens.external.history.
        // Напрямую через updateStoreFileV3 (lib, без git-коммита): locked() здесь
        // нельзя — он коммитит `[ultracode] pulse` на каждый idle (R.0.1).
        // In-memory копия подтянется при следующем locked() (reload, :533-542).
        try {
          updateStoreFileV3(ACTIVE_STORE_FILE, (fresh) => {
            const row = getSessionMetricsV3(fresh, sid)
            row.timestamp = new Date().toISOString()
          })
        } catch { /* best effort */ }
      }
    },

    // ─── пользовательские инструменты ────────────────────────────
    tool: {
      // инструмент "context" — управление контекст-хранилищем ultracode и
      // оркестрационными планами. GitHub-подобно: метки/labels, поиск,
      // треды (thread), статус open/closed, версии через git (history/diff).
      ultracode_context: tool({
        description:
          "Контекст-хранилище ultracode: как GitHub-репозиторий знаний. " +
          "list — записи (метки/источники), add — добавить (source/labels), search — поиск (+hit rate), " +
          "view — что реально влезло в модель этой сессии (видимость контекста), " +
          "stats — дашборд токенов, tokens — краткая версия токенов, budget number — токен-бюджет, " +
          "anim on — анимации-снапшоты вкл/выкл, " +
          "history/diff — версии через git, close — закрыть запись, thread — комментарий, " +
          "compact — автокомпакция старых (+экономия токенов), farm — контекст фермы, " +
          "plan_new/plan_show/plan_step — оркестрационные планы (прогресс-бар в plan_show), " +
          "evidence — записать evidence шага (command, exitCode → done/failed), " +
          "evaluate — лабораторная оценка (/evaluate), " +
          "learn/lessons — самообучение.",
        args: {
          action: tool.schema.enum([
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
          ]),
          text: tool.schema.string().optional(),
          kind: tool.schema
            .enum(["decision", "fact", "progress", "blocker", "success", "lesson"])
            .optional(),
          plan: tool.schema.string().optional(),
          planId: tool.schema.string().optional(),
          step: tool.schema.string().optional(),
          stepId: tool.schema.string().optional(),
          // UC-017 case 3: verify_required принимается schema инструмента.
          status: tool.schema.enum(["todo", "in_progress", "verify_required", "done", "failed"]).optional(),
          goal: tool.schema.string().optional(),
          acceptanceCommand: tool.schema.string().optional(),
          check: tool.schema.string().optional(),
          command: tool.schema.string().optional(),
          exitCode: tool.schema.number().optional(),
          tool: tool.schema.enum(["pytest", "cargo-test", "jest", "playwright", "node-test", "go-test", "phpunit", "custom"]).optional(),
          stdout: tool.schema.string().optional(),
          stderr: tool.schema.string().optional(),
          steps: tool.schema.string().optional(),
          dependsOn: tool.schema.string().optional(),
          source: tool.schema.string().optional(),
          labels: tool.schema.string().optional(),
          id: tool.schema.string().optional(),
          q: tool.schema.string().optional(),
          author: tool.schema.string().optional(),
          number: tool.schema.number().optional(),
          limit: tool.schema.number().optional(),
          profile: tool.schema.string().optional(),
          thresholdSoft: tool.schema.number().optional(),
          thresholdHard: tool.schema.number().optional(),
          thresholdEmergency: tool.schema.number().optional(),
          on: tool.schema.boolean().optional(),
        },
        async execute(args: any, _context: any) {
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
            addLesson(store, {
              kind: args.kind === "success" ? "success" : "lesson",
              project: projectPath,
              text: clean,
              labels: ["manual", "learned"],
            })
            return `${C_OPEN}${G_DONE}${C_RST} Урок сохранён: ${clean.slice(0, 80)}`
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
                if (fs.statSync(abs).isDirectory()) target = abs
              } catch { /* ниже — явная ошибка */ }
              if (!target) return `${C_ERR}${G_ERR}${C_RST} evaluate: target is not a directory: ${t.slice(0, 120)}`
            }
            const argv = target
              ? ["scripts/evaluate-ultracode.sh", flag, "--target", target]
              : ["scripts/evaluate-ultracode.sh", flag]
            try {
              const cp = require("node:child_process").spawnSync("bash", argv, {
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
        },
      }),

      // UC-032: детерминированный поиск по скиллам. Заменяет 111 имён в промпте;
      // нативный skill при этом не блокируется — Skills FIRST продолжает работать.
      triage: tool({
        description:
          "Найти профильные скиллы по короткому описанию задачи. Вызывай, если подходящего " +
          "скилла не видно или нужен список альтернатив. Возвращает отсортированный список: " +
          "score, имя, источник, совпавшие слова. Детерминированно, без сети.",
        args: {
          query: tool.schema.string().describe("Краткое описание задачи, 3-10 слов"),
          top: tool.schema.number().optional().describe("Сколько вернуть, по умолчанию 10"),
        },
        async execute(args: any) {
          try {
            const top = Number(args?.top) > 0 ? Number(args?.top) : 10
            return sanitizeOutputV3(skillTriageV3(String(args?.query ?? ""), top, projectPath))
          } catch (e) {
            return `${C_WARN}${C_RST} triage failed: ${String((e as Error).message).slice(0, 200)}`
          }
        },
      }),

      // context-pruner: вернуть оригинал сжатого сообщения. Плейсхолдер в
      // истории всегда содержит messageId/partId для этого вызова. Pin: после
      // recall сообщение больше не жмётся (переживает рестарт — pin в jsonl).
      recall_pruned: tool({
        description:
          "Вернуть оригинал сообщения, сжатого context-pruner. Возьми messageId (и partID, если есть) " +
          "из плейсхолдера [pruned ...] в истории. Сообщение закрепляется и больше не сжимается.",
        args: {
          messageID: tool.schema.string().describe("id сообщения из плейсхолдера"),
          partID: tool.schema.string().optional().describe("id части; без него — все части сообщения"),
        },
        async execute(args: any, tctx: any) {
          try {
            const sid = (tctx as any)?.sessionID || (tctx as any)?.sessionId || "default"
            const messageID = String(args?.messageID ?? "").trim()
            if (!messageID) return `${C_WARN}${C_RST} recall_pruned: нужен messageID из плейсхолдера`
            const file = prunedFileForV3(projectPath, sid)
            const partID = typeof args?.partID === "string" && args.partID !== "" ? args.partID : undefined
            const found = findOriginalsV3(file, messageID, partID)
            if (found.length === 0) {
              return `${C_WARN}${G_SRCH}${C_RST} оригинал ${messageID} не найден в pruned/ этой сессии — контент уже удалён из контекста.`
            }
            appendPinV3(file, messageID)
            const body = found
              .map((r) => `[${r.tool} partId=${r.partID} ${r.content.length} симв.]\n${r.content}`)
              .join("\n\n")
            // Кап: recall возвращает в контекст ровно то, что pruner вынул, плюс
            // маркер — полная выдача одного part'а легко съедает бюджет.
            const clipped = body.length > MAX_RECALL_CHARS
              ? `${body.slice(0, MAX_RECALL_CHARS)}\n… ещё ${body.length - MAX_RECALL_CHARS} симв. в pruned/<sessionID>.jsonl`
              : body
            return sanitizeOutputV3(clipped)
          } catch (e) {
            return `${C_ERR}${G_ERR}${C_RST} recall_pruned failed: ${sanitizeOutputV3(String(e instanceof Error ? e.message : e).slice(0, 200))}`
          }
        },
      }),
    },
  }
}) satisfies Plugin
