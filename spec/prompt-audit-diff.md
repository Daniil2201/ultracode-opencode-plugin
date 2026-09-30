# Prompt-audit: предложенный diff

**НЕ ПРИМЕНЕНО.** Ни одна правка из этого файла не применена. Ниже — предложение
для ревью. Каждый блок самодостаточен: применять можно по одному.

Правки кода (`plugin/ultracode.ts`) в этот файл НЕ включены намеренно — по условиям
задачи код не трогаем. Решение по `SKILLS_TAG` вынесено в конец.

---

## D1. Критично: `agents/ultracode.md:159` — поиск скилла в срезанном блоке

Блок `available_skills` срезается безусловно (`plugin/ultracode.ts:566`), поэтому
«найди в `available_skills`» указывает в пустоту. Противоречит строке 16 того же файла.

```diff
--- a/.opencode/agents/ultracode.md
+++ b/.opencode/agents/ultracode.md
@@ -159 @@
-- **Skills — см. раздел «Skills FIRST» выше.** Обязательный шаг 0 каждой задачи: найди подходящий скилл в `available_skills`, загрузи через `skill("имя")`, следуй его воркфлоу. Никакой код без загруженного скилла.
+- **Skills — см. раздел «Skills FIRST» выше.** Обязательный шаг 0 каждой задачи: возьми кандидатов из `<skill_hint>` (если его нет или он пуст — вызови `triage({ query: "<задача 3-10 слов>" })`), затем загрузи через `skill("имя")` и следуй воркфлоу. Никакой код без загруженного скилла.
```

## D2. Критично: `audit/SKILL.md:110` — `skill()` на несуществующие скиллы

`code-enforce-route-data` и `code-enforce-layers` не существуют ни локально, ни
глобально. В отличие от соседних пунктов, здесь нет оговорки «если скилл доступен».

```diff
--- a/.opencode/skills/audit/SKILL.md
+++ b/.opencode/skills/audit/SKILL.md
@@ -110 @@
-- TanStack Start present → `skill({ name: "code-enforce-route-data" })`, `skill({ name: "code-enforce-layers" })`
+- TanStack Start present → аудит границ маршрутов и слоёв делай через сабагенты `runtime-contract-tracer` и `reviewer-contracts` (соответствующие `skill({name})` в этом репозитории не поставляются)
```

## D3. Критично: `start/SKILL.md:159` — потеря плана без фолбэка

`agentmemory_memory_save` — единственная точка сохранения, MCP `agentmemory`
в `opencode.json` не сконфигурирован. `continue/SKILL.md:36` деградирует мягко,
здесь — нет. Агент сообщает «план сохранён» и идёт дальше без него.

```diff
--- a/.opencode/skills/start/SKILL.md
+++ b/.opencode/skills/start/SKILL.md
@@ -159 @@
-- Save the plan to agentmemory via `agentmemory_memory_save` with type="plan"
+- Save the plan via `ultracode_context action=plan_new` (канал, который гарантированно доступен). Если `agentmemory` подключён — дополнительно продублируй в него; при ошибке молча пропусти, фолбэк не блокирует.
```

Тот же фолбэк в `continue/SKILL.md:14,35,42,192,193` — там он уже есть, правка не нужна.

## D4. Критично: `agents/ultracode.md:103` — ссылка на несуществующий модуль

`lib/ultracode/evidence.ts` не существует; гейт живёт в `plan.ts:68-71`.

```diff
--- a/.opencode/agents/ultracode.md
+++ b/.opencode/agents/ultracode.md
@@ -103 @@
-- **Evidence-gate**: `done` только с успешным evidence (`/verify`, exit 0, вывод обрезан и без секретов). Без evidence шаг — `verify_required`. Плагин произвольный shell сам не запускает.
+- **Evidence-gate**: `done` только с успешным evidence (`/verify`, exit 0, вывод обрезан и без секретов). Без evidence шаг — `verify_required`. Плагин произвольный shell сам не запускает. Реализация: `.opencode/lib/ultracode/plan.ts`.
```

