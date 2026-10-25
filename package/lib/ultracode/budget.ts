// Budget Manager: снимок usage на сессию + пороги. Чистые функции,
// in-memory состояние держит плагин (сессия короткая — не персистим).
// Фаза 4.5: реальный total от платформы (info.tokens.total — снимок всего
// диалога: input+output+reasoning+cache.read; проверено: сумма сходится с total
// во всех сообщениях). Свои оценки больше не копим — они дублировали total.
export interface Usage {
  total: number // последний info.tokens.total; 0 = ответа ассистента ещё не было
  estimated: boolean // true, пока total не приходил ни разу
}

export function newUsage(): Usage {
  return { total: 0, estimated: true }
}

export function usageFor(map: Map<string, Usage>, sessionId: string): Usage {
  let u = map.get(sessionId)
  if (!u) {
    u = newUsage()
    map.set(sessionId, u)
  }
  return u
}

// total ПЕРЕЗАПИСЫВАЕТ, а не прибавляет: каждое message.updated — снимок всего
// диалога, не дельта (иначе удвоение на каждом шаге). Нулевой/отсутствующий
// total игнорируется — не портит предыдущий (некоторые модели не отдают).
export function addModelUsage(
  map: Map<string, Usage>,
  sessionId: string,
  info: { tokens?: { total?: unknown } },
): void {
  const t = Number(info?.tokens?.total ?? 0)
  if (!(t > 0)) return
  map.set(sessionId, { total: t, estimated: false })
}

export type BudgetLevel = "ok" | "soft" | "hard" | "emergency"

export interface BudgetThresholds {
  soft: number
  hard: number
  emergency: number
}

export interface BudgetVerdict {
  pct: number // 0..100, NaN при неизвестном лимите
  level: BudgetLevel
  estimated: boolean
}

// Профили порогов (для справки; привязка к командам — Фаза 5).
export const THRESHOLD_PROFILES: Record<"aggressive" | "balanced" | "conservative", BudgetThresholds> = {
  aggressive: { soft: 30, hard: 45, emergency: 60 },
  balanced: { soft: 40, hard: 60, emergency: 75 },
  conservative: { soft: 50, hard: 70, emergency: 85 },
}

export const DEFAULT_THRESHOLDS: BudgetThresholds = THRESHOLD_PROFILES.balanced

// Пороги из store.config с дефолтами balanced (частичный override ок).
export function thresholdsFrom(config: {
  thresholdSoft?: number
  thresholdHard?: number
  thresholdEmergency?: number
}): BudgetThresholds {
  return {
    soft: config.thresholdSoft ?? DEFAULT_THRESHOLDS.soft,
    hard: config.thresholdHard ?? DEFAULT_THRESHOLDS.hard,
    emergency: config.thresholdEmergency ?? DEFAULT_THRESHOLDS.emergency,
  }
}

// pct = total / limit.context * 100. Пороги/профили/estimated-режим — без изменений.
// limit <= 0 (неизвестен) → пороги спят: {pct: NaN, level: "ok", estimated: true}.
// Без третьего аргумента — balanced (все существующие вызовы работают как раньше).
export function evaluate(u: Usage, limit: number, thresholds: BudgetThresholds = DEFAULT_THRESHOLDS): BudgetVerdict {
  if (!(limit > 0)) return { pct: NaN, level: "ok", estimated: true }
  const pct = (u.total / limit) * 100
  if (pct >= thresholds.emergency) return { pct, level: "emergency", estimated: u.estimated }
  if (pct >= thresholds.hard) return { pct, level: "hard", estimated: u.estimated }
  if (pct >= thresholds.soft) return { pct, level: "soft", estimated: u.estimated }
  return { pct, level: "ok", estimated: u.estimated }
}

// Знаменатель: 1) store.config.modelLimit, 2) карта providerID/modelID →
// limit.context из ctx.client.config.providers(), 3) 0 = неизвестен.
export function resolveLimit(
  storeLimit: number | undefined,
  cache: Map<string, number> | null,
  providerID?: string,
  modelID?: string,
): number {
  if (typeof storeLimit === "number" && storeLimit > 0) return Math.round(storeLimit)
  if (cache && providerID && modelID) {
    const v = cache.get(`${providerID}/${modelID}`)
    if (typeof v === "number" && v > 0) return v
  }
  return 0
}
