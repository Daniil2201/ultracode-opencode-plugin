// UC-007 — evidence-gated verification. Шаг закрывается только evidence с exit 0.
// Плагин НЕ запускает произвольный shell автоматически — это делает агент/команда /verify.
import type { Evidence, EvidenceTool, FailureCause, Plan, TestCounts, TestFailure } from "./schema.ts"
import { redactConfidential } from "./confidential.ts"
import { transitionStep } from "./plan.ts"

export type { Evidence, EvidenceTool, FailureCause, Plan, TestCounts, TestFailure }
export const MAX_OUTPUT_CHARS = 4000
// Кап записей о падениях: скоринг использует веса, а не объём.
const MAX_FAILURES = 50
const MAX_FAILURE_ID = 200
const MAX_FAILURE_DETAIL = 500

// Единый firewall (UC-021): все секреты режутся здесь, вёрстка остаётся.
export function sanitizeOutput(text: string): string {
  return redactConfidential(text)
}

export function clipOutput(text: string | undefined, max: number = MAX_OUTPUT_CHARS): { text: string; truncated: boolean } {
  const s = sanitizeOutput(text ?? "")
  if (s.length <= max) return { text: s, truncated: false }
  return { text: s.slice(0, max), truncated: true }
}

export function createEvidence(
  command: string,
  exitCode: number,
  stdout?: string,
  stderr?: string,
  toolOverride?: string,
): Evidence {
  const out = clipOutput(stdout)
  const err = clipOutput(stderr)
  const parsed = parseTestOutput(command, stdout, stderr, toolOverride)
  return {
    command: sanitizeOutput(String(command)).slice(0, 500),
    exitCode,
    stdout: out.text || undefined,
    stderr: err.text || undefined,
    ts: new Date().toISOString(),
    truncated: out.truncated || err.truncated || undefined,
    tool: parsed.tool,
    ...(parsed.tests ? { tests: parsed.tests } : {}),
    ...(parsed.failures && parsed.failures.length > 0 ? { failures: parsed.failures } : {}),
    ...(parsed.coverage != null ? { coverage: parsed.coverage } : {}),
  }
}

// UC-024 — кросс-язычный разбор отчётов. Тотальная функция: не бросает,
// counts — только информация, гейтинг всегда по exitCode.
export function detectEvidenceTool(command: string): EvidenceTool {
  const cmd = String(command ?? "")
  if (/pytest|python\s+(?:-\w+\s+)*m\s+pytest|py\.test\b/i.test(cmd)) return "pytest"
  if (/cargo\s+(test|nextest)\b/i.test(cmd)) return "cargo-test"
  if (/\bjest\b/i.test(cmd)) return "jest"
  if (/playwright/i.test(cmd)) return "playwright"
  if (/^\s*node\b.*--test\b/i.test(cmd)) return "node-test"
  if (/\bgo\s+test\b/i.test(cmd)) return "go-test"
  if (/phpunit/i.test(cmd)) return "phpunit"
  return "custom"
}

export function isEvidenceTool(s: unknown): s is EvidenceTool {
  return s === "pytest" || s === "cargo-test" || s === "jest" || s === "playwright" ||
    s === "node-test" || s === "go-test" || s === "phpunit" || s === "custom"
}

// UC-027: веса причин провала. Порядок проверки в classifyFailure:
// environment → drift → flaky → code (неизвестное = полный вес, fail-closed).
export const FAILURE_WEIGHTS: Record<FailureCause, number> = {
  code: 1.0,
  drift: 0.5,
  environment: 0.3,
  flaky: 0.1,
}

const ENV_RE = /ConnectionError|ConnectTimeout|ReadTimeout|Timeout.*exceeded|timed?\s*out|(?<![A-Za-z])DNS(?![A-Za-z])|(?<![A-Za-z])ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|No route to host|network (is )?unreachable|Temporary failure in name resolution|(?<![A-Za-z])TLS|(?<![A-Za-z])SSL|certificate|(?<![A-Za-z])ProxyError|MaxRetryError|socket\.gaierror|NewConnectionError|ERR_CONNECTION/i
const DRIFT_RE = /ImportError|ModuleNotFoundError|No module named|cannot import name|AttributeError|DeprecationWarning|SyntaxError|version .* (not supported|incompatible|requires)|removed in/i
const FLAKY_RE = /flak(y|iness)|passed on retry|retrying|intermittent/i

