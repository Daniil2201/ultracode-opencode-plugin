// EV-003 — маппинг gates → weighted criteria.
//
// Рубрика (единственное место, где gate-результаты превращаются в баллы):
//   compile              → correctness (fail: 0 + hard compile)
//   unit                 → tests (fail: 5 + hard acceptance) + correctness −10
//   runtime              → runtime (fail: 0 + hard runtime_connected)
//   security             → security (secrets-red: 0 + hard secrets + critical
//                          blocker; autonomy-red: 5 + hard confirmation + major blocker)
//   concurrency          → reliability (fail: 0 + hard data_loss + critical blocker)
//   mcp-test             → correctness −10, runtime −5 + hard runtime_connected
//   mcp-release          → correctness −5 (без hard: debug-контракты первичны)
//   mcp-clippy / mcp-fmt → architecture −3 / −2 (floor 0)
//   durations + mcp caps → performance (p95 gate-latency против SLO:
//                          3 при p95 в норме, иначе потолок 2/3 с находкой).
//   install/docs         → documentation (в smoke гейтов нет: 1 + finding)
// Soft: smoke всегда repro_missing; all без зелёного repro — repro_missing;
// отсутствуют runtime/security/concurrency гейты — unit_only.
//
// Красный контрактный тест трактуется fail-closed: свойство не доказано —
// значит, не выполнено. Ключевые слова в выводе различают secrets-red от
// autonomy-red, но оба касаются hard-гейтов из ULTRACODE-EVALUATION.md.
import type { GateId, SoftGateId } from "./schema.ts"
import type { CriterionResult, Finding } from "./scoring.ts"
import { sanitizeOutput, parseTestOutput, summarizeEvidence } from "../verification.ts"

export interface GateResult {
  name: string
  command: string
  exitCode: number
  durationMs: number
  output: string
}

export interface CriteriaBuild {
  criteria: CriterionResult[]
  hardFailed: GateId[]
  softFailed: SoftGateId[]
  blockers: Finding[]
}

// p95 gate-latency: третий балл performance даётся измерением, а не авансом.
export const P95_SLO_MS = 120_000

export function p95(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((sorted.length * 95) / 100) - 1)]
}

const SECRET_HINT = /secrets\.test|secret|redact|leak|api_hash|api_id|password|passwd|bot[_-]?token/i

function ev(g: GateResult | undefined): string[] {
  if (!g) return ["gate absent"]
  const base = `gate ${g.name}: exit ${g.exitCode} in ${(g.durationMs / 1000).toFixed(1)}s :: ${sanitizeOutput(g.command).slice(0, 120)}`
  // UC-024: осмысленные counts вместо голого exit code (скоринг не меняется).
  const summary = summarizeEvidence(parseTestOutput(g.command, g.output))
  return summary ? [base, `  └ ${summary}`] : [base]
}

function head(g: GateResult | undefined, n = 300): string {
  if (!g) return ""
  return sanitizeOutput(g.output).slice(0, n)
}

function crit(id: string, max: number, score: number, evidence: string[], findings: string[]): CriterionResult {
  return { id, max, score: Math.max(0, Math.min(max, Math.round(score))), evidence, findings }
}

