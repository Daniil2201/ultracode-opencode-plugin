// context-pruner: чистое ядро сжатия. Закрывает acceptance 1-7 и 14 из
// spec/context-pruner.md: уровни из evaluate(), in-place applyPrune, инвариант
// tool_result, защищённые тулы, protectRecent, детерминизм, измеримая экономия.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  planPrune, applyPrune, levelFor, placeholder, originalContent,
  PROTECTED_TOOLS, KEEP_HEAD, KEEP_TAIL, TRUNCATE_HEAD,
} from "../lib/ultracode/pruner.ts"
import type { PrunableMessage, PrunablePart, PrunableState } from "../lib/ultracode/pruner.ts"
import { tokens } from "../lib/ultracode/tokens.ts"

const user = (id: string, text = "go"): PrunableMessage => ({
  info: { id, role: "user", sessionID: "s1" },
  parts: [{ id: `${id}-t`, type: "text", text }],
})
const tool = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  output: string,
  extra: Partial<PrunableState> = {},
): PrunablePart => ({
  id,
  type: "tool",
  callID: `call-${id}`,
  tool: name,
  state: { status: "completed", input, output, ...extra },
})
const out = (m: PrunableMessage, id: string): string => {
  const p = (m.parts ?? []).find((x) => x.id === id)
  const o = p?.state?.output
  return typeof o === "string" ? o : ""
}

// История из трёх user-ходов: последние protectRecent(2) защищены, всё, что
// между ними и до них — кандидаты.
const history = (parts: PrunablePart[]): PrunableMessage[] => [
  user("u1"),
  { info: { id: "a1", role: "assistant", sessionID: "s1" }, parts },
  user("u2"),
  { info: { id: "a2", role: "assistant", sessionID: "s1" }, parts: [tool("t-tail", "read", { f: "z" }, "свежо")] },
  user("u3"),
]

// ─── уровни ─────────────────────────────────────────────────────────
test("levelFor: ok -> off, остальные уровни бюджета проходят как есть", () => {
  assert.equal(levelFor("ok"), "off")
  assert.equal(levelFor("soft"), "soft")
  assert.equal(levelFor("hard"), "hard")
  assert.equal(levelFor("emergency"), "emergency")
})

test("off: массив без изменений, actions пуст", () => {
  const h = history([tool("t1", "read", { f: "a" }, "a".repeat(5000))])
  const { messages, report } = planPrune(h, "off")
  assert.equal(report.actions.length, 0)
  assert.equal(report.level, "off")
  assert.equal(report.charsBefore, report.charsAfter)
  assert.deepStrictEqual(messages, h)
  assert.equal(out(messages[1] as PrunableMessage, "t1"), "a".repeat(5000))
})

// ─── soft: dedupe + purge-error ─────────────────────────────────────
test("soft: dedupe одинаковых tool+input — все, кроме последнего", () => {
  const h = history([
    tool("t1", "read", { filePath: "a.ts" }, "одинаковый вывод"),
    tool("t2", "read", { filePath: "a.ts" }, "одинаковый вывод"),
    tool("t3", "read", { filePath: "b.ts" }, "другой вывод"),
  ])
  const { messages, report } = planPrune(h, "soft")
  const a1 = messages[1] as PrunableMessage
  assert.match(out(a1, "t1"), /^\[pruned dedupe: read\]/)
  assert.match(out(a1, "t1"), /recall_pruned messageId="a1" partId="t1"/)
  assert.equal(out(a1, "t2"), "одинаковый вывод")
  assert.equal(out(a1, "t3"), "другой вывод")
  assert.deepStrictEqual(report.actions.map((a) => a.partID), ["t1"])
  // Исходный объект не мутируется: транскрипт пересобирается каждый ход.
  assert.equal(out(h[1] as PrunableMessage, "t1"), "одинаковый вывод")
})

test("soft: purge-error чистит error, в плейсхолдере только имя тула", () => {
  const h = history([
    tool("t1", "bash", { command: "boom" }, "", {
      status: "error",
      error: "TypeError: x is not a function\n  at deep/stack/frame.ts:1:1",
    }),
  ])
  const { messages, report } = planPrune(h, "soft")
  const a1 = messages[1] as PrunableMessage
  const p = (a1.parts ?? [])[0] as PrunablePart
  assert.equal(p.state?.error, "")
  assert.match(String(p.state?.output), /^\[pruned purge-error: bash\] \d+→0 симв\./)
  assert.equal(String(p.state?.output).includes("TypeError"), false)
  assert.deepStrictEqual(report.actions.map((a) => a.kind), ["purge-error"])
})