export function classifyFailure(detail: string): { cause: FailureCause; weight: number } {
  const text = String(detail ?? "")
  let cause: FailureCause = "code"
  if (ENV_RE.test(text)) cause = "environment"
  else if (DRIFT_RE.test(text)) cause = "drift"
  else if (FLAKY_RE.test(text)) cause = "flaky"
  return { cause, weight: FAILURE_WEIGHTS[cause] }
}

// Собирает пары (id, detail) с капом; id/detail санитизируются здесь же,
// чтобы сырые байты секретов не уходили в стор.
function collectEntries(
  text: string,
  entryRe: RegExp,
  detailLines: (lines: string[], idx: number) => string,
): Array<{ id: string; detail: string }> {
  const out: Array<{ id: string; detail: string }> = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length && out.length < MAX_FAILURES; i++) {
    entryRe.lastIndex = 0 // /g-флаг stateful — сбрасываем до, не после
    const m = entryRe.exec(lines[i])
    if (!m) continue
    out.push({
      id: sanitizeOutput(m[1]).slice(0, MAX_FAILURE_ID),
      detail: sanitizeOutput(detailLines(lines, i)).slice(0, MAX_FAILURE_DETAIL),
    })
  }
  return out
}

// Следующие up-to-N строк с отступом (деталь падения), стоп на пустой/маркерной.
function indentedDetail(maxLines: number, stopRe?: RegExp): (lines: string[], idx: number) => string {
  return (lines, idx) => {
    const acc: string[] = []
    for (let j = idx + 1; j < lines.length && acc.length < maxLines; j++) {
      const line = lines[j]
      if (line.trim() === "") break
      if (stopRe && stopRe.test(line)) break
      if (!/^\s/.test(line) && acc.length > 0) break
      acc.push(line.trim())
    }
    return acc.join("\n")
  }
}

export function parseFailures(tool: EvidenceTool, text: string): TestFailure[] {
  try {
    const src = String(text ?? "")
    let entries: Array<{ id: string; detail: string }> = []
    if (tool === "pytest") {
      // detail опционален: короткие строки бывают без " - reason".
      // Классифицируем по id+"\n"+detail — parametrize-id часто несёт
      // саму причину (test_connect_timeout, [...-ConnectionError]).
      const re = /^FAILED\s+(\S+?)(?:\s+-\s*(.*))?$/gm
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null && entries.length < MAX_FAILURES) {
        entries.push({ id: sanitizeOutput(m[1]).slice(0, MAX_FAILURE_ID), detail: sanitizeOutput(m[2] ?? "").slice(0, MAX_FAILURE_DETAIL) })
      }
      const reErr = /^ERROR\s+(\S+)\s+-\s*(.*)$/gm
      while ((m = reErr.exec(src)) !== null && entries.length < MAX_FAILURES) {
        entries.push({ id: sanitizeOutput(m[1]).slice(0, MAX_FAILURE_ID), detail: sanitizeOutput(m[2]).slice(0, MAX_FAILURE_DETAIL) })
      }
    } else if (tool === "cargo-test") {
      const names = new Set<string>()
      const listRe = /^failures:\n((?:    \S+[^\n]*\n)+)/m.exec(src)
      if (listRe) {
        for (const line of listRe[1].split("\n")) {
          const n = line.trim().split(/\s+/)[0]
          if (n) names.add(n)
        }
      }
      const blocks = new Map<string, string>()
      const blockRe = /^---- (\S+) stdout ----\n([\s\S]*?)(?=^---- |\ntest result:|\s*$)/gm
      let b: RegExpExecArray | null
      while ((b = blockRe.exec(src)) !== null && blocks.size < MAX_FAILURES) {
        if (!blocks.has(b[1])) blocks.set(b[1], b[2])
      }
      for (const n of names) {
        if (entries.length >= MAX_FAILURES) break
        entries.push({ id: sanitizeOutput(n).slice(0, MAX_FAILURE_ID), detail: sanitizeOutput(blocks.get(n) ?? "").slice(0, MAX_FAILURE_DETAIL) })
      }
    } else if (tool === "jest") {
      const trimmed = src.trim()
      let parsed = false
      try {
        const obj: unknown = JSON.parse(trimmed)
        const results = (obj as Record<string, unknown>)["assertionResults"]
        if (Array.isArray(results)) {
          parsed = true
          for (const r of results) {
            if (entries.length >= MAX_FAILURES) break
            const item = r as Record<string, unknown>
            if (item["status"] !== "failed") continue
            const title = [item["ancestorTitle"], item["title"]].filter((x) => typeof x === "string").join(" › ")
            const msgs = Array.isArray(item["failureMessages"]) ? (item["failureMessages"] as unknown[]).join("\n") : ""
            entries.push({ id: sanitizeOutput(title || "unknown").slice(0, MAX_FAILURE_ID), detail: sanitizeOutput(msgs).slice(0, MAX_FAILURE_DETAIL) })
          }
        }
      } catch { /* не JSON — текстовый формат ниже */ }
      if (!parsed) {
        entries = collectEntries(src, /^●\s+(.+)$/gm, indentedDetail(8, /^●\s+/))
      }
    } else if (tool === "playwright") {
      entries = collectEntries(src, /^\s*\d+\)\s*(.+)$/gm, indentedDetail(8, /^\s*\d+\)\s*/))
    } else if (tool === "node-test") {
      entries = collectEntries(src, /^not ok \d+ - (.*)$/gm, indentedDetail(8, /^(ok|not ok|\.\.\.|\s*\.\.\.)/))
    } else if (tool === "go-test") {
      entries = collectEntries(src, /^--- FAIL: (\S+)/gm, indentedDetail(8))
    } else if (tool === "phpunit") {
      if (/FAILURES!|Errors:|Failures:/.test(src)) {
        entries = collectEntries(src, /^\d+\)\s+(.+)$/gm, (lines, idx) => {
          const acc: string[] = []
          for (let j = idx + 1; j < lines.length && acc.length < 3; j++) {
            if (/^\d+\)\s+/.test(lines[j])) break
            if (lines[j].trim() !== "") acc.push(lines[j].trim())
          }
          return acc.join("\n")
        })
      }
    }
    // Пустой/мусорный detail ("...") неинформативен — классифицируем по id:
    // parametrize-id часто несёт саму причину (test_connect_timeout, -ConnectionError).
    return entries.slice(0, MAX_FAILURES).map((e) => {
      const sig = e.detail.trim() === "" || /^\.{3}$/.test(e.detail.trim()) ? e.id : e.detail
      return { ...e, ...classifyFailure(sig) }
    })
  } catch {
    return []
  }
}