export function buildCriteria(gates: GateResult[], mode: "smoke" | "all"): CriteriaBuild {
  const byName = new Map(gates.map((g) => [g.name, g]))
  const get = (n: string): GateResult | undefined => byName.get(n)
  const pass = (n: string): boolean => get(n)?.exitCode === 0
  const present = (n: string): boolean => byName.has(n)

  const hardFailed: GateId[] = []
  const softFailed: SoftGateId[] = []
  const blockers: Finding[] = []
  const hard = (id: GateId): void => {
    if (!hardFailed.includes(id)) hardFailed.push(id)
  }

  // correctness (30)
  let correctness: CriterionResult
  if (!present("compile") || !pass("compile")) {
    hard("compile")
    correctness = crit("correctness", 30, 0, ev(get("compile")), ["BLOCKER: compile gate red — сборка/загрузка не доказана"])
  } else {
    let score = 30
    const findings: string[] = []
    if (present("unit") && !pass("unit")) {
      score -= 10
      findings.push("unit gate red: −10 к correctness")
    }
    if (present("mcp-test") && !pass("mcp-test")) {
      score -= 10
      findings.push("mcp-test gate red: −10 к correctness")
    }
    if (present("mcp-release") && !pass("mcp-release")) {
      score -= 5
      findings.push("mcp-release gate red: −5 к correctness (release-сборка не доказана)")
    }
    correctness = crit("correctness", 30, score, ev(get("compile")), findings)
  }

  // tests (20)
  let tests: CriterionResult
  if (!present("unit") || !pass("unit")) {
    hard("acceptance")
    tests = crit("tests", 20, present("unit") ? 5 : 0, ev(get("unit")), ["BLOCKER: unit acceptance red"])
  } else {
    tests = crit("tests", 20, 20, ev(get("unit")), [])
  }

  // runtime (15)
  let runtime: CriterionResult
  if (!present("runtime") || !pass("runtime")) {
    hard("runtime_connected")
    runtime = crit("runtime", 15, 0, ev(get("runtime")), ["BLOCKER: runtime contract red — helper-only, интеграции не доказаны"])
  } else {
    let score = 15
    const findings: string[] = []
    if (present("mcp-test") && !pass("mcp-test")) {
      score -= 5
      hard("runtime_connected")
      findings.push("BLOCKER: mcp binary contract red — runtime не подключён")
    }
    runtime = crit("runtime", 15, score, [...ev(get("runtime")), ...ev(get("mcp-test"))], findings)
  }

  // security (15): отсутствующий гейт — тоже недоказанность, но без ярлыка
  // утечки (её не было в выводе, потому что вывода не было).
  let security: CriterionResult
  if (!present("security")) {
    hard("confirmation")
    blockers.push({ id: "sec-absent", severity: "major", text: "security gate absent — границы не доказаны" })
    security = crit("security", 15, 0, ev(get("security")), ["security gate отсутствует"])
  } else if (!pass("security")) {
    const out = head(get("security"))
    if (SECRET_HINT.test(out)) {
      hard("secrets")
      blockers.push({ id: "sec-secrets", severity: "critical", text: `security red с признаками утечки: ${out.slice(0, 200)}` })
      security = crit("security", 15, 0, ev(get("security")), ["BLOCKER: возможная утечка секретов"])
    } else {
      hard("confirmation")
      blockers.push({ id: "sec-autonomy", severity: "major", text: `autonomy/policy red: ${out.slice(0, 200)}` })
      security = crit("security", 15, 5, ev(get("security")), ["autonomy red: граница подтверждений не доказана"])
    }
  } else {
    security = crit("security", 15, 15, ev(get("security")), [])
  }

  // reliability (10)
  let reliability: CriterionResult
  const relFindings: string[] = []
  if (mode === "smoke") {
    softFailed.push("repro_missing")
    relFindings.push("reproducibility доказывается только двойным прогоном в --all")
  } else if (!present("repro") || !pass("repro")) {
    if (!softFailed.includes("repro_missing")) softFailed.push("repro_missing")
    relFindings.push("повторный прогон не сошёлся или отсутствует")
  }
  if (!present("runtime") || !present("security") || !present("concurrency")) {
    if (!softFailed.includes("unit_only")) softFailed.push("unit_only")
    relFindings.push("runtime/security/concurrency гейты отсутствуют: зрелость не выше unit-only")
  }
  if (!present("concurrency")) {
    hard("data_loss")
    blockers.push({ id: "rel-absent", severity: "critical", text: "concurrency gate absent — потеря записей не исключена" })
    reliability = crit("reliability", 10, 0, ev(get("concurrency")), [...relFindings, "BLOCKER: конкурентная запись не доказана"])
  } else if (!pass("concurrency")) {
    hard("data_loss")
    blockers.push({ id: "rel-concurrency", severity: "critical", text: `concurrency red: возможна потеря plan/evidence: ${head(get("concurrency")).slice(0, 200)}` })
    reliability = crit("reliability", 10, 0, ev(get("concurrency")), [...relFindings, "BLOCKER: конкурентная запись не доказана"])
  } else {
    reliability = crit("reliability", 10, 10, [...ev(get("concurrency")), ...ev(get("repro"))], relFindings)
  }

  // architecture (5)
  let arch = 5
  const archFindings: string[] = []
  if (present("mcp-clippy") && !pass("mcp-clippy")) {
    arch -= 3
    archFindings.push("clippy red: −3")
  }
  if (present("mcp-fmt") && !pass("mcp-fmt")) {
    arch -= 2
    archFindings.push("cargo fmt red: −2")
  }
  if (!present("mcp-clippy") || !present("mcp-fmt")) archFindings.push("lint/format гейты отсутствуют")
  const architecture = crit("architecture", 5, arch, [...ev(get("mcp-clippy")), ...ev(get("mcp-fmt"))], archFindings)

  // performance (3): p95 всех gate-duration против SLO. Превышение —
  // потолок 2/3 с явной находкой, а не скрытой скидкой.
  let performance: CriterionResult
  if (present("mcp-test") && !pass("mcp-test")) {
    performance = crit("performance", 3, 0, ev(get("mcp-test")), ["контекстные капы MCP не доказаны"])
  } else {
    const lat = ["compile", "unit", "runtime", "security", "concurrency", "mcp-test", "mcp-release", "mcp-clippy", "mcp-fmt"]
      .map((n) => get(n)?.durationMs ?? 0)
    const p = p95(lat)
    const pev = [...ev(get("mcp-test")), `p95 gate latency ${p}ms (SLO ${P95_SLO_MS}ms)`]
    performance = p <= P95_SLO_MS
      ? crit("performance", 3, 3, pev, [])
      : crit("performance", 3, 2, pev, [`p95 ${p}ms выше SLO ${P95_SLO_MS}ms: потолок 2/3`])
  }

  // documentation (2)
  let documentation: CriterionResult
  const docGates = ["farm-health", "install-status", "install-smoke"]
  const docResults = docGates.map((n) => (present(n) ? pass(n) : null))
  if (docResults.every((v) => v === true)) {
    documentation = crit("docs", 2, 2, docGates.flatMap((n) => ev(get(n))), [])
  } else if (docResults.some((v) => v === false)) {
    documentation = crit("docs", 2, 0, docGates.flatMap((n) => ev(get(n))), ["docs/health/install gate red"])
  } else {
    documentation = crit("docs", 2, 1, ["docs gates only run in --all"], ["частичное покрытие документации в smoke"])
  }

  return {
    criteria: [correctness, tests, runtime, security, reliability, architecture, performance, documentation],
    hardFailed,
    softFailed,
    blockers,
  }
}
