// UC-032 — skill-router: сбор скиллов, скоринг, hint, срез <available_skills>.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import {
  collectSkills,
  scoreSkills,
  renderSkillHint,
  skillTriage,
  stripAvailableSkills,
  tokenize,
  aliasBoosts,
  projectBoosts,
  MAX_HINT_QUERY,
} from "../lib/ultracode/skill-router.ts"

const REPO = path.resolve(import.meta.dirname, "..", "..")
const skills = collectSkills(REPO, true)

test("collectSkills находит встроенный роустер без зависимости от глобальных skills", () => {
  assert.ok(skills.length >= 50, `найдено ${skills.length}`)
  assert.ok(skills.some((s) => s.source === "local"), "нет локальных скиллов")
  const names = new Set(skills.map((s) => s.name))
  assert.equal(names.size, skills.length, "дубликаты имён не схлопнуты")
})

test("скиллы без name: во фронтматтере берут имя каталога", () => {
  const byName = new Map(skills.map((s) => [s.name, s]))
  // spec-first и browser-autopilot в этом репо без name:
  for (const n of ["spec-first", "browser-autopilot"]) {
    assert.ok(byName.has(n), `${n} не найден`)
  }
})

test("collectSkills кэшируется на процесс", () => {
  const first = collectSkills()
  const second = collectSkills()
  assert.equal(first, second, "кэш не вернул тот же массив")
  assert.notEqual(collectSkills(REPO, true), first, "refresh обязан перечитать диск")
})

test("collectSkills не создаёт и не меняет файлы", () => {
  const dir = path.join(REPO, ".opencode", "skills")
  const snap = () => spawnSync("find", [dir, "-name", "SKILL.md"], { encoding: "utf8", shell: false }).stdout
  const before = snap()
  collectSkills(REPO, true)
  assert.equal(snap(), before, "роутер что-то записал в skills/")
})

test("tokenize: lowercase, пунктуация, стоп-слова, короткие", () => {
  assert.deepEqual(tokenize("PHP-Function, test!"), ["php", "function", "test"])
  assert.deepEqual(tokenize("напиши код"), [], "стоп-слова и короткие выброшены")
})

test("scoreSkills: пустой запрос → пустой массив", () => {
  assert.deepEqual(scoreSkills("", skills), [])
  assert.deepEqual(scoreSkills("   ", skills), [])
  assert.deepEqual(scoreSkills("напиши код", skills), [], "только стоп-слова")
})

test("scoreSkills: PHP-запрос → php-скилл первым", () => {
  const top = scoreSkills("Напиши PHP-функцию format_price с PHPUnit-тестом", skills, 3)
  assert.ok(top.length > 0, "ничего не нашлось")
  assert.match(top[0]!.name, /php/i, `первым был ${top[0]!.name}`)
  assert.ok(top[0]!.score >= 3, `score ${top[0]!.score} — ожидалось попадание в имя`)
})

test("scoreSkills: TypeScript-запрос → typescript первым, php не в топе", () => {
  const top = scoreSkills("Напиши TypeScript-функцию slugify с vitest-тестом", skills, 3)
  assert.ok(top.length > 0)
  assert.match(top[0]!.name, /typescript/i, `первым был ${top[0]!.name}`)
  assert.ok(!top.some((s) => /^php/i.test(s.name)), "php-скилл попал в TS-запрос")
})

test("scoreSkills: бессмысленный запрос → пусто", () => {
  assert.deepEqual(scoreSkills("квантовая телепортация зубов", skills), [])
})

test("renderSkillHint: пустой запрос и отсутствие совпадений → пустая строка", () => {
  assert.equal(renderSkillHint(""), "")
  assert.equal(renderSkillHint("квантовая телепортация зубов"), "")
})

test("renderSkillHint: непустой → блок с именами и обоснованием", () => {
  const hint = renderSkillHint("php функция с тестом", 3, REPO)
  assert.ok(hint.startsWith("<skill_hint>"), hint.slice(0, 40))
  assert.ok(hint.trimEnd().endsWith("</skill_hint>"))
  assert.match(hint, /php/i)
  assert.match(hint, /score \d+/)
  assert.ok((hint.match(/^- /gm) ?? []).length <= 3, "топ больше 3")
})

