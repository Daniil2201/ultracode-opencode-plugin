// Фаза 5: action=budget — profile и ручные тройки порогов через настоящий tool path.
import { test } from "node:test"
import assert from "node:assert/strict"
import { makeRuntime } from "./runtime/fixtures.ts"


const thresholdsOrAbsent = (rt: { readStoreRaw: () => string }) => {
  try {
    return thresholdsOf(rt.readStoreRaw())
  } catch {
    return { soft: undefined, hard: undefined, emergency: undefined } // файл не создан — изменений нет
  }
}

const thresholdsOf = (raw: string) => {
  const s = JSON.parse(raw)
  return { soft: s.config.thresholdSoft, hard: s.config.thresholdHard, emergency: s.config.thresholdEmergency }
}

for (const [profile, want] of [
  ["aggressive", { soft: 30, hard: 45, emergency: 60 }],
  ["balanced", { soft: 40, hard: 60, emergency: 75 }],
  ["conservative", { soft: 50, hard: 70, emergency: 85 }],
] as const) {
  test(`action=budget profile=${profile} → ${want.soft}/${want.hard}/${want.emergency}`, async () => {
    const rt = await makeRuntime()
    try {
      const out = await rt.callTool({ action: "budget", profile })
      assert.ok(out.includes(`soft=${want.soft}`) && out.includes(`hard=${want.hard}`), `ответ: ${out}`)
      assert.deepEqual(thresholdsOf(rt.readStoreRaw()), want)
    } finally {
      rt.cleanup()
    }
  })
}

test("action=budget profile=nonsense → ошибка, стор не меняется", async () => {
  const rt = await makeRuntime()
  try {
    const out = await rt.callTool({ action: "budget", profile: "nonsense" })
    assert.ok(out.includes("неизвестный"), `ответ: ${out}`)
    assert.deepEqual(thresholdsOrAbsent(rt), { soft: undefined, hard: undefined, emergency: undefined })
  } finally {
    rt.cleanup()
  }
})

test("action=budget ручная тройка 30/45/60 → записана", async () => {
  const rt = await makeRuntime()
  try {
    const out = await rt.callTool({ action: "budget", thresholdSoft: 30, thresholdHard: 45, thresholdEmergency: 60 })
    assert.ok(out.includes("thresholds:"), `ответ: ${out}`)
    assert.deepEqual(thresholdsOf(rt.readStoreRaw()), { soft: 30, hard: 45, emergency: 60 })
  } finally {
    rt.cleanup()
  }
})

test("action=budget тройка не по порядку 50/30/70 → ошибка, стор не меняется", async () => {
  const rt = await makeRuntime()
  try {
    const out = await rt.callTool({ action: "budget", thresholdSoft: 50, thresholdHard: 30, thresholdEmergency: 70 })
    assert.ok(out.includes("soft < hard"), `ответ: ${out}`)
    assert.deepEqual(thresholdsOrAbsent(rt), { soft: undefined, hard: undefined, emergency: undefined })
  } finally {
    rt.cleanup()
  }
})

test("action=budget тройка с 0 → ошибка диапазона, стор не меняется", async () => {
  const rt = await makeRuntime()
  try {
    const out = await rt.callTool({ action: "budget", thresholdSoft: 0, thresholdHard: 45, thresholdEmergency: 60 })
    assert.ok(out.includes("1..99"), `ответ: ${out}`)
    assert.deepEqual(thresholdsOrAbsent(rt), { soft: undefined, hard: undefined, emergency: undefined })
  } finally {
    rt.cleanup()
  }
})

test("action=budget limit=2000 → только budgetTokens, пороги не тронуты", async () => {
  const rt = await makeRuntime()
  try {
    await rt.callTool({ action: "budget", limit: 2000 })
    const s = JSON.parse(rt.readStoreRaw())
    assert.equal(s.config.budgetTokens, 2000)
    assert.deepEqual(thresholdsOrAbsent(rt), { soft: undefined, hard: undefined, emergency: undefined })
  } finally {
    rt.cleanup()
  }
})