---

## D5. `audit-authz` / `audit-perf` как «ручные точки входа» (4 файла)

Живой путь — одноимённые сабагенты. Скиллов нет.

```diff
--- a/.opencode/skills/add-feature/SKILL.md
+++ b/.opencode/skills/add-feature/SKILL.md
@@ -212 @@
-- ... The `skill({ name: "audit-authz" })` skill remains available as a manual entry point.
+- ... Аудит прав доступа — через сабагент `reviewer-authz`.
@@ -219 @@
-- ... The `skill({ name: "audit-perf" })` skill remains available as a manual entry point.
+- ... Аудит производительности — через сабагент `reviewer-perf`.
```
```diff
--- a/.opencode/skills/modify-feature/SKILL.md
--- b/.opencode/skills/modify-feature/SKILL.md
@@ -86 @@
- (то же: audit-authz → reviewer-authz)
```
```diff
--- a/.opencode/skills/audit/SKILL.md
+++ b/.opencode/skills/audit/SKILL.md
@@ -101,120 @@
- (то же: audit-perf → reviewer-perf)
```

## D6. `/ship` → `/start` (3 файла)

```diff
--- a/.opencode/skills/add-feature/SKILL.md
+++ b/.opencode/skills/add-feature/SKILL.md
@@ -50 @@
-- The `/ship` orchestrator enforces this upstream, but direct manual callers may not
+- The `/start` orchestrator enforces this upstream, but direct manual callers may not
```
```diff
--- a/.opencode/skills/modify-feature/SKILL.md
+++ b/.opencode/skills/modify-feature/SKILL.md
@@ -41 @@
- (то же: /ship → /start)
```
```diff
--- a/.opencode/skills/commit-and-push/SKILL.md
+++ b/.opencode/skills/commit-and-push/SKILL.md
@@ -3 @@
-- (use `/ship` for plan → implement → test → review)
+- (use `/start` for plan → implement → test → review)
```

## D7. «Build mode» → `balanced` (2 строки)

```diff
--- a/.opencode/skills/start/SKILL.md
+++ b/.opencode/skills/start/SKILL.md
@@ -99 @@
-- The plan is saved to agentmemory for later `/continue` in Build mode
+- The plan is saved via `ultracode_context action=plan_new` for later `/continue` in `balanced` mode
@@ -198 @@
-- Plan saved to agentmemory. Switch to Build mode and run /continue to execute.
+- Plan saved. Run /continue to execute (mode: balanced).
```

## D8. Пути `farm/` в скиллах → контекст-стор

```diff
--- a/.opencode/skills/browser-autopilot/SKILL.md
+++ b/.opencode/skills/browser-autopilot/SKILL.md
@@ -74 @@
-- одна строка в журнал (farm/knowledge/state.md) и/или context store
+- одна строка в контекст-стор: `ultracode_context action=add kind=progress`
```
```diff
--- a/.opencode/skills/quality-gate/SKILL.md
+++ b/.opencode/skills/quality-gate/SKILL.md
@@ -7 @@
- source: "Built for my-manager farm; pairs with farm/skills/quality-checker + quality-check.md"
+ source: "Built for my-manager farm; в этом репозитории проверка текста — через tg-manager MCP quality_check"
```

## D9. `ultracode-help.md` — 3 недокументированные команды + пометка про глобальные