function counts(passed?: number, failed?: number): TestCounts | undefined {
  const p = typeof passed === "number" && Number.isFinite(passed) && passed >= 0 ? Math.floor(passed) : undefined
  const f = typeof failed === "number" && Number.isFinite(failed) && failed >= 0 ? Math.floor(failed) : undefined
  if (p === undefined && f === undefined) return undefined
  return { passed: p ?? 0, failed: f ?? 0 }
}

function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined
  const n = parseInt(s, 10)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function parsePytest(text: string): TestCounts | undefined {
  if (/no tests ran/i.test(text)) return { passed: 0, failed: 0 }
  let m = /(\d+)\s+failed\s*,\s*(\d+)\s+passed/i.exec(text)
  if (m) return counts(num(m[2]), num(m[1]))
  m = /(\d+)\s+passed(?:\s*,\s*(\d+)\s+failed)?/i.exec(text)
  if (m) return counts(num(m[1]), num(m[2]))
  return undefined
}

function parseCargo(text: string): TestCounts | undefined {
  // Один summary на test-бинарь в workspace — суммируем все.
  const re = /test result:\s*(?:ok|FAILED)\.\s*(\d+)\s*passed(?:;\s*(\d+)\s*failed)?/gi
  let passed = 0
  let failed = 0
  let found = false
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    found = true
    passed += num(m[1]) ?? 0
    failed += num(m[2]) ?? 0
  }
  return found ? { passed, failed } : undefined
}

function parseJest(text: string): TestCounts | undefined {
  const trimmed = text.trim()
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(s)
      return v && typeof v === "object" ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  let obj = tryParse(trimmed)
  if (!obj) {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start >= 0 && end > start) obj = tryParse(trimmed.slice(start, end + 1))
  }
  if (obj) {
    const p = obj["numPassedTests"]
    const f = obj["numFailedTests"]
    if (typeof p === "number" || typeof f === "number") {
      return counts(
        typeof p === "number" ? p : undefined,
        typeof f === "number" ? f : undefined,
      )
    }
    return undefined
  }
  const m = /Tests:\s*(?:(\d+)\s*failed,\s*)?(?:(\d+)\s*passed,\s*)?(\d+)\s*total/.exec(text)
  if (!m) return undefined
  if (m[1] === undefined && m[2] === undefined) return undefined
  return counts(num(m[2]), num(m[1]))
}

