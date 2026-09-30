// UC-032 — skill-router на настоящем tool path: system.transform срезает <available_skills>
// и инжектит <skill_hint>. Нативный skill при этом не блокируется.
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { makeRuntime } from "./fixtures.ts"

const PLUGIN = path.resolve(import.meta.dirname, "..", "..", "plugin", "ultracode.ts")

test("UC-032: system.transform срезает <available_skills> и добавляет <skill_hint>", async () => {
  const rt = await makeRuntime()
  try {
    // Прогоняем через настоящий хук: сначала сообщение пользователя (даёт query),
    // затем transform с фейковым system, где лежит полный список скиллов.
    await rt.callTool({ action: "plan_new", plan: "lab-sr", goal: "sr", steps: "one step" })
    await rt.chatMessage("Напиши PHP-функцию format_price с PHPUnit-тестом")
    const system: string[] = [
      "system head",
      "<available_skills>\n" + "  <skill>\n".repeat(40) + "  </skill>\n".repeat(40) + "</available_skills>",
      "system tail",
    ]
    await rt.systemTransform(system)
    const joined = system.join("\n")
    assert.ok(!joined.includes("<available_skills>"), "список скиллов остался в промпте")
    assert.ok(!joined.includes("<skill>"), "вложенные <skill> остались")
    assert.ok(joined.includes("system head") && joined.includes("system tail"), "соседние части потеряны")
    assert.ok(joined.includes("<skill_hint>"), "hint не инжектился")
    assert.match(joined, /php/i, "hint без php-скилла на PHP-запросе")
  } finally {
    rt.cleanup()
  }
})

test("UC-032: transform идемпотентен — повторный вызов не дублирует hint", async () => {
  const rt = await makeRuntime()
  try {
    await rt.chatMessage("отладка evidence-гейта")
    const system: string[] = ["<available_skills>x</available_skills>", "tail"]
    await rt.systemTransform(system)
    const first = system.filter((s) => s.includes("<skill_hint>")).length
    await rt.systemTransform(system)
    const second = system.filter((s) => s.includes("<skill_hint>")).length
    assert.equal(first, second, "hint задублировался")
    assert.ok(!system.join("\n").includes("<available_skills>"), "список скиллов вернулся")
  } finally {
    rt.cleanup()
  }
})

test("UC-032: tool triage доступен и отвечает по запросу", async () => {
  const rt = await makeRuntime()
  try {
    assert.ok(rt.tools().includes("triage"), "инструмент triage не зарегистрирован")
    const out = await rt.callToolNamed("triage", { query: "phpunit тест для функции" })
    assert.match(out, /\d+\tphp/)
    const miss = await rt.callToolNamed("triage", { query: "квантовая телепортация зубов" })
    assert.match(miss, /no skills matched/)
    const empty = await rt.callToolNamed("triage", { query: "" })
    assert.match(empty, /empty query/)
  } finally {
    rt.cleanup()
  }
})

// Регресс-инвариант: роутер не перехватывает нативный skill (в отличие от
// opencode-triage, который подменяет его аргументы на sentinel-имя).
test("UC-032: плагин не подменяет аргументы нативного skill", () => {
  const src = fs.readFileSync(PLUGIN, "utf8")
  assert.equal(src.includes("__TRIAGE_DISABLED__"), false, "роутер блокирует нативный skill")
  const before = src.indexOf('"tool.execute.before"')
  if (before !== -1) {
    const block = src.slice(before, before + 600)
    assert.equal(/input\.tool !== "skill"|input\.tool === "skill"/.test(block), false,
      "в tool.execute.before есть вмешательство в skill")
  }
})
