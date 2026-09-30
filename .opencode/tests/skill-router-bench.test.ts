// UC-035 — регресс качества skill-router на реальных user-запросах.
// Фиксирует текущий уровень: любая правка скоринга обязана его не ухудшить.
// Источник данных — .opencode/tests/fixtures/skill-router-queries.json
// (345 реальных запросов из БД opencode, 45 с независимыми метками).
// Актуальные цифры и методология: spec/skill-router-bench.md
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { collectSkills, scoreSkills } from "../lib/ultracode/skill-router.ts"

const REPO = path.resolve(import.meta.dirname, "..", "..")

interface Row {
  query: string
  project: string
  expected_skill: string | null
  marker: string | null
}

const rows: Row[] = JSON.parse(
  fs.readFileSync(path.join(REPO, ".opencode", "tests", "fixtures", "skill-router-queries.json"), "utf8"),
)

const skills = collectSkills(REPO, true)
const labeled = rows.filter((r) => r.expected_skill)

function rates() {
  let top1 = 0
  let top3 = 0
  let empty = 0
  for (const r of rows) {
    const names = scoreSkills(r.query, skills, 3).map((t) => t.name)
    if (names.length === 0) empty += 1
    if (!r.expected_skill) continue
    if (names[0] === r.expected_skill) top1 += 1
    if (names.includes(r.expected_skill)) top3 += 1
  }
  return {
    top1: top1 / labeled.length,
    top3: top3 / labeled.length,
    empty: empty / rows.length,
    n: labeled.length,
    total: rows.length,
  }
}

test("фикстура benched-запросов на месте и непустая", () => {
  assert.ok(rows.length >= 200, `в фикстуре ${rows.length} запросов, ожидалось ≥200`)
  assert.ok(labeled.length >= 20, `меток ${labeled.length}, ожидалось ≥20`)
  assert.ok(skills.length >= 100, `роустер ${skills.length} скиллов`)
})

// Пороги = измеренные минус запас. При ALIAS_BOOST=2 (по спецификации) реально
// выходит 26.7% / 35.6% / 27.5% — целевые 30% / 45% при +2 недостижимы:
// sweep показал, что 30/45 требуют буста 5 (44.4/53.3), а это подгонка под 45
// размеченных примеров. Решение по бусту — открытый вопрос, не тихая правка.
test("качество скоринга не хуже измеренного (UC-035)", () => {
  const r = rates()
  assert.ok(r.top1 >= 0.25, `top-1 ${(r.top1 * 100).toFixed(1)}% < 25%`)
  assert.ok(r.top3 >= 0.35, `top-3 ${(r.top3 * 100).toFixed(1)}% < 35%`)
  assert.ok(r.empty <= 0.32, `empty ${(r.empty * 100).toFixed(1)}% > 32%`)
})

test("скоринг детерминирован на реальных данных", () => {
  const a = scoreSkills("почини cargo audit в проекте", skills, 3)
  const b = scoreSkills("почини cargo audit в проекте", skills, 3)
  assert.deepEqual(a, b)
})

// Настоящая боль корпуса: длинные вставки. Проверяем, что они не роняют рантайм
// и дают хоть какой-то результат, а не падают.
test("длинные вставки не ломают скоринг", () => {
  const paste = "err\n".repeat(4000) + " поправь phpunit в composer.json"
  const out = scoreSkills(paste, skills, 3)
  assert.ok(Array.isArray(out))
  for (const t of out) assert.ok(t.score > 0 && typeof t.name === "string")
})
