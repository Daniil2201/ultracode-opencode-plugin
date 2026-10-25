// UC-029 — Sentinel: дешёвые advisory-проверки шага плана перед фиксацией evidence.
// Ponytail: только node:fs/path/child_process, ноль зависимостей.
//
// Инварианты (см. spec/sentinel.md):
//   - НЕ пишет на диск и в стор. Только чтение.
//   - НЕ блокирует: ни один статус не меняет done/failed и не бросает.
//   - Единственный spawn — фиксированный `git status --porcelain`, shell:false,
//     без конкатенации пользовательского ввода (прецедент: plugin/ultracode.ts:230).
//   - Детали проходят redactConfidential; содержимое файлов в отчёт не попадает.
import * as fs from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import type { Evidence, PlanStep } from "./schema.ts"
import { redactConfidential } from "./confidential.ts"

export type SentinelStatus = "pass" | "warn" | "fail" | "skip"
export type SentinelCheckId = "empty-step" | "task-to-file" | "syntax" | "ghost-comments" | "changelog"

export interface SentinelCheck {
  id: SentinelCheckId
  status: SentinelStatus
  detail: string
}

export interface SentinelResult {
  status: SentinelStatus
  checks: SentinelCheck[]
  files: string[]
  durationMs: number
}

// Порядок хуже всего → skip не ухудшает.
const RANK: Record<SentinelStatus, number> = { pass: 0, skip: 0, warn: 1, fail: 2 }

// Сигнатуры ошибок компиляции/парсинга в выводе acceptance-команды.
const SYNTAX_SIGNS: RegExp[] = [
  /PHP Parse error/i,
  /syntax error,? unexpected/i,
  /\berror TS\d+/,
  /\bTS\d{4}:/,
  /\bParseError\b/,
  /\bSyntaxError\b/,
  /expected token/i,
  /unexpected token/i,
]
// Метка = тег, за которым идёт маркер (":", "(", "[" или конец строки): так детектор не
// стреляет по собственному литералу /\b(TODO|FIXME|…)\b/ и по «TODO/FIXME/…» в тексте.
// ponytail: известный ложноположительный — исходники самого sentinel и его тестов.
const GHOST_TAGS: RegExp = /\b(TODO|FIXME|HACK|XXX)\b(?=\s*[:(\[-]|$)/
const CHANGELOG_CATEGORIES = /^\s*[-*]?\s*(Added|Changed|Fixed|Removed|Deprecated)\b/m
const MAX_DETAIL = 200
const MAX_FILE_BYTES = 200_000
// Сколько «лишних» файлов показываем в detail.
const MAX_LISTED = 3
// Токены, похожие на путь к файлу: есть слэш или точка + известное расширение.
const PATH_LIKE = /(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w]{0,4}\b/g

type Spawn = typeof spawnSync

function detail(s: string): string {
  const clean = redactConfidential(s).replace(/\s+/g, " ").trim()
  return clean.length > MAX_DETAIL ? `${clean.slice(0, MAX_DETAIL)}…` : clean
}

function list(xs: string[]): string {
  const head = xs.slice(0, MAX_LISTED).join(", ")
  return xs.length > MAX_LISTED ? `${head} (+${xs.length - MAX_LISTED})` : head
}

// Фиксированный вызов: только git status, без shell.
function changedFiles(dir: string, spawn: Spawn): string[] | null {
  let r: ReturnType<Spawn>
  try {
    r = spawn("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", timeout: 10_000, shell: false })
  } catch {
    return null
  }
  if (r.status !== 0 || typeof r.stdout !== "string") return null
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.slice(3).trim())
    .map((l) => (l.includes("->") ? l.slice(l.indexOf("->") + 2).trim() : l))
}