test("soft: не трогает bash-вывод и записи write (это уровень hard)", () => {
  const big = "x".repeat(50_000)
  const h = history([
    tool("t1", "bash", { command: "npm test" }, big),
    tool("t2", "write", { filePath: "/a.ts" }, "v1"),
    tool("t3", "write", { filePath: "/b.ts" }, "v2"),
  ])
  const { messages, report } = planPrune(h, "soft")
  assert.equal(report.actions.length, 0)
  assert.equal(out(messages[1] as PrunableMessage, "t1"), big)
  assert.equal(out(messages[1] as PrunableMessage, "t2"), "v1")
  // На hard те же записи схлопываются по пути, а лог урезается.
  const hard = planPrune(h, "hard").report
  assert.deepStrictEqual(hard.actions.map((a) => a.kind).sort(), ["collapse-bash"])
})

// ─── hard: supersede + collapse-bash ────────────────────────────────
test("hard: supersede оставляет последнюю запись пути, прошлые -> плейсхолдер", () => {
  // input у правок разный (oldString/newString) — иначе их съел бы dedupe (soft),
  // который в каскаде идёт раньше.
  const h = history([
    tool("t1", "edit", { filePath: "/a.ts", oldString: "1", newString: "2" }, "запись 1"),
    tool("t2", "edit", { filePath: "/a.ts", oldString: "2", newString: "3" }, "запись 2"),
    tool("t3", "edit", { filePath: "/a.ts", oldString: "3", newString: "4" }, "запись 3"),
  ])
  const { messages, report } = planPrune(h, "hard")
  const a1 = messages[1] as PrunableMessage
  assert.match(out(a1, "t1"), /^\[pruned supersede: edit\]/)
  // recall указывает на САМ сжатый part (его оригинал в сторе), актуальная
  // версия названа словами — recall по ней нечего возвращать.
  assert.match(out(a1, "t1"), /recall_pruned messageId="a1" partId="t1"/)
  assert.match(out(a1, "t1"), /Актуальная версия: edit в partId="t3"/)
  assert.equal(out(a1, "t3"), "запись 3")
  assert.deepStrictEqual(report.actions.map((a) => a.partID), ["t1", "t2"])
  // Разные пути не трогаются.
  const two = history([
    tool("t1", "write", { filePath: "/a.ts" }, "a"),
    tool("t2", "write", { filePath: "/b.ts" }, "b"),
  ])
  assert.equal(planPrune(two, "hard").report.actions.length, 0)
})

