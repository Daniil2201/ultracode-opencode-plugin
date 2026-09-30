// Стор оригиналов context-pruner. Отдельный append-only jsonl рядом со стором
// v3: <storeRoot>/projects/<slug>/pruned/<sessionID>.jsonl. Схема context.json
// не трогается (миграция не нужна), транскрипт opencode на диске не трогаем.
//
// Ponytail: только node:fs/path + два хелпера из store.ts/confidential.ts.
// I/O best-effort: ошибка записи не должна валить хук — потерянный оригинал
// означает, что recall_pruned ничего не вернёт, но не падение сессии (хук сам
// на "failed" prune не применяет, так что контекст и не теряется).
// ponytail: файл растёт без капа (в оригинале — сырой вывод тула). Кап сломал бы
// acceptance 11 «символ в символ»; файлы живут вместе с сессией. Ротация — если
// один sid начнёт жечь диск.
import * as fs from "node:fs"
import * as path from "node:path"
import { storeRoot, projectSlug } from "./store.ts"
import { redactConfidential } from "./confidential.ts"

export interface PruneOriginal {
  kind: "original"
  messageID: string
  partID: string
  tool: string
  content: string
  ts: string
}

export interface PrunePin {
  kind: "pin"
  messageID: string
  ts: string
}

export type PruneRecord = PruneOriginal | PrunePin

export function prunedDirFor(projectRoot: string, root?: string): string {
  return path.join(root ?? storeRoot(), "projects", projectSlug(projectRoot), "pruned")
}

export function prunedFileFor(projectRoot: string, sessionID: string, root?: string): string {
  // sessionID — TID opencode ([A-Za-z0-9_-]), поэтому фильтр ничего не теряет;
  // кап спасает от ENAMETOOLONG на длинном/мусорном sid.
  const sid = String(sessionID || "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "default"
  return path.join(prunedDirFor(projectRoot, root), `${sid}.jsonl`)
}

// Ключи уже записанных (messageID, partID) и пины живут в памяти процесса:
// файл на сессию не перечитывается на каждом ходу. Источник истины — сам jsonl
// (после рестарта процесса кэш пуст и читается заново).
// ponytail: после рестарта дедуп-ключи теряются, и тот же оригинал может
// дописаться второй раз (лишняя строка в jsonl, не поломка). Гидратация ключей
// из файла при первом обращении — если повторов станет много.
const writtenKeys = new Map<string, Set<string>>()
const pinCache = new Map<string, Set<string>>()

// Тесты: сброс памяти = рестарт процесса.
export function forgetPruneCache(file?: string): void {
  if (file === undefined) {
    writtenKeys.clear()
    pinCache.clear()
    return
  }
  writtenKeys.delete(file)
  pinCache.delete(file)
}

function keysFor(file: string): Set<string> {
  let set = writtenKeys.get(file)
  if (!set) {
    set = new Set<string>()
    writtenKeys.set(file, set)
  }
  return set
}

// Чтение jsonl: битая/оборванная строка и запись незнакомой формы
// пропускаются (append-only, хвост мог остаться без перевода строки) — файл не
// должен становиться нечитаемым, а потребитель не должен получать запись без
// content (иначе .length по undefined уронит тул).
export function readPruned(file: string): PruneRecord[] {
  let raw = ""
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return []
  }
  const out: PruneRecord[] = []
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      const r = JSON.parse(t) as Record<string, unknown>
      if (r && r["kind"] === "pin" && typeof r["messageID"] === "string") {
        out.push({ kind: "pin", messageID: r["messageID"], ts: typeof r["ts"] === "string" ? r["ts"] : "" })
      } else if (
        r && r["kind"] === "original" && typeof r["messageID"] === "string" &&
        typeof r["partID"] === "string" && typeof r["content"] === "string"
      ) {
        out.push({
          kind: "original",
          messageID: r["messageID"],
          partID: r["partID"],
          tool: typeof r["tool"] === "string" ? r["tool"] : "",
          content: r["content"],
          ts: typeof r["ts"] === "string" ? r["ts"] : "",
        })
      }
    } catch { /* битая строка — пропускаем */ }
  }
  return out
}

function appendLine(file: string, row: PruneRecord): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8")
    return true
  } catch {
    return false
  }
}

// "stored" — оригинал записан, "duplicate" — уже был, "failed" — запись не
// удалась. Различать важно: хук по "failed" не применяет prune (иначе плейсхолдер
// обещал бы recall, который ничего не вернёт).
export type AppendResult = "stored" | "duplicate" | "failed"

// Оригинал пишется один раз на пару (messageID, partID): без дедупа один и тот
// же оригинал дописывался бы каждый ход. Секреты — через redactConfidential.
export function appendOriginal(
  file: string,
  rec: { messageID: string; partID: string; tool: string; content: string },
): AppendResult {
  const key = `${rec.messageID} ${rec.partID}`
  const seen = keysFor(file)
  if (seen.has(key)) return "duplicate"
  const row: PruneOriginal = {
    kind: "original",
    messageID: rec.messageID,
    partID: rec.partID,
    tool: rec.tool,
    content: redactConfidential(rec.content ?? ""),
    ts: new Date().toISOString(),
  }
  // Ключ помечается только после успешной записи: отказ = не записали = ключа нет.
  if (!appendLine(file, row)) return "failed"
  seen.add(key)
  return "stored"
}

// Сообщение закреплено: pruner больше его не жмёт (recall_pruned).
export function appendPin(file: string, messageID: string): boolean {
  const pins = loadPins(file) as Set<string>
  if (pins.has(messageID)) return false
  const row: PrunePin = { kind: "pin", messageID, ts: new Date().toISOString() }
  if (!appendLine(file, row)) return false
  pins.add(messageID)
  return true
}

export function loadPins(file: string): ReadonlySet<string> {
  const cached = pinCache.get(file)
  if (cached) return cached
  const set = new Set<string>()
  for (const r of readPruned(file)) {
    if (r.kind === "pin") set.add(r.messageID)
  }
  pinCache.set(file, set)
  return set
}

// Оригиналы для recall_pruned: по messageID, при partID — точное совпадение.
// Дубли по partID схлопываются (после рестарта процесса запись могла
// повториться) — иначе recall вернул бы N копий одного и того же.
export function findOriginals(file: string, messageID: string, partID?: string): PruneOriginal[] {
  const byPart = new Map<string, PruneOriginal>()
  for (const r of readPruned(file)) {
    if (r.kind !== "original" || r.messageID !== messageID) continue
    if (partID !== undefined && r.partID !== partID) continue
    byPart.set(r.partID, r)
  }
  return [...byPart.values()]
}
