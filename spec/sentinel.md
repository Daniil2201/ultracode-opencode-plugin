# spec: sentinel

## Цель

Дешёвая проверка качества шага плана **до** фиксации evidence: 5 чеков (syntax/lint,
ghost comments, changelog, task-to-file match, empty step), advisory-отчёт, без spawn
произвольного shell и без записи в стор.

## Интерфейс

### Контракт

```ts
// .opencode/lib/ultracode/sentinel.ts
export type SentinelStatus = "pass" | "warn" | "fail" | "skip"

export interface SentinelCheck {
  id: "empty-step" | "task-to-file" | "syntax" | "ghost-comments" | "changelog"
  status: SentinelStatus
  detail: string            // коротко, без секретов, без содержимого файлов
}

export interface SentinelResult {
  status: SentinelStatus    // худший из чеков; skip не ухудшает
  checks: SentinelCheck[]
  files: string[]           // фактически изменённые (из git status)
  durationMs: number
}

export function sentinelCheck(step: PlanStep, projectDir: string): SentinelResult
```

Вход: текущий шаг плана (`step` — из `schema.ts`, включая `check`,
`acceptance.command`, `files`, `evidence[]`) и корень проекта.
Evidence берётся из `step.evidence.at(-1)` — отдельного параметра нет.
Выход: чистый результат. Побочных эффектов нет: ни одного байта записи.

### Проверки

| id | Что делает | fail | warn | skip |
|---|---|---|---|---|
| `empty-step` | цель/check/acceptance пусты, нет файлов | шаг пустой | — | — |
| `task-to-file` | `git status --porcelain` в `projectDir` | объявленные файлы не изменены ИЛИ изменений нет вовсе | изменён файл вне шага | не git-репо |
| `syntax` | разбор `step.evidence.at(-1)`: `exitCode ≠ 0`, либо сигнатуры в stdout/stderr — `PHP Parse error`, `syntax error, unexpected`, `error TS\d+`, `TS\d{4}:`, `ParseError`, `SyntaxError`, `Expected token`, `unexpected token` | найдена сигнатура или ненулевой exit | evidence есть, exit 0, сигнатур нет | evidence отсутствует |
| `ghost-comments` | скан файлов шала + изменённых: `TODO`, `FIXME`, `HACK`, `XXX`, `// I will finish`; грубая эвристика закомментированного кода (3+ строк подряд `//`/`*` c `;{}` внутри) | TODO/FIXME/HACK/XXX | закомментированный код | нет файлов для скана |
| `changelog` | если среди изменённых есть `CHANGELOG.md`: есть `## [Unreleased]` и категория из Added/Changed/Fixed/Removed/Deprecated | нет секции/категории | CHANGELOG есть, но не тронут при изменённом коде | CHANGELOG.md в проекте нет |

`status` результата = худший из чеков, где `skip` не считается ухудшением.
Детали — до 200 символов, через `redactConfidential` из `./confidential.ts`.

### Затрагиваемые файлы

- `.opencode/lib/ultracode/sentinel.ts` — новый, чистые функции, зависимости только
  `node:fs`, `node:path`, `node:child_process`, импорт `type { PlanStep }` из `./schema.ts`
  и `redactConfidential` из `./confidential.ts`.
- `.opencode/tests/sentinel.test.ts` — новый, стиль `node:test` как у соседних тестов.
- `.opencode/plugin/ultracode.ts` — точка вызова (см. «Интеграция»), +5–8 строк.
- `.opencode/README.md` — строка про новый модуль в карте.

### Интеграция

Вызов в существующей ветке `action === "evidence"` (`plugin/ultracode.ts:1521-1550`),
между `createEvidenceV3` (`:1530`) и `applyEvidenceV3` (`:1537`):

```ts
const sen = sentinelCheck(step, projectPath)   // advisory, ничего не меняет
```

Что делает с результатом: отчёт дописывается в `summary` (рядом с
`summarizeEvidenceV3`, `:1539`) и в текст ответа. При `sen.status === "fail"` в ответ
добавляется строка `SENTINEL FAIL: <id> — <detail>` и подсказка, что evidence принят,
но проверки красные.

Чего sentinel **не** делает: не меняет `exitCode`, не двигает статус шага, не блочирует
применение evidence, не пишет в стор. Evidence-гейт и sentinel независимы: гейт решает
«закрыт ли шаг», sentinel — «похоже, что закрывать не стоит».

## Acceptance

1. `node --test .opencode/tests/sentinel.test.ts` → exit 0.
2. Evidence с `PHP Parse error: syntax error, unexpected token ";"` и `exitCode: 0` →
   `result.status === "fail"`, чек `syntax` = `fail`.
3. Пустой шаг (пустые `check`, `acceptance`, `files`) → `fail` на `empty-step`.
4. Шаг объявляет файлы, `git status --porcelain` пуст → `fail` на `task-to-file`,
   `detail` содержит «ничего не изменено».
5. Изменён файл, которого нет в шаге → `warn` на `task-to-file`, **не** `fail`.
6. Файл шага содержит `TODO:` → `fail` на `ghost-comments`; только закомментированный
   блок → `warn`.
7. `CHANGELOG.md` изменён без `## [Unreleased]` → `fail` на `changelog`; в проекте без
   `CHANGELOG.md` → `skip`, и `skip` не ухудшает общий `status`.
8. Стор не тронут: `context.json` до и после `sentinelCheck` побайтово идентичен.
9. `spawnSync` вызывается только как `spawnSync("git", ["status", "--porcelain"], { shell: false })`
   — тест перехватывает вызов и падает при любом другом argv или при `shell: true`.
10. Бюджет времени: один вызов на этом репозитории < 2000 мс (тест замеряет
    `durationMs` и проверяет порог).
11. Полный прогон не хуже baseline:
    `node --test .opencode/tests/*.test.ts .opencode/tests/runtime/*.test.ts .opencode/tests/adversarial/*.test.ts`
    → `ℹ pass 225`, `ℹ fail 4` (4 падения — `farm/`, вне scope).
12. `bash .opencode/tests/install-smoke.sh` → не хуже 50 OK / 1 MISS.

## Запреты

- **Не spawn'ить произвольный shell.** Только фиксированный `git status --porcelain`
  с `shell: false` и без конкатенации пользовательского ввода (прецедент:
  `plugin/ultracode.ts:230`). Ни `php -l`, ни `tsc --noEmit`, ни `bash -c`.
- **Не писать на диск и в стор.** Ни файлов, ни `context.json`, ни метрик. Только read.
- **Не блокировать.** Ни один статус sentinel не меняет `done`/`failed` и не бросает.
- **Не печатать секреты.** Любой текст в `detail` проходит через `redactConfidential`;
  содержимое файлов в отчёт не попадает (только `путь:строка`).
- **Не трогать `farm/`, `my-manager`, глобальный `~/.config/opencode`.**
- **Не добавлять зависимостей** — только node: stdlib.
- **Не менять существующие подписи** `applyEvidence`, `transitionStep`,
  `validateEvidenceArgs` — их чинка отдельная задача (этап 1 AFD), здесь только
  подключение точки вызова.
- Не заводить `sentinel.json`/`.sentinelrc`: конфигурации нет, чек-лист фиксирован
  и расширяется кодом.
- Не вызывать sentinel из `chat.message`/`system.transform` — только из `evidence` и
  из тестов, иначе он начнёт жечь контекст.
