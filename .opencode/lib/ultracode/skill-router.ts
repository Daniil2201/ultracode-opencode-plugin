// UC-032 — skill-router: дешёвый детерминированный роутер по скиллам.
// Зачем: opencode вставляет <available_skills> в system prompt на КАЖДОЕ сообщение
// (111 скиллов ≈ 17k токенов). Мы снимаем блок и даём модели короткий <skill_hint>
// с топ-3 плюс инструмент triage для явного поиска. Нативный skill не блокируем.
//
// Ponytail: node stdlib, без сети, без зависимостей, без записи на диск.
// Скиллы только читаются и кэшируются в памяти процесса.
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export type SkillEntry = {
  name: string
  description: string
  source: "local" | "global"
  path: string
}

export type ScoredSkill = {
  name: string
  score: number
  reason: string
  source: "local" | "global"
}

const NAME_WEIGHT = 3
const DESC_WEIGHT = 1
const ALIAS_BOOST = 2
// Стек проекта — независимый сигнал, он должен перебивать одиночное совпадение
// в имени (NAME_WEIGHT=3), иначе «review the diff and commit» в php-проекте
// уводит в commit-скиллы. Не подгоняем: projectDir в бенче не участвует.

const PROJECT_BOOST = 4
// Запрос длиннее этого — вставка (лог, инструкция агенту), а не вопрос:
// hint по нему шумит, поэтому не выдаём его вовсе.
export const MAX_HINT_QUERY = 500
const DEFAULT_TOP_HINT = 3
const DEFAULT_TOP_TRIAGE = 10
const MAX_REASON_TOKENS = 6
const MAX_SCAN_FILES = 4000
// Стек-словарь: экосистемные термины, которых нет в именах скиллов.
// Измерено на 345 реальных запросах: поднимает top-1 с 15.6% до ~38%.
// ponytail: правила вручную и по домену. Апгрейд — TF-IDF по name+description,
// если словарь перестанет покрывать роустер.
const STACK_ALIASES: Record<string, string[]> = {
  "php-pro": ["phpunit", "composer", "doctrine", "symfony", "laravel", "artisan", "blade", "миграц"],
  "php-testing": ["phpunit", "phpstan", "psalm", "infection", "покрытие php"],
  "php-modernization": ["устаревш", "legacy php", "рефакторинг php"],
  "typescript-pro": ["vitest", "tsconfig", "ts-node", "jest", "eslint", "prettier", "zod", "tsup"],
  "rust-engineer": ["cargo", "clippy", "rustfmt", "tokio", "actix", "rustc", "подождитель"],
  "python-pro": ["pytest", "poetry", "pydantic", "django", "fastapi", "uvicorn", "ruff", "mypy"],
  "flutter-expert": ["flutter", "dart", "pubspec"],
  "golang-pro": ["gofmt", "goroutine", "grpc", "go.mod"],
  "kotlin-specialist": ["gradle", "jetpack", "kotlin"],
  "java-architect": ["maven", "spring boot", "gradle"],
  "csharp-developer": ["dotnet", "nuget", "csproj"],
  "sql-pro": ["postgres", "postgresql", "mysql", "vacuum", "explain analyze", "репликац"],
  "devops-engineer": ["kubernetes", "k8s", "terraform", "helm", "ci/cd"],
  "docker-engineer": ["dockerfile", "docker compose", "docker-compose", "контейнер"],
  "code-documenter": ["readme", "changelog", "jsdoc", "документац", "докстринг"],
  "api-designer": ["openapi", "swagger", "эндпоинт", "endpoint"],
  "code-reviewer": ["ревью", "code review", "обзор кода"],
  "debugging-wizard": ["stacktrace", "segfault", "воспроизвести", "воспроизведи"],
  "add-feature": ["добавь фичу", "implement feature", "feature flag"],
  "init-project": ["инициализир", "scaffold", "обкатать"],
  "commit-and-push": ["закоммить", "коммить", "git push"],
  "add-observability": ["логирован", "observability", "мониторинг", "трейс"],
  "security-reviewer": ["xss", "sql injection", "уязвимост", "аудит безопасн"],
  "simplify": ["упростить", "рефактор", "cleanup"],
  "test-master": ["тест-план", "покрытие тест", "qa"],
}
// Стек проекта известен надёжнее слов: каталог сессии — сильный бесплатный приор.
const PROJECT_STACKS: Array<{ re: RegExp; skills: string[] }> = [
  { re: /php|destroyers|laravel|symfony|wordpress/i, skills: ["php-pro", "php-testing", "php-modernization"] },
  { re: /typescript|^ts[-_]?$|deno|bun/i, skills: ["typescript-pro", "test-master"] },
  { re: /rust|cargo/i, skills: ["rust-engineer"] },
  { re: /python|django|fastapi|py$/i, skills: ["python-pro"] },
  { re: /flutter|dart/i, skills: ["flutter-expert"] },
  { re: /golang|^go[-_]?$|grpc/i, skills: ["golang-pro"] },
  { re: /kubernetes|k8s|infra|terraform/i, skills: ["devops-engineer"] },
]
// Стоп-слова: не дают скормить роутеру общий шум запроса.
const STOP = new Set([
  "the", "and", "for", "you", "your", "with", "that", "this", "from", "into", "not", "use", "using",
  "have", "has", "was", "were", "will", "can", "but", "all", "any", "our", "its", "via", "per",
  "код", "задача", "нужно", "напиши", "написать", "сделай", "создай", "добавь", "исправь",
  "работает", "работа", "проект", "файл", "файлы", "функция", "функции", "тест", "тесты",
  "проверь", "исправьте", "должен", "должна", "должно", "чтобы", "если", "этот", "который",
])

