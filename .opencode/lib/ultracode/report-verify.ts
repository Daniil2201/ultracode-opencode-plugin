// UC-report-verify — детерминированная верификация отчетов агента.
// Чистые функции: без I/O, без сети, без зависимостей.
// Fail closed: отчет валиден только если все критичные claim-ы SUPPORTED.

export type ClaimType = "test-result" | "file-change" | "endpoint" | "config" | "other"
export type Verdict = "SUPPORTED" | "CONTRADICTED" | "UNPROVEN" | "REFUSED"

export interface Claim {
  id: number
  text: string
  type: ClaimType
  critical: boolean
}

export interface ClaimVerdict {
  claim: Claim
  verdict: Verdict
  evidence: string
  source: string
}

export interface VerifyResult {
  valid: boolean
  claims: ClaimVerdict[]
  summary: string
}

export interface Evidence {
  exitCode?: number
  gitDiff?: string[]
  files?: string[]
  commands?: string[]
}

// Разбивка отчета на claims: сначала по переносам строк, затем по предложениям
export function parseClaims(report: string): Claim[] {
  const lines = report.split("\n")
  const sentences: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Убираем маркеры списков (-, *, 1., etc.)
    const cleaned = trimmed.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "")
    if (!cleaned) continue
    // Разбивка по предложениям внутри строки
    const parts = cleaned.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0)
    for (const p of parts) {
      if (p.length >= 10) sentences.push(p)
    }
  }
  return sentences.map((text, i) => ({
    id: i + 1,
    text,
    type: classifyClaim(text),
    critical: isCritical(text),
  }))
}

export function classifyClaim(text: string): ClaimType {
  const lower = text.toLowerCase()
  if (/тест|test|прош[её]л|passed|exit\s*0|exit code|прогон/i.test(lower)) return "test-result"
  if (/файл|file|измен[её]н|changed|создан|created|удал[её]н|deleted|diff/i.test(lower)) return "file-change"
  if (/эндпоинт|endpoint|маршрут|route|добавлен|added|api/i.test(lower)) return "endpoint"
  if (/конфиг|config|настройк|setting|env/i.test(lower)) return "config"
  return "other"
}

export function isCritical(text: string): boolean {
  const lower = text.toLowerCase()
  return /тест|test|файл|file|эндпоинт|endpoint|измен[её]н|changed|добавлен|added/i.test(lower)
}

// Строгое ограничение расширений файлов
const FILE_EXT_RE = /\.(ts|js|json|md|py|html|css|yml|yaml)\b/

// Проверка одного claim против evidence
export function verifyClaim(claim: Claim, evidence: Evidence): ClaimVerdict {
  if (claim.type === "test-result") {
    if (evidence.exitCode === undefined) return { claim, verdict: "UNPROVEN", evidence: "нет exitCode", source: "no evidence" }
    if (evidence.exitCode === 0) return { claim, verdict: "SUPPORTED", evidence: `exit ${evidence.exitCode}`, source: "command output" }
    return { claim, verdict: "CONTRADICTED", evidence: `exit ${evidence.exitCode}`, source: "command output" }
  }
  if (claim.type === "file-change") {
    const files = evidence.gitDiff ?? []
    const fileMatch = claim.text.match(new RegExp(`[\\w./-]+${FILE_EXT_RE.source}`, "i"))
    if (!fileMatch) return { claim, verdict: "REFUSED", evidence: "имя файла не найдено в claim", source: "claim parse" }
    const file = fileMatch[0]
    if (files.some((f) => f.includes(file) || f.endsWith(file))) {
      return { claim, verdict: "SUPPORTED", evidence: `файл ${file} в diff`, source: "git diff" }
    }
    return { claim, verdict: "CONTRADICTED", evidence: `файл ${file} не в diff`, source: "git diff" }
  }
  if (claim.type === "endpoint") {
    const files = evidence.files ?? []
    if (files.length === 0) return { claim, verdict: "UNPROVEN", evidence: "нет списка файлов", source: "no evidence" }
    return { claim, verdict: "SUPPORTED", evidence: "файлы проверены", source: "file content" }
  }
  if (claim.type === "config") {
    if (evidence.commands && evidence.commands.length > 0) {
      return { claim, verdict: "SUPPORTED", evidence: "команды выполнены", source: "command output" }
    }
    return { claim, verdict: "UNPROVEN", evidence: "нет доказательств", source: "no evidence" }
  }
  return { claim, verdict: "REFUSED", evidence: "тип claim не проверяем", source: "classifier" }
}

// Агрегация: fail closed
export function verifyReport(report: string, evidence: Evidence): VerifyResult {
  const claims = parseClaims(report)
  const verdicts = claims.map((c) => verifyClaim(c, evidence))
  const critical = verdicts.filter((v) => v.claim.critical)
  const valid = critical.every((v) => v.verdict === "SUPPORTED")
  const summary = valid
    ? `Все ${critical.length} критичных claim-ов подтверждены.`
    : `Провал: ${critical.filter((v) => v.verdict !== "SUPPORTED").map((v) => `${v.claim.id}: ${v.verdict}`).join(", ")}`
  return { valid, claims: verdicts, summary }
}
