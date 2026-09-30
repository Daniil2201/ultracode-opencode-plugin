// Фаза 1 (R.0.1): session.idle — пульс без роста knowledge и без git-коммитов.
// Стиль: настоящий инстанс плагина + изолированный XDG (как fixtures.ts).
import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { storeFileFor } from "../../lib/ultracode/store.ts"

async function bootIsolated() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-idle-"))
  const project = path.join(dir, "proj")
  fs.mkdirSync(project, { recursive: true })
  process.env.XDG_DATA_HOME = path.join(dir, "xdg")
  const mod = await import(`../../plugin/ultracode.ts?idle=${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`)
  const hooks = await mod.default({ worktree: project, project: { id: project } })
  return {
    dir, project, hooks,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } },
  }
}

test("5 idles подряд: knowledge не растёт, коммитов нет, пульс в history", async () => {
  const rt = await bootIsolated()
  try {
    for (let i = 0; i < 5; i++) {
      await rt.hooks.event({ event: { type: "session.idle", properties: { sessionID: `idle-sid-${i}` } } })
    }
    const file = storeFileFor(rt.project)
    const store = JSON.parse(fs.readFileSync(file, "utf8"))
    assert.equal(store.knowledge.length, 0, "knowledge вырос на idle (мусорный fact вернулся?)")
    assert.equal(store.tokens.external.history.length, 5, "пульсы не записаны в history")
    assert.ok(
      !fs.existsSync(path.join(path.dirname(file), ".git")),
      "idle создал git-репо/коммит (пульс обязан быть без коммита)",
    )
  } finally {
    rt.cleanup()
  }
})