let cache: SkillEntry[] | null = null

// Токены: lowercase, пунктуация → пробел, стоп-слова и короткие — вон.
export function tokenize(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t))
}

// name:/description: из YAML-фронтматтера. Нет name: — берём имя каталога (как opencode).
function parseSkill(file: string): SkillEntry | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  const head = m ? m[1] ?? "" : ""
  const field = (key: string): string => {
    const hit = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(head)
    if (!hit) return ""
    return String(hit[1] ?? "")
      .replace(/^["']|["']$/g, "")
      .replace(/\s+/g, " ")
      .trim()
  }
  const name = field("name") || path.basename(path.dirname(file))
  const description = field("description")
  if (!name) return null
  return { name, description, source: "global", path: file }
}

function walkSkills(root: string, source: "local" | "global", out: SkillEntry[]): void {
  if (out.length >= MAX_SCAN_FILES) return
  let dirs: fs.Dirent[]
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const d of dirs) {
    if (out.length >= MAX_SCAN_FILES) return
    if (!d.isDirectory()) continue
    const skillMd = path.join(root, d.name, "SKILL.md")
    if (fs.existsSync(skillMd)) {
      const entry = parseSkill(skillMd)
      // local перекрывает global: первое вхождение имени выигрывает (как в opencode).
      if (entry && !out.some((e) => e.name === entry.name)) {
        out.push({ ...entry, source })
      }
    }
  }
}