```diff
--- a/.opencode/commands/ultracode-help.md
+++ b/.opencode/commands/ultracode-help.md
@@ -26,6 +26,9 @@
 - `/ultracode-help` — эта справка.
+
+**ТЗ (SDD):**
+
+- `/tz-init` — создать `TZ.md` из шаблона `templates/tz.md`.
+- `/tz-check` — проверить существующее ТЗ по критериям скилла `tz-review`.
+- `/tz-refine` — уточнить ТЗ после проверки.
@@ -30,4 +33,4 @@
-- `/farm` — состояние фермы, `/farm-connect` — подключение к контексту, `/farm-update` — обновление установки.
-- `/generate` — пост в стиле донора без публикации; `/check` — quality gate текста.
-- `/publish` — публикация готового поста; `/fetch` — история канала; `/learn` — изучение стиля канала.
+- Глобальные (в `~/.config/opencode/commands/`, доступны вне этого проекта): `/farm` — состояние фермы, `/farm-connect` — подключение к контексту, `/farm-update` — обновление установки.
+- `/generate` — пост в стиле донора без публикации; `/check` — quality gate текста.
+- `/publish` — публикация готового поста; `/fetch` — история канала; `/learn` — изучение стиля канала.
@@ -34 @@
-**Память (agentmemory MCP + контекст-стор):**
+**Память (контекст-стор `ultracode_context`):**
@@ -40 @@
-- ... Используется командами выше, не вызывается вручную из чата.
+- ... Вызывается агентом напрямую (persist решений, планы, evidence, уроки) и командами выше.
```

## D10. Frontmatter для 2 скиллов (измеримый эффект на роутер)

Сейчас `desc=""` → `browser-autopilot` не находится вообще.

```diff
--- a/.opencode/skills/spec-first/SKILL.md
+++ b/.opencode/skills/spec-first/SKILL.md
@@ -1,3 +1,6 @@
+---
+name: spec-first
+description: "Пишет спецификацию фичи до кода: acceptance-критерии, open questions, границы scope. Использовать перед реализацией новой фичи или при /spec."
+---
+
 # Spec-first …
```
```diff
--- a/.opencode/skills/browser-autopilot/SKILL.md
+++ b/.opencode/skills/browser-autopilot/SKILL.md
@@ -1,3 +1,6 @@
+---
+name: browser-autopilot
+description: "Автопилот браузера: повторяемые UI-действия через browser-mcp, анти-бот паузы, ретраи. Использовать для E2E-прогонов и веб-автоматизации."
+---
+
 # Browser-autopilot …
```

## D11. README — относительные пути к скриптам my-manager

```diff
--- a/.opencode/README.md
+++ b/.opencode/README.md
@@ -202 @@
-./scripts/farm-health.sh && ./scripts/install-farm.sh --status   # только из my-manager
+../my-manager/scripts/farm-health.sh && ../my-manager/scripts/install-farm.sh --status   # скрипты фермы живут в my-manager, не здесь
```

## D12. `bolt.md` — прояснить расхождение по попыткам

Код даёт `MAX_ATTEMPTS=3`, `/bolt` велит одну итерацию. Не баг, но читается как
противоречие, а `MAX_ATTEMPTS` не знает про режим `/bolt`.

```diff
--- a/.opencode/commands/bolt.md
+++ b/.opencode/commands/bolt.md
@@ -15 @@
-5. Acceptance не прошёл — не переходи дальше, максимум **одна** итерация повтора. Вторая неудача — стоп, доклад пользователю.
+5. Acceptance не прошёл — не переходи дальше: максимум **одна** итерация повтора (жёстче обычных 3 попыток в `/goal`). Вторая неудача — стоп, доклад пользователю.
```

## D13. `healthcheck/SKILL.md:216` — португальская ремарка

Не трогать содержание, только язык (единственное неанглийское правило в файле).
**Не проверено**, соответствует ли снятое поведение текущему `codegraph_status` —
правку применять только после проверки.

```diff
--- a/.opencode/skills/healthcheck/SKILL.md
+++ b/.opencode/skills/healthcheck/SKILL.md
@@ -216 @@
-- **Codegraph index check não é mais realizada.** A skill verifica apenas a versão do binário…
+- **Проверка индекса Codegraph больше не выполняется.** Скилл проверяет только версию бинаря…
```

---