test("hard: collapse-bash оставляет KEEP_HEAD + elision + KEEP_TAIL", () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line-${i}`).join("\n")
  const h = history([tool("t1", "bash", { command: "npm test" }, big)])
  const { messages, report } = planPrune(h, "hard")
  const o = out(messages[1] as PrunableMessage, "t1")
  assert.ok(o.length < big.length, "вывод урезан")
  assert.ok(o.startsWith(big.slice(0, KEEP_HEAD)))
  assert.ok(o.endsWith(big.slice(big.length - KEEP_TAIL)))
  assert.match(o, /\[pruned collapse-bash: bash\] \d+→\d+ симв\./)
  assert.equal(report.actions[0]?.kind, "collapse-bash")
  // Короткий вывод не трогаем — элизия ради элизии.
  const small = history([tool("t2", "bash", { command: "ls" }, "короткий вывод")])
  assert.equal(planPrune(small, "hard").report.actions.length, 0)
})

// ─── emergency: truncate ────────────────────────────────────────────
test("emergency: truncate режет всё, что не поймали мягкие правила", () => {
  const h = history([
    tool("t1", "read", { filePath: "big.ts" }, "y".repeat(10_000)),
    tool("t2", "read", { filePath: "big2.ts" }, "y".repeat(10_000)),
  ])
  const { messages, report } = planPrune(h, "emergency")
  const a1 = messages[1] as PrunableMessage
  // Первые 400 символов + маркер: без recall-id модель не знает, что хвост в сторе.
  assert.ok(out(a1, "t1").startsWith("y".repeat(TRUNCATE_HEAD)))
  assert.match(out(a1, "t1"), /\[pruned truncate: read\] 10000→400 симв\. Оригинал: recall_pruned messageId="a1" partId="t1"/)
  // hard-правила каскадом тоже применяются, но не мешают truncate.
  assert.deepStrictEqual(report.actions.map((a) => a.kind), ["truncate", "truncate"])
})

// ─── acceptance 2: in-place обязателен ──────────────────────────────
test("applyPrune: мутирует переданный массив, ссылка та же", () => {
  const h = history([tool("t1", "read", { filePath: "a.ts" }, "одинаковый"), tool("t2", "read", { filePath: "a.ts" }, "одинаковый")])
  const messages = h as unknown as unknown[]
  const ref = messages
  const snapshot = JSON.stringify(messages)
  const { messages: pruned } = planPrune(h, "soft")
  applyPrune({ messages }, { messages: pruned })
  assert.strictEqual(messages, ref, "тот же объект массива")
  assert.notEqual(JSON.stringify(messages), snapshot, "содержимое изменилось")
})

test("applyPrune: переприсваивание output.messages ничего не пробрасывает", () => {
  // Зафиксированный контракт: вызывающий читает локальную переменную массива,
  // а output — тот же объект. Присваивание output.messages = other молча
  // ничего не делает — поэтому и нужен splice.
  const messages: unknown[] = history([tool("t1", "read", { filePath: "a" }, "x")])
  const output = { messages }
  output.messages = ["подмена"]
  assert.equal((messages[1] as PrunableMessage).parts?.length, 1)
  assert.equal(output.messages.length, 1)
})

// ─── acceptance 4: защищённые тулы ──────────────────────────────────
test("защищённые тулы не сжимаются ни на одном уровне, включая dedupe", () => {
  for (const name of PROTECTED_TOOLS) {
    const h = history([
      tool("t1", name, { filePath: "a" }, "решение записано"),
      tool("t2", name, { filePath: "a" }, "решение записано"),
    ])
    for (const level of ["soft", "hard", "emergency"] as const) {
      const { messages, report } = planPrune(h, level)
      assert.equal(report.actions.length, 0, `${name}@${level} не должен сжиматься`)
      assert.equal(out(messages[1] as PrunableMessage, "t1"), "решение записано")
    }
  }
  assert.deepStrictEqual([...PROTECTED_TOOLS], ["task", "skill", "ultracode_context"])
})

// ─── acceptance 5: инвариант tool_result ────────────────────────────
test("инвариант tool_result: ни один part не удалён, callID не исчез", () => {
  const h = history([
    tool("t1", "bash", { command: "a" }, "z".repeat(20_000)),
    tool("t2", "read", { filePath: "a" }, "одинаковый"),
    tool("t3", "read", { filePath: "a" }, "одинаковый"),
    tool("t4", "write", { filePath: "/f" }, "old"),
    tool("t5", "write", { filePath: "/f" }, "new"),
  ])
  for (const level of ["soft", "hard", "emergency"] as const) {
    const { messages } = planPrune(h, level)
    const before = h.flatMap((m) => m.parts ?? []).map((p) => p.callID)
    const after = messages.flatMap((m) => m.parts ?? []).map((p) => p.callID)
    assert.equal(after.length, before.length, `${level}: длина`)
    assert.deepStrictEqual(after, before, `${level}: callID`)
    // Каждый tool-part на месте и остаётся tool-part.
    for (const m of messages) {
      for (const p of m.parts ?? []) {
        if (p.type === "tool") assert.ok(p.state != null, "tool-part остаётся tool-part")
      }
    }
  }
})

// ─── acceptance 6: последние ходы целы ─────────────────────────────
test("protectRecent: последние 2 user-сообщения не тронуты ни на одном уровне", () => {
  const tailBig = "w".repeat(50_000)
  const oldBig = "v".repeat(30_000)
  const h: PrunableMessage[] = [
    user("u1"),
    { info: { id: "a1", role: "assistant" }, parts: [tool("t1", "read", { filePath: "old" }, oldBig)] },
    user("u2"),
    { info: { id: "a2", role: "assistant" }, parts: [tool("t2", "bash", { command: "npm test" }, tailBig)] },
    user("u3"),
    { info: { id: "a3", role: "assistant" }, parts: [tool("t3", "bash", { command: "npm run b" }, tailBig)] },
  ]
  for (const level of ["soft", "hard", "emergency"] as const) {
    const { messages } = planPrune(h, level)
    assert.equal(out(messages[3] as PrunableMessage, "t2"), tailBig, `${level}: ход u2 цел`)
    assert.equal(out(messages[5] as PrunableMessage, "t3"), tailBig, `${level}: ход u3 цел`)
  }
  // Старый ход при этом сжимается — защищённое окно не съело всю историю.
  assert.ok(planPrune(h, "emergency").report.actions.some((a) => a.partID === "t1"))
  // protectRecent: 0 — не защищено ничего.
  const { report } = planPrune(h, "emergency", { protectRecent: 0 })
  assert.ok(report.actions.some((a) => a.partID === "t3"))
})

// ─── acceptance 7: детерминизм ──────────────────────────────────────
test("детерминизм: два прогона дают побайтово равный отчёт и результат", async () => {
  const h = history([
    tool("t1", "read", { filePath: "a" }, "одинаковый"),
    tool("t2", "read", { filePath: "a" }, "одинаковый"),
    tool("t3", "bash", { command: "x" }, "q".repeat(30_000)),
  ])
  const a = planPrune(h, "emergency")
  await new Promise((r) => setTimeout(r, 10))
  const b = planPrune(h, "emergency")
  assert.equal(JSON.stringify(a.report), JSON.stringify(b.report))
  assert.equal(JSON.stringify(a.messages), JSON.stringify(b.messages))
  // В отчёте нет времени: иначе два прогона разошлись бы.
  assert.equal(/\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(a.report)), false)
})

// ─── acceptance 14: экономия измерима ───────────────────────────────
test("emergency: 50k bash-вывод даёт >2x экономии по символам и токенам", () => {
  const big = Array.from({ length: 6000 }, (_, i) => `log line ${i}`).join("\n")
  assert.ok(big.length > 50_000)
  const h = history([
    tool("t1", "bash", { command: "npm test" }, big),
    tool("t2", "read", { filePath: "a" }, big),
  ])
  const flat = (m: PrunableMessage[]): string => JSON.stringify(m)
  const { messages, report } = planPrune(h, "emergency")
  assert.ok(report.charsAfter < report.charsBefore / 2, `${report.charsAfter} < ${report.charsBefore / 2}`)
  assert.ok(tokens(flat(messages)) < tokens(flat(h)), "токенов на результате меньше")
})

// ─── устойчивость к мусору (бросать из хука нельзя) ──────────────────
test("planPrune: мусорный вход не бросает — [{}], parts: undefined, state: null", () => {
  const junk = [
    {},
    { info: null, parts: undefined },
    { info: { id: "m" }, parts: [null, undefined, { id: "x" }] },
    { info: { id: "m2" }, parts: [{ id: "p", type: "tool", tool: "bash", state: null }] },
    { info: { id: "m3" }, parts: [{ id: "p2", type: "tool", tool: "bash", state: { status: "error", input: 5 } }] },
  ] as unknown as PrunableMessage[]
  for (const level of ["off", "soft", "hard", "emergency"] as const) {
    const r = planPrune(junk, level)
    assert.equal(r.messages.length, junk.length)
  }
  assert.equal(planPrune([] as PrunableMessage[], "emergency").report.actions.length, 0)
})

test("originalContent: оригинал достаётся по messageID+partID до prune", () => {
  const h = history([tool("t1", "bash", { command: "x" }, "оригинальный вывод"), tool("t2", "bash", { command: "x" }, "оригинальный вывод")])
  const { report } = planPrune(h, "soft")
  const a = report.actions[0] as { messageID: string; partID: string }
  assert.equal(originalContent(h, a.messageID, a.partID), "оригинальный вывод")
  assert.equal(originalContent(h, "нет", "нет"), "")
})

test("placeholder: детерминированный формат со ссылкой на recall", () => {
  assert.equal(
    placeholder("dedupe", "read", 120, 0, { messageID: "m1", partID: "p1" }),
    '[pruned dedupe: read] 120→0 симв. Оригинал: recall_pruned messageId="m1" partId="p1"',
  )
})

test("пин (recall_pruned) защищает сообщение от сжатия на всех уровнях", () => {
  const h = history([tool("t1", "read", { filePath: "a" }, "одинаковый"), tool("t2", "read", { filePath: "a" }, "одинаковый")])
  const pinned = new Set(["a1"])
  for (const level of ["soft", "hard", "emergency"] as const) {
    const { report } = planPrune(h, level, { pinned })
    assert.equal(report.actions.length, 0, `${level}: запиннено`)
  }
  const { messages } = planPrune(h, "soft", { pinned })
  assert.equal(out(messages[1] as PrunableMessage, "t1"), "одинаковый")
})

// ─── стор оригиналов (acceptance 9, 10, 11) ────────────────────────
// Изолированный XDG: стор пишет только в pruned/, context.json не трогаем.
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  prunedFileFor, appendOriginal, appendPin, loadPins, findOriginals, readPruned, forgetPruneCache,
} from "../lib/ultracode/prune-store.ts"
import { storeFileFor, saveStoreFor, loadStoreFor } from "../lib/ultracode/store.ts"

const tmpXdg = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "uc-prune-"))
const cleanup = (dirs: string[]): void => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

test("стор: оригиналы пишутся в pruned/<sessionID>.jsonl, context.json не тронут", () => {
  const xdg = tmpXdg()
  const project = path.join(xdg, "proj")
  const prevXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = xdg
  try {
    saveStoreFor(project, loadStoreFor(project))
    const storeFile = storeFileFor(project)
    const before = fs.readFileSync(storeFile, "utf8")
    const beforeStat = fs.statSync(storeFile).mtimeMs

    const file = prunedFileFor(project, "ses_1")
    assert.equal(file.endsWith(path.join("pruned", "ses_1.jsonl")), true)
    assert.equal(appendOriginal(file, { messageID: "m1", partID: "p1", tool: "bash", content: "оригинал" }), "stored")
    assert.equal(appendPin(file, "m1"), true)

    assert.equal(fs.readFileSync(storeFile, "utf8"), before, "context.json побайтово идентичен")
    assert.equal(fs.statSync(storeFile).mtimeMs, beforeStat, "context.json не перезаписан")
    const rows = readPruned(file)
    assert.deepStrictEqual(rows.map((r) => r.kind), ["original", "pin"])
    assert.equal(rows[0]?.kind === "original" ? rows[0].content : "", "оригинал")
    assert.ok(fs.readdirSync(path.dirname(file)).includes("ses_1.jsonl"))
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
    forgetPruneCache()
    cleanup([xdg])
  }
})

test("стор: дедуп записи — два хода с тем же оригиналом дают одну запись", () => {
  const file = path.join(tmpXdg(), "pruned", "ses_dedup.jsonl")
  try {
    const rec = { messageID: "m1", partID: "p1", tool: "bash", content: "вывод" }
    assert.equal(appendOriginal(file, rec), "stored", "первый ход пишет")
    assert.equal(appendOriginal(file, rec), "duplicate", "второй ход — дубль, не пишем")
    assert.equal(appendOriginal(file, { ...rec, partID: "p2" }), "stored", "другой partID — новая запись")
    const originals = readPruned(file).filter((r) => r.kind === "original")
    assert.equal(originals.length, 2)
    // Реальный сценарий спеки: prune записал оригинал, следующий ход на том же
    // уровне — снова план, снова те же actions, и в файл ничего не дописывается.
    const h = history([tool("t1", "read", { f: "a" }, "вывод"), tool("t2", "read", { f: "a" }, "вывод")])
    for (let turn = 0; turn < 3; turn++) {
      const { report } = planPrune(h, "soft")
      for (const a of report.actions) {
        appendOriginal(file, {
          messageID: a.messageID, partID: a.partID, tool: a.tool,
          content: originalContent(h, a.messageID, a.partID),
        })
      }
    }
    assert.equal(readPruned(file).filter((r) => r.kind === "original" && r.partID === "p1").length, 1)
  } finally {
    forgetPruneCache()
  }
})

test("стор: секреты в оригинале редактируются (acceptance: не печатать секреты)", () => {
  const file = path.join(tmpXdg(), "pruned", "ses_secret.jsonl")
  try {
    appendOriginal(file, {
      messageID: "m1", partID: "p1", tool: "bash",
      content: "api_key=sk-0123456789abcdefghij export TOKEN=abcdef123456",
    })
    const row = readPruned(file)[0]
    const content = row?.kind === "original" ? row.content : ""
    assert.equal(content.includes("sk-0123456789abcdefghij"), false)
    assert.equal(fs.readFileSync(file, "utf8").includes("sk-0123456789abcdefghij"), false)
  } finally {
    forgetPruneCache()
  }
})

test("стор: пины переживают рестарт процесса и recall возвращает символ в символ", () => {
  const file = path.join(tmpXdg(), "pruned", "ses_pin.jsonl")
  const original = "y".repeat(5000)
  try {
    appendOriginal(file, { messageID: "m1", partID: "p1", tool: "read", content: original })
    assert.equal(appendPin(file, "m1"), true)
    assert.equal(appendPin(file, "m1"), false, "повторный пин — дубль")
    // «Рестарт»: память чистая, пины читаются из файла.
    forgetPruneCache()
    const pins = loadPins(file)
    assert.equal(pins.has("m1"), true)
    assert.equal(pins.has("m2"), false)
    // recall_pruned возвращает оригинал символ в символ.
    const found = findOriginals(file, "m1", "p1")
    assert.equal(found.length, 1)
    assert.equal(found[0]?.content, original)
    // Без partID — все оригиналы сообщения.
    assert.equal(findOriginals(file, "m1").length, 1)
    assert.equal(findOriginals(file, "нет").length, 0)
  } finally {
    forgetPruneCache()
  }
})

test("стор: запиненное сообщение planPrune больше не сжимает (acceptance 11)", () => {
  const file = path.join(tmpXdg(), "pruned", "ses_cycle.jsonl")
  const h = history([
    tool("t1", "read", { filePath: "a.ts" }, "одинаковый вывод"),
    tool("t2", "read", { filePath: "a.ts" }, "одинаковый вывод"),
  ])
  try {
    const first = planPrune(h, "soft")
    const action = first.report.actions[0] as { messageID: string; partID: string; tool: string }
    const content = originalContent(h, action.messageID, action.partID)
    appendOriginal(file, { messageID: action.messageID, partID: action.partID, tool: action.tool, content })
    appendPin(file, action.messageID)

    // Тот же ход, но оригинал уже запинен: сжатия нет.
    const second = planPrune(h, "soft", { pinned: loadPins(file) })
    assert.equal(second.report.actions.length, 0)
    assert.equal(originalContent(second.messages, "a1", "t1"), "одинаковый вывод")
    // Даже после рестарта процесса.
    forgetPruneCache()
    assert.equal(planPrune(h, "hard", { pinned: loadPins(file) }).report.actions.length, 0)
  } finally {
    forgetPruneCache()
  }
})

test("стор: битая строка в jsonl не делает файл нечитаемым", () => {
  const dir = path.join(tmpXdg(), "pruned")
  const file = path.join(dir, "ses_broken.jsonl")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({ kind: "pin", messageID: "m1", ts: "t" }) + "\n{битое\n" +
      JSON.stringify({ kind: "original", messageID: "m2", partID: "p2", tool: "read", content: "ok", ts: "t" }) + "\n",
    "utf8",
  )
  try {
    forgetPruneCache()
    const rows = readPruned(file)
    assert.equal(rows.length, 2)
    assert.equal(loadPins(file).has("m1"), true)
    assert.equal(findOriginals(file, "m2").length, 1)
  } finally {
    forgetPruneCache()
  }
})

// ─── хук целиком через настоящий runtime (acceptance 8, 12, 13) ─────
import { makeRuntime } from "./runtime/fixtures.ts"

// История с парой одинаковых вызовов: один prune = одно действие.
// sessionID везде "lab" — хук берёт sid из последнего сообщения, а usage живёт
// в карте по тому же sid.
const prunableHistory = (): PrunableMessage[] => {
  const u = (id: string): PrunableMessage => ({
    info: { id, role: "user", sessionID: "lab" },
    parts: [{ id: `${id}-t`, type: "text", text: "go" }],
  })
  const a = (id: string, parts: PrunablePart[]): PrunableMessage => ({
    info: { id, role: "assistant", sessionID: "lab" },
    parts,
  })
  return [
    u("u1"),
    a("a1", [
      tool("t1", "read", { filePath: "a.ts" }, "одинаковый вывод"),
      tool("t2", "read", { filePath: "a.ts" }, "одинаковый вывод"),
    ]),
    u("u2"),
    a("a2", [tool("t3", "bash", { command: "ls" }, "свежий")]),
    u("u3"),
  ]
}
const wasPruned = (h: PrunableMessage[]): boolean =>
  out(h[1] as PrunableMessage, "t1").startsWith("[pruned ")
const usageEvent = (pct: number): unknown => ({
  type: "message.updated",
  properties: { info: { sessionID: "lab", modelID: "test-model", tokens: { total: pct } } },
})

test("хук: мусорный вход не роняет run — исключение из transform валит сессию", async () => {
  const prevXdg = process.env.XDG_DATA_HOME
  const rt = await makeRuntime({ config: { modelLimit: 100 } })
  try {
    await rt.sendEvent(usageEvent(50)) // 50% -> soft: prune реально включается
    const junk = [
      {},
      { info: null, parts: undefined },
      {
        info: { id: "m9", role: "user", sessionID: "lab" },
        parts: [null, undefined, { id: "p" }, { id: "q", type: "tool", tool: "bash", state: null }],
      },
    ] as unknown as PrunableMessage[]
    // Ни один из этих вызовов не должен бросить.
    await rt.messagesTransform(junk as unknown as unknown[])
    await rt.messagesTransform([] as unknown[])
    await rt.messagesTransform(undefined as unknown as unknown[])
    await rt.messagesTransform({} as unknown as unknown[])
  } finally {
    rt.cleanup()
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
  }
})

test("хук: эпоха — 3 хода на одном уровне = один prune, смена уровня внутри эпохи не жмёт", async () => {
  const prevXdg = process.env.XDG_DATA_HOME
  const rt = await makeRuntime({ config: { modelLimit: 100 } })
  try {
    // Ход 1: первый не-"off" ход сжимает сразу. Ходы 2-3: тот же уровень внутри
    // эпохи -> тишина.
    for (const turn of [1, 2, 3]) {
      await rt.sendEvent(usageEvent(50))
      const h = prunableHistory()
      await rt.messagesTransform(h as unknown as unknown[])
      assert.equal(wasPruned(h), turn === 1, `ход ${turn}: prune ровно один раз`)
    }

    // Ходы 4-5: уровень вырос до hard, но эпоха (5 ходов) ещё не прошла.
    for (const pct of [70, 70]) {
      const h = prunableHistory()
      await rt.sendEvent(usageEvent(pct))
      await rt.messagesTransform(h as unknown as unknown[])
      assert.equal(wasPruned(h), false, `${pct}% внутри эпохи не сжимает`)
    }
    // Ход 6: прошло 5 ходов с последнего prune -> жмём на новом уровне.
    const h6 = prunableHistory()
    await rt.sendEvent(usageEvent(70))
    await rt.messagesTransform(h6 as unknown as unknown[])
    assert.equal(wasPruned(h6), true, "после эпохи уровень сменился — prune проходит")
  } finally {
    rt.cleanup()
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
  }
})

test("хук: после session.compacting transform на том же sid не жмёт и pruned/ пуст", async () => {
  const prevXdg = process.env.XDG_DATA_HOME
  const rt = await makeRuntime({ config: { modelLimit: 100 } })
  try {
    await rt.sendEvent(usageEvent(95)) // 95% -> emergency
    const h = prunableHistory()
    const snapshot = JSON.stringify(h)
    await rt.compactSession("lab")
    await rt.messagesTransform(h as unknown as unknown[])
    assert.equal(JSON.stringify(h), snapshot, "история не тронута")
    const file = prunedFileFor(rt.project, "lab")
    assert.equal(fs.existsSync(file), false, "pruned/<sid>.jsonl не создан")
  } finally {
    rt.cleanup()
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
  }
})

test("хук: prune пишет оригиналы в pruned/, а recall_pruned возвращает их и ставит pin", async () => {
  const prevXdg = process.env.XDG_DATA_HOME
  const rt = await makeRuntime({ config: { modelLimit: 100 } })
  try {
    await rt.sendEvent(usageEvent(50))
    const h = prunableHistory()
    await rt.messagesTransform(h as unknown as unknown[])
    assert.equal(wasPruned(h), true, "ход сжат")
    const file = prunedFileFor(rt.project, "lab")
    assert.equal(readPruned(file).filter((r) => r.kind === "original").length, 1, "оригинал записан один раз")

    // recall_pruned возвращает оригинал символ в символ.
    const recalled = await rt.callToolNamed("recall_pruned", { messageID: "a1", partID: "t1" })
    assert.equal(recalled.includes("одинаковый вывод"), true)
    assert.equal(readPruned(file).filter((r) => r.kind === "pin").length, 1, "pin записан")

    // Запиненное сообщение не жмётся больше никогда — даже на emergency.
    await rt.sendEvent(usageEvent(95))
    for (let turn = 1; turn <= 6; turn++) {
      const again = prunableHistory()
      await rt.messagesTransform(again as unknown as unknown[])
      assert.equal(wasPruned(again), false, `ход ${turn}: запинено, не жмём`)
    }
    // Неизвестный messageID — честный ответ, не исключение.
    const miss = await rt.callToolNamed("recall_pruned", { messageID: "нет-такого" })
    assert.match(miss, /не найден/)
  } finally {
    rt.cleanup()
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
  }
})

// ─── ревью: инварианты, которые раньше не были проверены ────────────
test("стор: отказ записи не помечает ключ — следующий ход попробует снова", () => {
  const blocked = path.join(tmpXdg(), "pruned")
  fs.mkdirSync(blocked, { recursive: true })
  const file = path.join(blocked, "ses_ro.jsonl")
  // Каталог вместо файла: append упадёт на любом числе записей.
  fs.mkdirSync(file, { recursive: true })
  const rec = { messageID: "m1", partID: "p1", tool: "bash", content: "вывод" }
  try {
    assert.equal(appendOriginal(file, rec), "failed")
    assert.equal(appendOriginal(file, rec), "failed", "ключ не помечен, повтор не считается дублем")
  } finally {
    forgetPruneCache()
    cleanup([path.dirname(path.dirname(blocked))])
  }
})

test("стор: дубли после рестарта схлопываются по partID (recall не вернёт N копий)", () => {
  const file = path.join(tmpXdg(), "pruned", "ses_dup.jsonl")
  const rec = { messageID: "m1", partID: "p1", tool: "read", content: "вывод" }
  try {
    assert.equal(appendOriginal(file, rec), "stored")
    forgetPruneCache() // рестарт: ключи потеряны
    assert.equal(appendOriginal(file, rec), "stored", "повтор записан (известный потолок)")
    forgetPruneCache()
    assert.equal(findOriginals(file, "m1", "p1").length, 1, "recall отдаёт одну копию")
  } finally {
    forgetPruneCache()
  }
})

test("стор: запись неизвестной формы не ломает чтение (content без строки)", () => {
  const dir = path.join(tmpXdg(), "pruned")
  const file = path.join(dir, "ses_junk.jsonl")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    file,
    JSON.stringify({ kind: "original", messageID: "m1", partID: "p1" }) + "\n" +
      JSON.stringify({ kind: "выдумка", messageID: "m2" }) + "\n" +
      JSON.stringify({ kind: "pin", messageID: "m3" }) + "\n",
    "utf8",
  )
  try {
    forgetPruneCache()
    const rows = readPruned(file)
    assert.equal(rows.length, 1, "остался только валидный pin")
    assert.equal(loadPins(file).has("m3"), true)
    assert.equal(findOriginals(file, "m1").length, 0)
  } finally {
    forgetPruneCache()
  }
})

test("хук: unwritable стор -> prune не применяется (обещание recall не нарушается)", async () => {
  const prevXdg = process.env.XDG_DATA_HOME
  const rt = await makeRuntime({ config: { modelLimit: 100 } })
  try {
    await rt.sendEvent(usageEvent(50))
    // Кладём ДИРЕКТОРИЮ на место pruned/<sid>.jsonl: запись originals невозможна.
    const file = prunedFileFor(rt.project, "lab")
    fs.mkdirSync(file, { recursive: true })
    const h = prunableHistory()
    await rt.messagesTransform(h as unknown as unknown[])
    assert.equal(wasPruned(h), false, "контекст не тронут — оригиналы не сохранились")
    // Следующий ход тоже без prune: уровень/эпоха не зафиксированы.
    const h2 = prunableHistory()
    await rt.messagesTransform(h2 as unknown as unknown[])
    assert.equal(wasPruned(h2), false)
  } finally {
    rt.cleanup()
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
  }
})

test("хук: пустой transform не съедает эпоху — флаг дожидается реального хода", async () => {
  const prevXdg = process.env.XDG_DATA_HOME
  const rt = await makeRuntime({ config: { modelLimit: 100 } })
  try {
    await rt.sendEvent(usageEvent(50))
    await rt.compactSession("lab")
    // Пустой массив: sid из него не вывести (at(-1) === undefined), значит флаг
    // остаётся висеть до первого реального transform на этом sid.
    await rt.messagesTransform([] as unknown[])
    const h = prunableHistory()
    await rt.messagesTransform(h as unknown as unknown[])
    assert.equal(wasPruned(h), false, "ход сразу после компактации не жмётся")
    // Флаг снят, а не залип: следующий ход жмёт сразу.
    const h2 = prunableHistory()
    await rt.messagesTransform(h2 as unknown as unknown[])
    assert.equal(wasPruned(h2), true, "через ход prune уже проходит")
  } finally {
    rt.cleanup()
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
  }
})