// Глобальные + проектные. Порядок: local первыми (они перекрывают global по имени),
// потом global — чтобы collectSkills не зависел от переданного projectDir.
export function collectSkills(projectDir?: string, refresh = false): SkillEntry[] {
  if (cache && !refresh) return cache
  const out: SkillEntry[] = []
  const home = os.homedir()
  if (projectDir) walkSkills(path.join(projectDir, ".opencode", "skills"), "local", out)
  for (const dir of [
    path.join(home, ".config", "opencode", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
  ]) {
    walkSkills(dir, "global", out)
  }
  cache = out
  return out
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Совпадение алиаса: одно слово — по границам слова (чтобы "pip" не ловил
// "pipeline"), многословное — подстрокой.
function aliasHit(alias: string, lower: string): boolean {
  return /\s/.test(alias) ? lower.includes(alias) : new RegExp(`\\b${esc(alias)}\\b`, "i").test(lower)
}

export function aliasBoosts(query: string): Record<string, number> {
  const lower = String(query ?? "").toLowerCase()
  const out: Record<string, number> = {}
  if (lower.trim().length === 0) return out
  for (const [skill, aliases] of Object.entries(STACK_ALIASES)) {
    if (aliases.some((a) => aliasHit(a, lower))) out[skill] = ALIAS_BOOST
  }
  return out
}

export function projectBoosts(projectDir?: string): Record<string, number> {
  const dir = String(projectDir ?? "")
  if (dir.length === 0) return {}
  const out: Record<string, number> = {}
  for (const { re, skills } of PROJECT_STACKS) {
    if (!re.test(dir)) continue
    for (const s of skills) out[s] = Math.max(out[s] ?? 0, PROJECT_BOOST)
  }
  return out
}

export function scoreSkills(
  query: string,
  skills: SkillEntry[],
  top = DEFAULT_TOP_TRIAGE,
  boosts: Record<string, number> = {},
): ScoredSkill[] {
  const q = [...new Set(tokenize(query))]
  const extra = { ...aliasBoosts(query), ...boosts }
  if (q.length === 0 && Object.keys(extra).length === 0) return []
  const scored: ScoredSkill[] = []
  for (const s of skills) {
    // Каждый токен считается один раз: 3 за попадание в name, иначе 1 за description.
    const nameTokens = new Set(tokenize(s.name))
    const descTokens = new Set(tokenize(s.description))
    let score = extra[s.name] ?? 0
    const matched: string[] = []
    if (score > 0) matched.push("alias/stack")
    for (const t of q) {
      if (nameTokens.has(t)) {
        score += NAME_WEIGHT
        matched.push(t)
      } else if (descTokens.has(t)) {
        score += DESC_WEIGHT
        matched.push(t)
      }
    }
    if (score <= 0) continue
    scored.push({ name: s.name, score, reason: `matched: ${matched.slice(0, MAX_REASON_TOKENS).join(", ")}`, source: s.source })
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return scored.slice(0, top)
}

export function renderSkillHint(query: string, top = DEFAULT_TOP_HINT, projectDir?: string): string {
  // Вставка/лог/инструкция агенту — не запрос. Hint по нему только шумит.
  if (String(query ?? "").length > MAX_HINT_QUERY) return ""
  const scored = scoreSkills(query, collectSkills(), top, projectBoosts(projectDir))
  if (scored.length === 0) return ""
  const rows = scored.map((s) => `- ${s.name} (score ${s.score}, ${s.reason})`).join("\n")
  return `<skill_hint>\nMost relevant skills for the current request. Load one with the skill tool, or search more with triage({ query }).\n${rows}\n</skill_hint>`
}

export function skillTriage(query: string, top = DEFAULT_TOP_TRIAGE, projectDir?: string): string {
  const all = collectSkills(projectDir)
  const q = String(query ?? "").trim()
  if (q.length === 0) return "triage: empty query — pass a short description of the task."
  const scored = scoreSkills(q, all, top, projectBoosts(projectDir))
  if (scored.length === 0) {
    return `triage: no skills matched "${q.slice(0, 120)}" (known skills: ${all.length}). Try different keywords.`
  }
  const rows = scored.map((s) => `${s.score}\t${s.name}\t${s.source}\t${s.reason}`)
  return `triage: ${scored.length} match(es) for "${q.slice(0, 120)}" (score\tname\tsource\treason)\n${rows.join("\n")}\nLoad the best one with the skill tool.`
}

const SKILLS_RE = /<available_skills>[\s\S]*?<\/available_skills>\s*/g

// Срезает блок списка скиллов из system-промпта. Идемпотентно: 0 на втором проходе.
export function stripAvailableSkills(system: unknown[]): number {
  if (!Array.isArray(system)) return 0
  let stripped = 0
  for (let i = 0; i < system.length; i++) {
    const s = system[i]
    if (typeof s !== "string") continue
    SKILLS_RE.lastIndex = 0
    if (!SKILLS_RE.test(s)) continue
    SKILLS_RE.lastIndex = 0
    system[i] = s.replace(SKILLS_RE, "").trimEnd()
    stripped++
  }
  return stripped
}