## D14. Дубль autonomy (самый дорогой, ~75 строк)

`AUTONOMY_TAG` (`autonomy.ts:13-32`) приходит в system prompt каждой сессии
(`plugin:585`), и `agents/ultracode.md:23-97` повторяет его почти слово в слово.
Предлагаю **не удалять раздел целиком**, а свести к ссылке — в агентах секция
читается как «договорённость», и полная замена на указатель ухудшит читаемость.
Объём: 75 → ~10 строк.

```diff
--- a/.opencode/agents/ultracode.md
+++ b/.opencode/agents/ultracode.md
@@ -23,97 +23,13 @@
 ## Autonomy Boundaries — самостоятельность внутри цели
 
- (существующие подразделы: «Автономный execution protocol», «Scope lock»,
-  «План по умолчанию», «Старт нового проекта», «Открытые вопросы ТЗ»,
-  «Уточняющие вопросы», «Подтверждение нужно только перед»,
-  «Источники и факты», «Stop rule и финальный отчёт»)
+Границы автономности, scope lock, правила вопросов/подтверждений, работа с ТЗ
+и финальный отчёт приходят в system prompt тегом `<ultracode-autonomy>` —
+следуй им как обязательным. Здесь только то, чего в теге нет:
+
+- **План по умолчанию:** новая фича/модуль, >1 файл или неоднозначность →
+  `ultracode_context action=plan_new` (2–4 шага, у каждого acceptance), дальше
+  `plan_step` + `evidence`. Опечатка или правка в строку — без ceremony.
+  Разделитель `|` в шагах не использовать: план сложится в один шаг.
+- **Формат шага плана:** каждый шаг с новой строки (или JSON-массив).
+- **Старт проекта:** нет `TZ.md` в пустой папке — предложи `/tz-init`;
+  есть — читай «Этапы (AFD)» и планируй tools → API → UI (`afd-method`).
+- **Открытые вопросы ТЗ:** ответил из кода → `action=add kind=decision` с
+  обоснованием; не ответил → вопрос пользователю. Молчаливый default запрещён.
+- **Подтверждение:** только необратимое/внешнее. Деструктивные команды
+  (`git checkout --`, `git reset --hard`, `rm -rf`) — без явного «да»;
+  точечный `edit` вместо отката.
```

**Риск D14, честно:** это самая рискованная правка в списке. Правило, которое
перестаёт быть видно в теле агента, может выпасть из поведения. Если применять —
только с повторным прогоном CI и одним живым прогоном на простой задаче.
Моя рекомендация: **не применять в этом цикле**, сначала D1–D13.

---

## Заодно: поломка в коде (не входит в этот diff)

`plugin/ultracode.ts:405` — `SKILLS_TAG` велит «В блоке available_skills (выше)
найди скиллы», а тремя строками ниже `plugin:566` этот блок срезается. Инжект
идёт в каждый промпт, поэтому модель получает инструкцию искать то, чего нет.
Код по условиям задачи не трогаю. Если чинить — одна строка:

```diff
--- a/.opencode/plugin/ultracode.ts
+++ b/.opencode/plugin/ultracode.ts
@@ -405 @@
-1. В блоке available_skills (выше) найди скиллы под задачу по описанию/стеку/триггерным словам.
+1. В `<skill_hint>` (или через `triage({ query })`, если его нет) найди скиллы под задачу.
```

## Порядок применения (предложение)

1. **D1, D2, D3, D4** — критичное, 4 независимых правки, каждая снимает реальный
   сбой. Применить все, прогнать CI + один живой прогон.
2. **D5–D9** — желательное, механические, объём мал.
3. **D10** — добавить frontmatter, затем замерить роутер: `browser-autopilot`
   должен начать находиться. Проверка: `bash scripts/skill-router-bench.sh --json`.
4. **D11–D13** — косметика, по желанию.
5. **D14** — отдельным решением, с регрессионным прогоном.