function parsePlaywright(text: string): TestCounts | undefined {
  const p = /(\d+)\s+passed\b/.exec(text)
  const f = /(\d+)\s+failed\b/.exec(text)
  if (!p && !f) return undefined
  return counts(p ? num(p[1]) : undefined, f ? num(f[1]) : undefined)
}

function parseNodeTap(text: string): TestCounts | undefined {
  // Два формата node --test: TAP ("# pass N") и spec-репортер ("ℹ pass N",
  // включается tsx и новыми версиями по умолчанию).
  const tapP = /#\s*pass\s+(\d+)/.exec(text)
  const tapF = /#\s*fail\s+(\d+)/.exec(text)
  const specP = /ℹ\s*pass\s+(\d+)/.exec(text)
  const specF = /ℹ\s*fail\s+(\d+)/.exec(text)
  const p = tapP ?? specP
  const f = tapF ?? specF
  if (!p && !f) return undefined
  return counts(p ? num(p[1]) : undefined, f ? num(f[1]) : undefined)
}

function parsePhpunit(text: string): TestCounts | undefined {
  let m = /^OK \((\d+) tests?, (\d+) assertions?\)/m.exec(text)
  if (m) return counts(num(m[1]), 0)
  m = /^Tests:\s*(\d+),\s*Assertions:\s*\d+(?:,\s*Failures:\s*(\d+))?(?:,\s*Errors:\s*(\d+))?(?:,\s*Skipped:\s*(\d+))?/m.exec(text)
  if (!m) return undefined
  const total = num(m[1]) ?? 0
  const bad = (num(m[2]) ?? 0) + (num(m[3]) ?? 0)
  const skipped = num(m[4]) ?? 0
  // Failures+Errors — красное; skipped из прошедших вычитаем.
  return { passed: Math.max(0, total - bad - skipped), failed: bad }
}

function parseGo(_text: string): TestCounts | undefined {
  // Без -v totals нет (`ok pkg` без цифр): counts не выдумываем — undefined.
  // Падения видны через parseFailures (`--- FAIL:`), скоринг падает в binary 0.
  void _text
  return undefined
}

function parseCoverage(text: string): number | undefined {
  const xml = /<coverage[^>]*line-rate="([\d.]+)"/.exec(text)
  if (xml) {
    const v = Math.round(parseFloat(xml[1]) * 100)
    if (Number.isFinite(v) && v >= 0 && v <= 100) return v
  }
  const total = /^TOTAL\s+\d+\s+\d+\s+(\d+)%/m.exec(text)
  if (total) {
    const v = parseInt(total[1], 10)
    if (Number.isFinite(v) && v >= 0 && v <= 100) return v
  }
  return undefined
}

export interface ParsedTestOutput {
  tool: EvidenceTool
  tests?: TestCounts
  coverage?: number
  failures?: TestFailure[]
}

