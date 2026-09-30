// UC-013 / UC-031 — policy автономности: единственный источник текста, который реально
// инжектится в system prompt. Предикаты удалены (0 production-вызовов, хука permission.ask
// в плагине нет) — правило работает текстом.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { AUTONOMY_TAG } from "../lib/ultracode/autonomy.ts"

test("policy block is injected-ready", () => {
  assert.ok(AUTONOMY_TAG.startsWith("<ultracode-autonomy>"))
  assert.ok(AUTONOMY_TAG.trimEnd().endsWith("</ultracode-autonomy>"))
})

test("живой текст сохраняет все 8 границ автономии", () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    assert.ok(new RegExp(`^${n}\\.`, "m").test(AUTONOMY_TAG), `пункт ${n} потерян`)
  }
  assert.ok(AUTONOMY_TAG.includes("внутри цели пользователя"), "нет правила scope")
  assert.ok(AUTONOMY_TAG.includes("максимум 3"), "нет лимита на вопросы")
  assert.ok(AUTONOMY_TAG.includes("Подтверждение нужно только"), "нет правила подтверждения")
  assert.ok(AUTONOMY_TAG.includes("остановись"), "нет stop-правила")
  assert.ok(AUTONOMY_TAG.includes("scope"), "нет упоминания scope")
})

// Регресс-тест на расхождение копий: именно из-за него модуль выглядел мёртвым,
// а тесты были зелёными — они проверяли stub, который не инжектился.
test("плагин импортирует AUTONOMY_TAG, а не дублирует его телом", () => {
  const src = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "plugin", "ultracode.ts"),
    "utf8",
  )
  assert.ok(
    /import \{ AUTONOMY_TAG as AUTONOMY_TAG_V3 \} from "..\/lib\/ultracode\/autonomy\.ts"/.test(src),
    "плагин не импортирует AUTONOMY_TAG из модуля",
  )
  assert.equal(
    /const AUTONOMY_TAG = `/.test(src),
    false,
    "в теле плагина снова появилась локальная копия AUTONOMY_TAG",
  )
  assert.ok(src.includes('pushSystemOnce(system, sid, "autonomy", AUTONOMY_TAG_V3)'), "инъекция не использует импорт")
})
