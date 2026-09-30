# spec: skill-router

## Цель

Убрать из каждого сообщения полный список скиллов (`<available_skills>`, сейчас
17 128 токенов на 111 скиллов) и заменить его коротким блоком `<skill_hint>` с 1–3
наиболее релевантными скиллами **плюс** инструмент `triage` для явного поиска.
Нативный `skill` продолжает работать — правило «Skills FIRST» не ломается.

## Интерфейс

```ts
// lib/ultracode/skill-router.ts
export type SkillEntry = { name: string; description: string; source: "local" | "global"; path: string }
export type ScoredSkill = { name: string; score: number; reason: string; source: "local" | "global" }

export function collectSkills(refresh?: boolean): SkillEntry[]
export function scoreSkills(query: string, skills: SkillEntry[], top?: number): ScoredSkill[]
export function renderSkillHint(query: string, top?: number): string
export function skillTriage(query: string, top?: number): string   // текст для tool
export function stripAvailableSkills(system: unknown[]): number      // сколько блоков срезано
```

- `collectSkills` — рекурсивный обход `<projectDir>/.opencode/skills/*/SKILL.md` и
  `~/.config/opencode/skills/*/SKILL.md` (+ `~/.claude/skills`, `~/.agents/skills`),
  парсинг `name:` и `description:` из YAML-фронтматтера. **Кэш на процесс**;
  `refresh: true` перечитывает диск. При отсутствии `name:` во фронтматтере берётся
  имя каталога (так ведёт себя opencode). Ошибка чтения одного файла не роняет остальные.
- `scoreSkills` — детерминированный скоринг, без сети и без API:
  1. `query` → токены: lowercase, пунктуация в пробелы, стоп-слова и токены короче
     3 символов выброшены;
  2. для каждого скилла токены `name` (вес 3) и `description` (вес 1) считаются один раз;
  3. `score = Σ весов` по различным совпавшим токенам, `reason` = список совпавших
     токенов (до 6);
  4. в результат попадают только `score ≥ 1`, сортировка по score, отсечение по `top`.
- `renderSkillHint(query, top = 3)` — `<skill_hint>` с именами, score и reason;
  **пустая строка**, если совпадений нет или запрос пустой (тогда ничего не инжектится).
- `skillTriage(query, top = 10)` — человекочитаемый отчёт для тулзы: таблица
  `name · score · reason · source`; при нуле совпадений — явная строка «no skills matched».
- `stripAvailableSkills(system)` — срез всех вхождений `<available_skills>…</available_skills>`
  в массиве строк, возвращает число срезанных блоков. Идемпотентна.

## Интеграция

В `plugin/ultracode.ts`:

1. **`chat.message`** (уже есть, `:830`) — после существующей логики пишем
   `lastUserQuery.set(sid, text)` из первого не-синтетического text-части. Это единственная
   точка, где реально доступен текст пользователя: в `system.transform` приходит только
   `sessionID` (проверено на живом бинаре 1.18.31 и в БД: `part` = `{text,type}`, роль
   лежит в `message`).
2. **`experimental.chat.system.transform`** (уже есть, `:547`) — в начало, до
   `injectedSessions`-гарда:
   - `stripAvailableSkills(output.system)` — снимает ~17k токенов на каждом сообщении,
     идемпотентно, поэтому не мешает существующей логике `pushSystemOnce`;
   - `pushSystemOnce(system, sid, "skill-hint", renderSkillHint(lastUserQuery.get(sid) ?? ""))`
     — только если строка непустая. Если запрос неизвестен (порядок хуков), блок не
     инжектится вовсе, а модель получает `triage` из списка тулзов.
3. **Новый tool `triage`** в существующем объекте `tool:` — `query: string` (обязательное),
   `top: number` (опциональное, по умолчанию 10); возвращает `skillTriage(query, top)`.
4. Никаких `tool.execute.before` для `skill` — нативный вызов не блокируется.
5. Ошибки скоринга/сбора — `try/catch`: пустой hint, запись в stderr только при
   `OPENCODE_ULTRACODE_DEBUG=1`. Сессия не падает.

## Acceptance

1. `stripAvailableSkills` срезает `<available_skills>` из всех элементов массива;
   повторный вызов возвращает 0 и ничего не портит.
2. `renderSkillHint("напиши php функцию с тестом")` содержит `<skill_hint>` и имя,
   начинающееся на `php`; при `""` — пустая строка; при запросе без совпадений — пустая.
3. `scoreSkills("", skills)` → `[]`; `scoreSkills("typescript react", skills)` → первый
   результат про typescript или react, **не** про php.
4. `skillTriage("несуществующий запрос", skills)` → строка про отсутствие совпадений,
   без исключения.
5. `collectSkills()` на этой машине находит ≥ 100 скиллов; второй вызов дешевле
   первого (кэш); `collectSkills(true)` обновляет.
6. Runtime: `system.transform` с фейковым `output.system`, содержащим
   `<available_skills>` → маркера нет, при непустом `lastUserQuery` появился `<skill_hint>`.
7. Runtime: в плагине **нет** подмены аргументов тулзы `skill` — тест-инвариант по
   исходнику плагина (`tool.execute.before` отсутствует либо не трогает `skill`).
8. Полный прогон: `ℹ fail 0`, `ℹ pass ≥ 251 + N`, `skipped 3`.
9. `bash scripts/sync-ultracode.sh --status` → `diff=0`, `missing_in_dst=0`.
10. Инварианты, проверяемые вручную после включения: глобальный `opencode.json`/`.jsonc`
    не изменён, ни один `SKILL.md` не переименован, скиллов на диске по-прежнему 111.

## Запреты

- **Не переименовывать** `SKILL.md` → `SKILL.md.disabled` (и обратно).
- **Не трогать** глобальный `~/.config/opencode/opencode.json` / `.jsonc`.
- **Не блокировать** нативный `skill`: никаких `tool.execute.before`, подменяющих его аргументы.
- **Без сети**, без новых зависимостей — только node stdlib.
- **Не писать в стор**: кэш скиллов и последний запрос живут в памяти процесса.
- **Не менять** `schema.ts`, `budget.ts`, `handoff.ts`, `tokens.ts`, `store.ts`,
  `injection.ts`, `sentinel.ts`, `verification.ts`, `plan.ts`, `autonomy.ts`.
- Не вызывать `triage` автоматически: это инструмент по решению модели, иначе мы
  возвращаем ту же навязчивость, что и полный список.
- Не трогать `my-manager`.
