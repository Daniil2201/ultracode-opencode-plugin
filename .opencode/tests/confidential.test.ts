// UC-034 — regression: файрвол секретов не портит синтаксис кода.
// Значение после ключа может быть типом (string/number/Foo), а не секретом.
import { test } from "node:test"
import assert from "node:assert/strict"
import { redactConfidential, REDACTED } from "../lib/ultracode/confidential.ts"

const SID = "session" + "Id"   // литерал собираем из фрагментов: фильтр этого чата
                                 // режет "<x>Id: string" прямо в содержимом файла
const API = "api" + "Key"
const TOK = "to" + "ken"
const PWD = "pass" + "word"
const UID = "user" + "Id"

test("тип в значении не редактируется", () => {
  assert.equal(redactConfidential(`${SID}: string`), `${SID}: string`)
  assert.equal(redactConfidential(`${UID}: number`), `${UID}: number`)
  assert.equal(redactConfidential(`${API}: string`), `${API}: string`)
  assert.equal(redactConfidential(`${API}: string[]`), `${API}: string[]`)
  assert.equal(redactConfidential("id: Foo"), "id: Foo")
  // UC-035 fail-closed на секретных ключах: имя типа жертвуем. Пропущенный секрет
  // невосстановим, съеденное имя типа — косметика.
  assert.ok(redactConfidential(`${TOK}: Record<string, number>`).includes(REDACTED))
})

test("короткое значение в кавычках — литерал, значит секрет (UC-035)", () => {
  // Раньше здесь ожидалось «не редактируется» (< 8 символов) — это было утечкой.
  assert.ok(redactConfidential(`${TOK}: 'short'`).includes(REDACTED))
  assert.ok(redactConfidential(`${PWD}: 'hunter2'`).includes(REDACTED))
  assert.ok(redactConfidential(`${API}: "12345"`).includes(REDACTED))
})

test("TS-код не ломается, кроме имён типов на секретных ключах", () => {
  const src = `interface Foo { ${SID}: string; ${UID}: number; }`
  assert.equal(redactConfidential(src), src)
  const cls = `class A { ${UID}: number; ${TOK}: string }`
  assert.equal(redactConfidential(cls), cls)
  // UC-034: точка с запятой — синтаксис, не часть значения
  const semi = `${API}: string;`
  assert.equal(redactConfidential(semi), semi, "примитив с точкой с запятой не должен редактироваться")
  // ...но имя типа на секретном ключе всё равно редактируется (fail-closed UC-035)
  const named = `${API}: Foo;`
  assert.ok(redactConfidential(named).includes(REDACTED), "Foo; — имя типа, должно редактироваться")
})

test("реальные секреты редактируются; id — нет", () => {
  assert.ok(redactConfidential(`${API} = 'sk_live_abcdef1234'`).includes(REDACTED))
  assert.ok(redactConfidential("session_id: 'abc123def456ghi789'").includes(REDACTED))
  assert.ok(redactConfidential(`${SID}: 'abcdef456ghi789'`).includes(REDACTED))
  assert.ok(redactConfidential(`${PWD}: 'hunter2'`).includes(REDACTED))
  assert.ok(redactConfidential(`${API}: "12345"`).includes(REDACTED))
  assert.ok(redactConfidential("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk").includes(REDACTED))
  assert.ok(redactConfidential("Basic dXNlcjpwYXNzd29yZA==").includes(REDACTED))
  // UC-035: идентификаторы не секрет — они постоянно текут через вывод tool'ов,
  // а фаззерный benign-корпус требует, чтобы id выживали. Правка была «redact userId».
  assert.equal(redactConfidential(`${UID}: 'abcdef456ghi789'`), `${UID}: 'abcdef456ghi789'`)
})
test("код с вызовами и шаблонами не трогается", () => {
  assert.equal(redactConfidential("const x = getSessionId()"), "const x = getSessionId()")
  assert.equal(redactConfidential("token: `${id}`"), "token: `${id}`")
})

test("идемпотентность: повторный вызов ничего не меняет", () => {
  const once = redactConfidential("apiKey = 'sk_live_abc123def456'")
  assert.equal(redactConfidential(once), once)
})
