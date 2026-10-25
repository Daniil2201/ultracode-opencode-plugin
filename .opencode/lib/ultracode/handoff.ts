// Handoff сброса контекста: писатель/читатель. Запись — через updateStoreFile
// (lockfile, без потерянных update); git-коммит — колбэком из плагина, чтобы
// lib остался без spawnSync. Читатель — из in-memory стора при старте.
// Ponytail: stdlib + store.ts, ничего больше.
import { updateStoreFile } from "./store.ts"
import type { ContextStore, Handoff, HandoffReason } from "./schema.ts"

export type { Handoff, HandoffReason }

export function buildHandoff(
  sessionId: string,
  reason: HandoffReason,
  usagePct: number,
  summary: string,
): Handoff {
  return {
    ts: new Date().toISOString(),
    sessionId,
    reason,
    usagePct,
    summary: summary.slice(0, 2000),
  }
}

// Пишет запись + коммит `[ultracode] handoff <sid8> <pct>% <reason>`.
// usagePct NaN сериализуется в null — явный маркер «сжало без нашего ведома».
export function writeHandoff(
  file: string,
  h: Handoff,
  commit: (msg: string) => void,
): void {
  updateStoreFile(file, (s) => {
    s.handoff = h
  })
  // Commit is best-effort: if it fails, the handoff is still persisted in the store.
  // The caller (plugin) is responsible for retrying on error.
  try {
    commit(`[ultracode] handoff ${h.sessionId.slice(0, 8)} ${String(h.usagePct)}% ${h.reason}`)
  } catch (e) {
    // Re-throw so caller can handle retry
    throw e
  }
}

export function readHandoff(store: ContextStore): Handoff | null {
  const h = store.handoff
  if (!h || typeof h !== "object") return null
  if (typeof h.sessionId !== "string" || typeof h.summary !== "string") return null
  return h
}
