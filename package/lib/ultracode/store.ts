// UC-001 — надёжное хранилище v3: per-project файлы + atomic save + миграция.
// Ponytail: stdlib fs/path/os only, никаких зависимостей.
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { freshStore, migrateStore } from "./schema.ts"
import type { ContextStore } from "./schema.ts"

export type { ContextStore }

export function storeRoot(): string {
  const xdg = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.["XDG_DATA_HOME"]
  if (xdg) return path.join(xdg, "opencode", "ultracode")
  return path.join(os.homedir(), ".local", "share", "opencode", "ultracode")
}

// Детерминированный slug+hash от project root: два проекта не видят память друг друга.
export function projectSlug(projectRoot: string): string {
  const base = path.basename(path.resolve(projectRoot)) || "root"
  const slug = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "root"
  let h = 5381
  const s = path.resolve(projectRoot)
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return `${slug}-${h.toString(36)}`
}

export function storeFileFor(projectRoot: string, root?: string): string {
  return path.join(root ?? storeRoot(), "projects", projectSlug(projectRoot), "context.json")
}

// UC-0xx: run-сессии opencode отдают worktree="/": bare-корень как проект
// пропускаем, иначе все run-режимы пишут в один стор root-3t1w вместо cwd.
// Приоритет как был (worktree → directory → cwd) — меняется только пропуск
// "/" и пустых, существующее поведение TUI не затрагивается.
export function pickProjectDir(...cands: Array<string | undefined | null>): string {
  for (const c of cands) {
    if (typeof c === "string" && c !== "" && c !== "/" && fs.existsSync(c)) return c
  }
  return process.cwd()
}

export function legacyGlobalFile(root?: string): string {
  return path.join(root ?? storeRoot(), "context.json")
}

export function metricsFileFor(projectRoot: string, root?: string): string {
  return path.join(root ?? storeRoot(), "projects", projectSlug(projectRoot), "metrics.jsonl")
}

// Загрузка: повреждённый JSON не ломает запуск — возвращается пустой стор v3.
export function loadStore(file: string): ContextStore {
  try {
    if (!fs.existsSync(file)) return freshStore()
    const raw = fs.readFileSync(file, "utf8")
    if (!raw.trim()) return freshStore()
    return migrateStore(JSON.parse(raw))
  } catch {
    return freshStore()
  }
}

// Загрузка с fallback на legacy global (миграция v2 single-file -> per-project).
export function loadStoreFor(projectRoot: string, root?: string): ContextStore {
  const file = storeFileFor(projectRoot, root)
  if (fs.existsSync(file)) return loadStore(file)
  const legacy = legacyGlobalFile(root)
  if (fs.existsSync(legacy)) {
    const s = loadStore(legacy)
    // Легкая миграция v2 single-file -> per-project (UC-032): в свежий проект
    // копируются ТОЛЬКО глобальные записи (project "/" или пустой). Планы и
    // память чужих проектов не переносятся — иначе в сессию проливаются чужие
    // active-планы и записи других проектов.
    const g = freshStore()
    g.knowledge = s.knowledge.filter((k) => k.project === "/" || k.project === "")
    try {
      saveStore(file, g)
    } catch { /* best effort */ }
    return g
  }
  return freshStore()
}

// Атомарное сохранение: tmp + rename. Обрезанный context.json невозможен —
// читатели видят либо старый, либо новый файл целиком.
export function saveStore(file: string, store: ContextStore): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const pid = (globalThis as unknown as { process?: { pid?: number } }).process?.pid ?? 0
  const tmp = `${file}.${pid}.${Date.now().toString(36)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store) + "\n", "utf8")
  fs.renameSync(tmp, file)
}

export function saveStoreFor(projectRoot: string, store: ContextStore, root?: string): string {
  const file = storeFileFor(projectRoot, root)
  saveStore(file, store)
  return file
}

// UC-018 case 4: сериализация писателей через lockfile. Атомарный rename
// защищает от обрезанных файлов, но НЕ от lost update (два процесса читают
// одну версию, побеждает последний). Любые read-modify-write — только сюда.
export function withStoreLock<T>(file: string, fn: () => T, timeoutMs = 5000): T {
  const lock = `${file}.lock`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const deadline = Date.now() + timeoutMs
  const pid = (globalThis as unknown as { process?: { pid?: number } }).process?.pid ?? 0
  // Фаза 1 — только захват лока. Ошибки fn() сюда не попадают и не ретраятся.
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx", 0o644)
      try {
        fs.writeSync(fd, String(pid))
      } finally {
        fs.closeSync(fd)
      }
      break
    } catch {
      // Чужой лок: протухший (краш холдера) — сносим, иначе ждём.
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs
        if (age > timeoutMs) {
          try { fs.unlinkSync(lock) } catch { /* best effort */ }
          continue
        }
      } catch { /* лок исчез между проверками — пробуем снова */ }
      if (Date.now() > deadline) throw new Error(`store lock timeout: ${file}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.floor(Math.random() * 15))
    }
  }
  // Фаза 2 — выполнение под локом: ошибка fn пробрасывается как есть, лок снимается.
  try {
    return fn()
  } finally {
    try { fs.unlinkSync(lock) } catch { /* best effort */ }
  }
}

// Загрузить свежее под локом, применить fn, сохранить: потеря update невозможна.
export function updateStoreFile<T>(file: string, fn: (s: ContextStore) => T): T {
  return withStoreLock(file, () => {
    const s = loadStore(file)
    const out = fn(s)
    saveStore(file, s)
    return out
  })
}
