// UC-009 — явный Open Design workflow. Никакого авто-запуска по слову «дизайн».
// Порядок: get_active_context -> collect_brief -> показать brief -> confirm_brief ->
// start_run -> polling get_run -> проверка manifest -> запись в план.
import * as path from "node:path"

export type DesignStage = "need_context" | "brief_draft" | "brief_confirm" | "running" | "done" | "cancelled" | "timeout" | "blocked"

export interface DesignBrief {
  goal: string
  confirmed: boolean
}

export interface ArtifactManifest {
  files: string[]
}

// Файлы строго внутри project root. Выброс — не тихий пропуск.
export function safeArtifactPath(root: string, file: string): string {
  const target = path.resolve(root, file)
  const base = path.resolve(root)
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("artifact escapes project root")
  }
  return target
}

export function validateManifest(root: string, manifest: ArtifactManifest): string[] {
  return manifest.files.map((f) => safeArtifactPath(root, f))
}

// start_run запрещён без подтверждённого brief.
export function canStartRun(brief: DesignBrief | null): boolean {
  return Boolean(brief?.confirmed && brief.goal.trim().length > 0)
}

export function nextStageAfterContext(hasContext: boolean): DesignStage {
  return hasContext ? "brief_draft" : "blocked"
}

export function blockerNoContext(): string {
  return "Нет active context Open Design: открой дизайн в Open Design и повтори /design. start_run не вызван."
}