// Сниффинг формата, когда команда не опознана (custom): только ярко выраженные
// маркеры, иначе — честный unparsed. Порядок: phpunit → go → TAP → jest-text.
function sniffTool(text: string): EvidenceTool | null {
  if (/^OK \(\d+ tests?,|^FAILURES!|^Tests: \d+, Assertions:/m.test(text)) return "phpunit"
  if (/^--- FAIL: \S+/m.test(text)) return "go-test"
  if (/^#\s*(tests|pass|fail)\s+\d+/m.test(text)) return "node-test"
  if (/^ℹ\s*(tests|pass|fail)\s+\d+/m.test(text)) return "node-test"
  if (/^Tests: \d+ (passed|failed)/m.test(text)) return "jest"
  // pytest под обёртками (make/tox): "5 failed, 614 passed in 75s".
  // Охрана от cargo-формы ("test result: ... finished in ...") — у неё свой парсер.
  if (!/test result:\s*(ok|FAILED)/.test(text) &&
    /\b\d+\s+passed\b[^\n]*\bin\s+[\d.]+s|\b\d+\s+failed,\s*\d+\s+passed\b/m.test(text)) return "pytest"
  return null
}

export function parseTestOutput(
  command: string,
  stdout?: string,
  stderr?: string,
  toolOverride?: string,
): ParsedTestOutput {
  try {
    let tool: EvidenceTool = isEvidenceTool(toolOverride) ? toolOverride : detectEvidenceTool(command)
    const text = `${stdout ?? ""}\n${stderr ?? ""}`
    if (tool === "custom") {
      const sniffed = sniffTool(text)
      if (sniffed) tool = sniffed
    }
    let tests: TestCounts | undefined
    if (tool === "pytest") tests = parsePytest(text)
    else if (tool === "cargo-test") tests = parseCargo(text)
    else if (tool === "jest") tests = parseJest(text)
    else if (tool === "playwright") tests = parsePlaywright(text)
    else if (tool === "node-test") tests = parseNodeTap(text)
    else if (tool === "go-test") tests = parseGo(text)
    else if (tool === "phpunit") tests = parsePhpunit(text)
    const failures = parseFailures(tool, text)
    const coverage = parseCoverage(text)
    const out: ParsedTestOutput = { tool }
    if (tests) out.tests = tests
    if (failures.length > 0) out.failures = failures
    if (coverage !== undefined) out.coverage = coverage
    return out
  } catch {
    return { tool: "custom" }
  }
}

// Человеческая строка для сообщений и отчётов: "pytest · 12/15 passed · coverage 78%".
// null, когда данных нет (голый tool без counts — шум, не строка).
export function summarizeEvidence(e: {
  tool?: string
  tests?: { passed: number; failed: number }
  coverage?: number
}): string | null {
  const t = e.tests
  const passed = t && Number.isFinite(t.passed) && t.passed >= 0 ? Math.floor(t.passed) : undefined
  const failed = t && Number.isFinite(t.failed) && t.failed >= 0 ? Math.floor(t.failed) : undefined
  const cov = typeof e.coverage === "number" && Number.isFinite(e.coverage) ? e.coverage : undefined
  if (passed === undefined || failed === undefined) {
    if (cov === undefined) return null
  }
  const parts: string[] = []
  if (typeof e.tool === "string" && e.tool !== "custom") parts.push(e.tool)
  if (passed !== undefined && failed !== undefined) {
    parts.push(`${passed}/${passed + failed} passed${failed > 0 ? `, ${failed} failed` : ""}`)
  }
  if (cov !== undefined) parts.push(`coverage ${cov}%`)
  return parts.length > 0 ? parts.join(" · ") : null
}

// UC-030 — applyEvidence больше не доверяет агенту. Шаг закрывается только через
// transitionStep, только из начатого состояния и только по команде, совпадающей
// с plan.acceptance.command. Статус руками не пишется.
export function applyEvidence(plan: Plan, stepId: string, evidence: Evidence): void {
  const step = plan.steps.find((x) => x.id === stepId)
  if (!step) throw new Error(`unknown step: ${stepId}`)
  if (!stepNeedsEvidence(plan, stepId)) {
    throw new Error(
      `evidence rejected for ${stepId}: step is ${step.status}, start it first (plan_step -> in_progress)`,
    )
  }
  // Per-step check has priority over plan-wide acceptance (PLAN-01)
  const acc = (step.check?.trim() || plan.acceptance?.command?.trim())
  const cmd = evidence.command.trim()
  if (acc && cmd && cmd !== acc && !acc.startsWith(cmd)) {
    throw new Error(`evidence rejected for ${stepId}: command does not match acceptance: ${acc}`)
  }
  step.evidence ??= []
  // Штампуем текущую попытку: старые успехи не закрывают новые попытки.
  step.evidence.push({ ...evidence, attempt: step.attempts ?? 0 })
  if (step.status === "in_progress") transitionStep(plan, stepId, "verify_required")
  if (evidence.exitCode === 0) {
    transitionStep(plan, stepId, "done")
    return
  }
  transitionStep(plan, stepId, "failed")
  step.attempts = (step.attempts ?? 0) + 1
}

// Принимает ли шаг evidence: только начатый агентом (UC-030).
export function stepNeedsEvidence(plan: Plan, stepId: string): boolean {
  const step = plan.steps.find((x) => x.id === stepId)
  if (!step) throw new Error(`unknown step: ${stepId}`)
  return step.status === "in_progress" || step.status === "verify_required"
}
