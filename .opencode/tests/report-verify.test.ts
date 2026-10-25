import { test } from "node:test"
import assert from "node:assert/strict"
import { parseClaims, classifyClaim, isCritical, verifyClaim, verifyReport } from "../lib/ultracode/report-verify.ts"

test("parseClaims splits by newlines first", () => {
  const report = "- Тесты прошли.\n- Файл foo.ts изменен.\n- Добавлен эндпоинт."
  const claims = parseClaims(report)
  assert.equal(claims.length, 3)
  assert.equal(claims[0].type, "test-result")
  assert.equal(claims[1].type, "file-change")
  assert.equal(claims[2].type, "endpoint")
})

test("parseClaims splits sentences within lines", () => {
  const report = "Тесты прошли. Файл foo.ts изменен."
  const claims = parseClaims(report)
  assert.equal(claims.length, 2)
})

test("parseClaims handles mixed newlines and sentences", () => {
  const report = "- Тесты прошли успешно.\n- Файл bar.ts изменен. Добавлен новый маршрут."
  const claims = parseClaims(report)
  assert.equal(claims.length, 3)
})

test("parseClaims filters short sentences", () => {
  const report = "Ok.\nТесты прошли успешно."
  const claims = parseClaims(report)
  assert.equal(claims.length, 1)
})

test("parseClaims handles numbered lists", () => {
  const report = "1. Тесты прошли.\n2. Файл изменен."
  const claims = parseClaims(report)
  assert.equal(claims.length, 2)
})

test("classifyClaim identifies test-result", () => {
  assert.equal(classifyClaim("Все тесты прошли"), "test-result")
  assert.equal(classifyClaim("Tests passed"), "test-result")
  assert.equal(classifyClaim("exit code 0"), "test-result")
  assert.equal(classifyClaim("Прогон завершен"), "test-result")
})

test("classifyClaim identifies file-change", () => {
  assert.equal(classifyClaim("Файл изменен"), "file-change")
  assert.equal(classifyClaim("File changed"), "file-change")
})

test("classifyClaim identifies endpoint", () => {
  assert.equal(classifyClaim("Добавлен эндпоинт"), "endpoint")
  assert.equal(classifyClaim("Endpoint added"), "endpoint")
})

test("classifyClaim identifies config", () => {
  assert.equal(classifyClaim("Конфиг обновлен"), "config")
})

test("classifyClaim defaults to other", () => {
  assert.equal(classifyClaim("Всё хорошо"), "other")
})

test("isCritical marks test/file/endpoint claims", () => {
  assert.equal(isCritical("Тесты прошли"), true)
  assert.equal(isCritical("Файл изменен"), true)
  assert.equal(isCritical("Всё хорошо"), false)
})

test("verifyClaim test-result: exit 0 → SUPPORTED", () => {
  const claim = { id: 1, text: "Тесты прошли", type: "test-result" as const, critical: true }
  const v = verifyClaim(claim, { exitCode: 0 })
  assert.equal(v.verdict, "SUPPORTED")
})

test("verifyClaim test-result: exit 1 → CONTRADICTED", () => {
  const claim = { id: 1, text: "Тесты прошли", type: "test-result" as const, critical: true }
  const v = verifyClaim(claim, { exitCode: 1 })
  assert.equal(v.verdict, "CONTRADICTED")
})

test("verifyClaim test-result: no exitCode → UNPROVEN", () => {
  const claim = { id: 1, text: "Тесты прошли", type: "test-result" as const, critical: true }
  const v = verifyClaim(claim, {})
  assert.equal(v.verdict, "UNPROVEN")
})

test("verifyClaim file-change: file in diff → SUPPORTED", () => {
  const claim = { id: 1, text: "Изменен файл foo.ts", type: "file-change" as const, critical: true }
  const v = verifyClaim(claim, { gitDiff: ["foo.ts", "bar.ts"] })
  assert.equal(v.verdict, "SUPPORTED")
})

test("verifyClaim file-change: file not in diff → CONTRADICTED", () => {
  const claim = { id: 1, text: "Изменен файл foo.ts", type: "file-change" as const, critical: true }
  const v = verifyClaim(claim, { gitDiff: ["bar.ts"] })
  assert.equal(v.verdict, "CONTRADICTED")
})

test("verifyClaim file-change: strict extension, no version match", () => {
  const claim = { id: 1, text: "Версия v2.0.32 обновлена", type: "file-change" as const, critical: true }
  const v = verifyClaim(claim, { gitDiff: ["foo.ts"] })
  // v2.0.32 should not match as filename
  assert.equal(v.verdict, "REFUSED")
})

test("verifyClaim file-change: json file in diff", () => {
  const claim = { id: 1, text: "Изменен файл config.json", type: "file-change" as const, critical: true }
  const v = verifyClaim(claim, { gitDiff: ["config.json"] })
  assert.equal(v.verdict, "SUPPORTED")
})

test("verifyClaim file-change: no filename → REFUSED", () => {
  const claim = { id: 1, text: "Файл изменен", type: "file-change" as const, critical: true }
  const v = verifyClaim(claim, { gitDiff: ["foo.ts"] })
  assert.equal(v.verdict, "REFUSED")
})

test("verifyClaim other → REFUSED", () => {
  const claim = { id: 1, text: "Всё хорошо", type: "other" as const, critical: false }
  const v = verifyClaim(claim, {})
  assert.equal(v.verdict, "REFUSED")
})

test("verifyReport: all critical SUPPORTED → valid", () => {
  const report = "Тесты прошли. Файл foo.ts изменен."
  const result = verifyReport(report, { exitCode: 0, gitDiff: ["foo.ts"] })
  assert.equal(result.valid, true)
})

test("verifyReport: one CONTRADICTED → invalid", () => {
  const report = "Тесты прошли. Файл foo.ts изменен."
  const result = verifyReport(report, { exitCode: 0, gitDiff: ["bar.ts"] })
  assert.equal(result.valid, false)
})

test("verifyReport: one UNPROVEN → invalid", () => {
  const report = "Тесты прошли."
  const result = verifyReport(report, {})
  assert.equal(result.valid, false)
})

test("verifyReport: non-critical claims don't block", () => {
  const report = "Тесты прошли. Всё хорошо."
  const result = verifyReport(report, { exitCode: 0 })
  assert.equal(result.valid, true)
})

test("verifyReport: summary describes failure", () => {
  const report = "Тесты прошли."
  const result = verifyReport(report, { exitCode: 1 })
  assert.ok(result.summary.includes("Провал"))
})

test("verifyReport: empty report → valid (no critical claims)", () => {
  const result = verifyReport("", {})
  assert.equal(result.valid, true)
  assert.equal(result.claims.length, 0)
})

test("verifyReport: markdown list report", () => {
  const report = "- Тесты прошли.\n- Файл foo.ts изменен.\n- Добавлен эндпоинт."
  const result = verifyReport(report, { exitCode: 0, gitDiff: ["foo.ts"], files: ["src/api.ts"] })
  assert.equal(result.valid, true)
  assert.equal(result.claims.length, 3)
})