// Файлы, объявленные в шаге. В PlanStep нет поля files (схему не расширяем),
// поэтому берём path-подобные токены из text и check.
function declaredFiles(step: PlanStep): string[] {
  const src = `${step.text ?? ""}\n${step.check ?? ""}`
  const out = new Set<string>()
  for (const m of src.matchAll(PATH_LIKE)) {
    const t = m[0].replace(/^[[(]+/, "")
    if (t.includes("/") || /\.(ts|tsx|js|json|sh|md|py|php|go|rs)$/i.test(t)) out.add(t)
  }
  return [...out]
}

function readFileSafe(file: string, root: string): string | null {
  const abs = path.isAbsolute(file) ? file : path.join(root, file)
  if (!abs.startsWith(path.resolve(root) + path.sep)) return null // не уходим наружу
  try {
    const st = fs.statSync(abs)
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
    return fs.readFileSync(abs, "utf8")
  } catch {
    return null
  }
}

function latestEvidence(step: PlanStep): Evidence | undefined {
  const ev = step.evidence
  return Array.isArray(ev) && ev.length ? ev[ev.length - 1] : undefined
}

function checkEmptyStep(step: PlanStep, declared: string[]): SentinelCheck {
  const id: SentinelCheckId = "empty-step"
  if (!step.text || !step.text.trim()) return { id, status: "fail", detail: "у шага нет текста цели" }
  if (!step.check?.trim() && declared.length === 0 && !latestEvidence(step)) {
    return { id, status: "fail", detail: "пустой шаг: нет acceptance/check, файлов и evidence" }
  }
  return { id, status: "pass", detail: "цель и acceptance заданы" }
}

function checkTaskToFile(declared: string[], changed: string[] | null): SentinelCheck {
  const id: SentinelCheckId = "task-to-file"
  if (changed === null) return { id, status: "skip", detail: "не git-репозиторий — изменения не определить" }
  if (changed.length === 0) return { id, status: "fail", detail: "ничего не изменено — шаг без правок" }
  // Сравнение по суффиксу: шаг может указывать .opencode/lib/x.ts, git — lib/x.ts.
  // Неотслеживаемая директория приходит как "lib/" и покрывает всё внутри неё.
  const matches = (d: string) =>
    changed.some((c) => c === d || c.endsWith(`/${d}`) || d.endsWith(`/${c}`) || (c.endsWith("/") && d.startsWith(c)))
  const extra = changed.filter((c) => !declared.some(matches))
  if (extra.length > 0) {
    return { id, status: "warn", detail: `вне шага изменено: ${list(extra)}` }
  }
  return { id, status: "pass", detail: `изменено в рамках шага: ${list(changed)}` }
}

function checkSyntax(ev: Evidence | undefined): SentinelCheck {
  const id: SentinelCheckId = "syntax"
  if (!ev) return { id, status: "skip", detail: "evidence нет — синтаксис не проверен" }
  if (ev.exitCode !== 0) {
    return { id, status: "fail", detail: `acceptance упала: exit ${ev.exitCode}` }
  }
  const hay = `${ev.stdout ?? ""}\n${ev.stderr ?? ""}`
  const hit = SYNTAX_SIGNS.find((re) => re.test(hay))
  if (hit) return { id, status: "fail", detail: `сигнатура ошибки в выводе: ${hit.source}` }
  return { id, status: "pass", detail: "ошибок компиляции/парсинга в выводе нет" }
}

function checkGhostComments(files: string[], root: string): SentinelCheck {
  const id: SentinelCheckId = "ghost-comments"
  const tags: string[] = []
  let commented = false
  for (const f of files) {
    const text = readFileSafe(f, root)
    if (text === null) continue
    const lines = text.split("\n")
    if (lines.some((l) => GHOST_TAGS.test(l))) tags.push(f)
    // Эвристика «закомментированный код»: 3+ строк подряд с кодовыми символами.
    let run = 0
    for (const line of lines) {
      const isComment = /^\s*(\/\/|\*|\/\*)/.test(line)
      run = isComment && /[;{}]|=>|\bfunction\b|\breturn\b/.test(line) ? run + 1 : 0
      if (run >= 3) {
        commented = true
        break
      }
    }
  }
  if (tags.length > 0) {
    return { id, status: "fail", detail: `TODO/FIXME/HACK в изменённых файлах: ${list(tags)}` }
  }
  if (commented) return { id, status: "warn", detail: "похоже на закомментированный код (3+ строк)" }
  if (files.length === 0) return { id, status: "skip", detail: "нет файлов для скана" }
  return { id, status: "pass", detail: "ghost comments не найдены" }
}

function checkChangelog(changed: string[], root: string): SentinelCheck {
  const id: SentinelCheckId = "changelog"
  const file = changed.find((c) => path.basename(c).toLowerCase() === "changelog.md")
  if (!file) {
    const exists = fs.existsSync(path.join(root, "CHANGELOG.md"))
    if (!exists) return { id, status: "skip", detail: "CHANGELOG.md в проекте нет" }
    return { id, status: "warn", detail: "код изменён, CHANGELOG.md не тронут" }
  }
  const text = readFileSafe(file, root)
  if (text === null) return { id, status: "skip", detail: `не читается: ${file}` }
  if (!/^##\s*\[?Unreleased\]?/m.test(text)) {
    return { id, status: "fail", detail: "нет секции ## [Unreleased]" }
  }
  const section = text.split(/^##\s*\[?Unreleased\]?/m)[1] ?? ""
  if (!CHANGELOG_CATEGORIES.test(section)) {
    return { id, status: "fail", detail: "в [Unreleased] нет категории Added/Changed/Fixed/Removed/Deprecated" }
  }
  return { id, status: "pass", detail: "changelog корректен" }
}

export function sentinelCheck(step: PlanStep, projectDir: string, spawn: Spawn = spawnSync): SentinelResult {
  const started = Date.now()
  const root = path.resolve(projectDir)
  const declared = declaredFiles(step)
  const changed = changedFiles(root, spawn)
  const touched = [...new Set([...declared, ...(changed ?? [])])]

  const checks: SentinelCheck[] = [
    checkEmptyStep(step, declared),
    checkTaskToFile(declared, changed),
    checkSyntax(latestEvidence(step)),
    checkGhostComments(touched, root),
    checkChangelog(changed ?? [], root),
  ]

  const status = checks.reduce<SentinelStatus>(
    (worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst),
    "pass",
  )

  return { status, checks, files: touched, durationMs: Math.max(0, Date.now() - started) }
}
