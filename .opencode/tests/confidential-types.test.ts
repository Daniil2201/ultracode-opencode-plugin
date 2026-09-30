// UC-034 — регресс: файрвол не должен съедать ТИПЫ и переводы строк.
//
// ВАЖНО: строки собираются из фрагментов. Пока баг жив, литерал вида
// `sessionId: string` в содержимом файла портится по дороге (фильтр применяется
// к тексту инструментов до записи) — ровно то, что мы чиним. Когда фильтр
// починят, можно будет писать литералы прямо.
import { test } from "node:test"
import assert from "node:assert/strict"
import { redactConfidential, REDACTED } from "../lib/ultracode/confidential.ts"

const SID = "session" + "Id"
const STR = "str" + "ing"

test("тип после ключа не редактируется", () => {
  assert.equal(redactConfidential(`  ${SID}: ${STR}`), `  ${SID}: ${STR}`)
  assert.equal(redactConfidential(`interface Foo { ${SID}: ${STR}; userId: number }`),
    `interface Foo { ${SID}: ${STR}; userId: number }`)
})

test("JSON-экранирование: \\n после типа больше не съедается (UC-034)", () => {
  const input = `  ${SID}: ${STR}\\n  next: 1`
  const out = redactConfidential(input)
  assert.equal(out, input, "перевод строки или значение изменились")
  assert.ok(!out.includes(REDACTED), "тип был принят за секрет")
})

test("то же для \\t в конце значения", () => {
  for (const esc of ["\\t", "\\\\"]) {
    const input = `${SID}: ${STR}${esc}`
    assert.equal(redactConfidential(input), input, `искажение на ${esc}`)
  }
})

test("настоящий секрет по-прежнему прячется", () => {
  assert.ok(redactConfidential(`${SID}: 'abc123def456ghi789'`).includes(REDACTED))
  assert.ok(redactConfidential("api_key = 'sk_live_abcdefgh'").includes(REDACTED))
  assert.ok(redactConfidential("API_KEY=sk_live_51H8xQ2eZvKYlo2C").includes(REDACTED))
  assert.ok(redactConfidential("Cookie: JSESSIONID=9F1A2B3C4D5E6F70; Path=/").includes(REDACTED))
  assert.ok(
    redactConfidential("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk").includes(REDACTED),
  )
})

// UC-035: значение в кавычках — литерал, даже из 5 символов → это секрет.
test("короткое значение в кавычках редактируется", () => {
  assert.ok(redactConfidential("token: 'short'").includes(REDACTED))
  assert.ok(redactConfidential('password: "x1"').includes(REDACTED))
})

test("JSON-аргументы тула целиком остаются валидным JSON", () => {
  const args = JSON.stringify({ tool: "edit", args: { newString: `  ${SID}: ${STR}\n` } })
  const out = redactConfidential(args)
  assert.doesNotThrow(() => JSON.parse(out), "после redact JSON не парсится")
  assert.equal(JSON.parse(out).args.newString, `  ${SID}: ${STR}\n`, "полезная нагрузка изменилась")
})
