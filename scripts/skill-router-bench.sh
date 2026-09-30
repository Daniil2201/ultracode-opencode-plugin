#!/usr/bin/env bash
# skill-router-bench.sh — стенд scoring'а на реальных user-запросах из БД opencode.
#   bash scripts/skill-router-bench.sh            # сводка
#   bash scripts/skill-router-bench.sh --detail   # + построчный разбор
#   bash scripts/skill-router-bench.sh --json     # машинный вывод
# Читает .opencode/tests/fixtures/skill-router-queries.json (реальные запросы),
# гоняет их через lib/ultracode/skill-router.ts, печатает top-3 и метрики.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-summary}"
MODE="${MODE#--}"   # --detail/--json -> detail/json
T="$ROOT/.opencode/tests/fixtures/skill-router-queries.json"
[ -f "$T" ] || { echo "нет фикстуры: $T" >&2; exit 1; }

BENCH_ROOT="$ROOT" BENCH_MODE="$MODE" node --experimental-strip-types -e '
const fs = require("node:fs")
const root = process.env.BENCH_ROOT
;(async () => {
  const { scoreSkills, collectSkills } = await import(`${root}/.opencode/lib/ultracode/skill-router.ts`)
  const rows = JSON.parse(fs.readFileSync(`${root}/.opencode/tests/fixtures/skill-router-queries.json`, "utf8"))
  const skills = collectSkills(root, true)
  const mode = process.env.BENCH_MODE
  const labeled = rows.filter((r) => r.expected_skill)
  // Гипотеза: длинные пасты (логи, инструкции) топят смысл запроса.
  // Считаем метрики для полного текста и для обрезанного.
  const cut = {
    full: (q) => q,
    "200ch": (q) => q.slice(0, 200),
    "first-sentence": (q) => (q.split(/(?<=[.!?])\s/)[0] || q).slice(0, 200),
  }
  const metrics = (transform) => {
    let top1 = 0, top3 = 0, empty = 0, weak = 0, strong = 0, sum = 0
    for (const r of rows) {
      const top = scoreSkills(transform(r.query), skills, 3)
      if (top.length === 0) empty++
      else { sum += top[0].score; if (top[0].score <= 1) weak++; if (top[0].score >= 3) strong++ }
      const names = top.map((t) => t.name)
      if (r.expected_skill) {
        if (names[0] === r.expected_skill) top1++
        if (names.includes(r.expected_skill)) top3++
      }
    }
    const n = labeled.length
    return { top1, top3, empty, weak, strong,
      acc1: n ? top1 / n : 0, acc3: n ? top3 / n : 0,
      emptyRate: empty / rows.length, weakRate: weak / Math.max(rows.length - empty, 1),
      avg: Number((sum / Math.max(rows.length - empty, 1)).toFixed(2)) }
  }
  const byMode = Object.fromEntries(Object.entries(cut).map(([k, fn]) => [k, metrics(fn)]))

  // Гипотеза улучшения: алиасы стека вместо апгрейда до TF-IDF.
  // Меряем здесь, не трогая ядро: подставляем синонимы в текст запроса.
  const ALIASES = [
    [/\b(phpunit|composer|doctrine|symfony|laravel|artisan|blade|migrat)\w*\b/gi, " php-pro "],
    [/\b(cargo|clippy|rustfmt|tokio|actix|rustc)\b/gi, " rust-engineer "],
    [/\b(vitest|tsconfig|ts-node|nodemon|tsx|eslint|prettier|tsup)\b/gi, " typescript-pro "],
    [/\b(flutter|dart|pub\.yaml)\b/gi, " flutter-expert "],
    [/\b(pydantic|django|fastapi|pytest|poetry|uvicorn|ruff|mypy)\b/gi, " python-pro "],
    [/\b(gofmt|goroutine|grpc|go\.mod)\b/gi, " golang-pro "],
    [/\b(gradle|jetpack|kotlin)\b/gi, " kotlin-specialist "],
    [/\b(dockerfile|docker-compose|compose\.ya?ml)\b/gi, " devops-engineer "],
    [/\b(readme|changelog|jsdoc|документаци[яию])\w*/gi, " code-documenter "],
    [/\b(postgres|postgresql|mysql|vacuum|репликаци[яию])\b/gi, " sql-pro "],
    [/\b(ревью|code review|обзор кода)\b/gi, " code-reviewer "],
    [/\b(openapi|swagger|эндпоинт|endpoint)\w*/gi, " api-designer "],
    [/\b(логирован|observability|мониторинг|трейс)\w*/gi, " add-observability "],
    [/\b(инициализир|обкатаф|scaffold)\w*/gi, " init-project "],
    [/\b(закоммить|коммит|git push|коммитить)\b/gi, " commit-and-push "],
  ]
  const withAliases = (q) => ALIASES.reduce((acc, [re, rep]) => acc.replace(re, rep), q)
  const aliased = metrics(withAliases)
  // Короткие запросы отдельно: там роутер обязан работать.
  const short = rows.filter((r) => r.query.length <= 120)
  const shortLabeled = short.filter((r) => r.expected_skill)
  let s1 = 0, s3 = 0
  for (const r of short) {
    const names = scoreSkills(r.query, skills, 3).map((t) => t.name)
    if (r.expected_skill && names[0] === r.expected_skill) s1++
    if (r.expected_skill && names.includes(r.expected_skill)) s3++
  }
  let top1 = 0, top3 = 0, empty = 0, weak = 0, strong = 0, sumTop1 = 0
  const misses = []
  for (const r of rows) {
    const top = scoreSkills(r.query, skills, 3)
    if (top.length === 0) empty++
    else {
      sumTop1 += top[0].score
      if (top[0].score <= 1) weak++
      if (top[0].score >= 3) strong++
    }
    const names = top.map((t) => t.name)
    if (r.expected_skill) {
      if (names[0] === r.expected_skill) top1++
      if (names.includes(r.expected_skill)) top3++
      else misses.push({ q: r.query, want: r.expected_skill, got: names, marker: r.marker })
    }
    if (mode === "detail") {
      const hit = r.expected_skill ? (names[0] === r.expected_skill ? "TOP1" : names.includes(r.expected_skill) ? "top3" : "MISS") : "-"
      const line = top.map((t) => `${t.name}:${t.score}`).join(" ") || "(пусто)"
      console.log(`${hit.padEnd(4)} | ${r.query.slice(0, 60).padEnd(60)} | ${line}`)
    }
  }
  const res = {
    total: rows.length, labeled: labeled.length, skills: skills.length,
    top1, top3, empty, weak, strong,
    avgTop1: top1 ? Number((sumTop1 / rows.length).toFixed(2)) : 0,
    accuracyTop1: labeled.length ? Number((top1 / labeled.length).toFixed(3)) : 0,
    accuracyTop3: labeled.length ? Number((top3 / labeled.length).toFixed(3)) : 0,
    emptyRate: Number((empty / rows.length).toFixed(3)),
    weakRate: Number((weak / Math.max(rows.length - empty, 1)).toFixed(3)),
    misses: misses.slice(0, 40),
  }
  if (mode === "json") { console.log(JSON.stringify(res, null, 2)); return }
  console.log("")
  console.log("=== skill-router bench: реальные user-запросы ===")
  console.log(`скиллов в роустере: ${res.skills}   запросов: ${res.total}   с меткой: ${res.labeled}`)
  console.log(`top-1 accuracy: ${res.top1}/${res.labeled} = ${(res.accuracyTop1 * 100).toFixed(1)}%`)
  console.log(`top-3 accuracy: ${res.top3}/${res.labeled} = ${(res.accuracyTop3 * 100).toFixed(1)}%`)
  console.log(`пустых подсказок: ${res.empty}/${res.total} = ${(res.emptyRate * 100).toFixed(1)}%`)
  console.log(`слабых совпадений (score<=1, только description): ${res.weak} = ${(res.weakRate * 100).toFixed(1)}%   сильных (score>=3, попали в имя): ${res.strong}`)
  console.log(`средний score top-1: ${res.avgTop1}`)
  console.log("")
  console.log("--- по режимам обрезки (метрики те же, но query короче) ---")
  for (const [k, m] of Object.entries(byMode)) {
    console.log(`  ${k.padEnd(16)} top1=${(m.acc1 * 100).toFixed(1)}%  top3=${(m.acc3 * 100).toFixed(1)}%  empty=${(m.emptyRate * 100).toFixed(1)}%  weak=${(m.weakRate * 100).toFixed(1)}%  avg=${m.avg}`)
  }
  console.log("")
  console.log(`  ${"aliases".padEnd(16)} top1=${(aliased.acc1 * 100).toFixed(1)}%  top3=${(aliased.acc3 * 100).toFixed(1)}%  empty=${(aliased.emptyRate * 100).toFixed(1)}%  weak=${(aliased.weakRate * 100).toFixed(1)}%  avg=${aliased.avg}   <- гипотеза улучшения`)
  console.log(`--- короткие запросы (<=120 симв.): ${short.length}, с меткой ${shortLabeled.length}`)
  console.log(`  top1=${s1}/${shortLabeled.length} = ${shortLabeled.length ? ((s1 / shortLabeled.length) * 100).toFixed(1) : 0}%  top3=${s3}/${shortLabeled.length} = ${shortLabeled.length ? ((s3 / shortLabeled.length) * 100).toFixed(1) : 0}%`)
  console.log("")
  console.log("--- промахи top-3 (первые 20) ---")
  for (const m of res.misses.slice(0, 20)) {
    console.log(`  want=${m.want.padEnd(22)} marker=${String(m.marker).padEnd(12)} got=${m.got.join(",") || "(пусто)"}`)
    console.log(`      q: ${m.q.slice(0, 90)}`)
  }
})()
' 2>/dev/null