test("skillTriage: пустой запрос и промах — понятные сообщения, без исключения", () => {
  assert.match(skillTriage(""), /empty query/)
  assert.match(skillTriage("квантовая телепортация зубов"), /no skills matched/)
  assert.match(skillTriage("квантовая телепортация зубов"), /known skills: \d+/)
})

test("skillTriage: находит php и печатает score/name/source", () => {
  const out = skillTriage("phpunit тест для функции", 5, REPO)
  assert.match(out, /\d+\tphp/)
  assert.match(out, /\t(local|global)\t/)
})

test("stripAvailableSkills: срезает блок, идемпотентна, не-строки не трогает", () => {
  const system = [
    "шапка",
    "<available_skills>\n  <skill><name>a</name></skill>\n</available_skills>",
    42,
    null,
    "хвост",
  ]
  assert.equal(stripAvailableSkills(system), 1)
  assert.equal(system[1], "")
  assert.equal(system[0], "шапка")
  assert.equal(system[2], 42)
  assert.equal(system[4], "хвост")
  assert.equal(stripAvailableSkills(system), 0, "второй проход обязан бытьnoop")
})

test("stripAvailableSkills: не массив → 0, без исключения", () => {
  assert.equal(stripAvailableSkills("строка" as unknown as unknown[]), 0)
  assert.equal(stripAvailableSkills(null as unknown as unknown[]), 0)
})

// ponytail: потолок — чистые ключевые слова без TF-IDF, поэтому на размытых запросах
// (score 1 по одному слову) топ может быть шумным. Апгрейд: TF-IDF или эмбеддинги,
// если шум начнёт мешать или роустер перерастёт ~300 скиллов.
test(" Scoring детерминирован: два вызова дают одинаковый порядок", () => {
  const a = scoreSkills("tests evidence gate", skills, 5)
  const b = scoreSkills("tests evidence gate", skills, 5)
  assert.deepEqual(a, b)
})

test("UC-035: стековый алиас даёт +2 целевому скиллу и выводит его в топ", () => {
  assert.equal(aliasBoosts("почини composer.lock")["php-pro"], 2)
  // ponytail: потолок — алиас даёт +2 и не выигрывает у сильного шума
  // (2 совпадения по имени дают 6-7). Апгрейд: TF-IDF/эмбеддинги, если шум
  // на реальных запросах начнёт чаще побеждать явный стек.
  const names = scoreSkills("cargo clippy падает в media-sdk", skills, 1).map((s) => s.name)
  assert.deepEqual(names, ["rust-engineer"], `cargo/clippy не вывели rust-engineer в топ-1: ${names.join(", ")}`)
  // пустое/бессмысленное не триггерит словарь
  assert.deepEqual(aliasBoosts("   "), {})
  // подстрока не ложное срабатывание: "pipeline" ≠ "pip"
  assert.equal(aliasBoosts("build pipeline broken")["python-pro"], undefined)
})

test("UC-035: явное намерение сильнее случайного совпадения description", () => {
  assert.equal(aliasBoosts("напиши полную документацию API")["code-documenter"], 5)
  assert.equal(aliasBoosts("проведи security audit")["security-reviewer"], 5)
  assert.equal(aliasBoosts("создай коммит")["commit-and-push"], 5)
})

test("UC-035: приоритет стека проекта (php/destroyers/sandbox → php-скиллы)", () => {
  const boosts = projectBoosts("/Users/Shared/bench-work/destroyers")
  assert.equal(boosts["php-pro"], 4)
  assert.equal(boosts["php-testing"], 4)
  assert.deepEqual(projectBoosts(""), {})
  assert.deepEqual(projectBoosts(undefined), {})
  const ts = projectBoosts("/Users/me/work/typescript-api")
  assert.equal(ts["typescript-pro"], 4)
  // стек-приоритет перебивает шумный текст запроса
  const names = scoreSkills("review the diff and commit", skills, 3, projectBoosts("/w/destroyers")).map((s) => s.name)
  assert.ok(names.includes("php-pro"), `стек не приоритетен: ${names.join(", ")}`)
})

test("UC-035: запрос длиннее 500 символов не получает skill_hint", () => {
  assert.equal(renderSkillHint("x".repeat(MAX_HINT_QUERY + 1), 3, REPO), "")
  assert.equal(renderSkillHint("x".repeat(MAX_HINT_QUERY), 3, REPO), "")
  assert.ok(renderSkillHint("почини cargo", 3, REPO).includes("<skill_hint>"))
})
