# Prompt-audit Ultracode

Дата аудита: 2026-09-30. Режим: read-only, правки НЕ применялись.
CI на момент аудита: 297 tests / 294 pass / 0 fail / 3 skip.

## Метод и его границы

Проверено: 5 агентов, 13 команд, 44 `SKILL.md`, `templates/tz.md`, `README.md`.
Каждая находка подтверждена фактом (существование файла, `ls`, точная цитата,
измерение через рабочий код). Где проверить нельзя — помечено «не проверено».

**mtime бесполезен как признак возраста.** Все `agents/`, `commands/`, `templates/`
имеют mtime `09-30 05:31`, все `skills/` — `09-30 06:42`: это следы массовой выгрузки,
а не история правок. Возраст определён по содержанию.

**Признак возраста, который работает:** prompt surface знает только UC-020, UC-026,
UC-032, тогда как код и спеки дошли до UC-035. Отсюда три пропуска (Sentinel,
skill-router, firewall) — см. «Документация отстаёт от кода».

## Две поправки к вводным (проверены, субагент был прав)

1. **Скиллов 44, не 63.** Число 63 — это все `.md` в `skills/`, включая 19 файлов
   в `references/`. Аудит покрывает 44 `SKILL.md`; references не содержат
   инструкций агента.
2. **«10 несуществующих команд» — ложная находка.** Первичная проверка искала
   в `~/.config/opencode/command/`, а каталог называется `commands/`. Все 10
   (`/farm`, `/farm-update`, `/generate`, `/check`, `/publish`, `/fetch`, `/learn`,
   `/recall`, `/remember`, `/farm-connect`) существуют как глобальные команды и
   загружаются opencode. В отчёте эта находка снята.

Это ровно тот класс ошибок, который ловит prompt-audit: поверхностная проверка
дала уверенный, но неверный вывод.

## Инвентаризация

| Файл | Назначение | Строк | Статус |
|---|---|---|---|
| `agents/ultracode.md` | Главный оркестратор, 238 строк правил | 161 | Есть находки, в т.ч. критичные |
| `agents/ultracode-planner.md` | Сабагент плана, read-only | 21 | Чист |
| `agents/ultracode-executor.md` | Сабагент шага + evidence | 22 | Чист |
| `agents/ultracode-reviewer.md` | Сабагент ревью, read-only | 16 | Чист |
| `agents/ultracode-designer.md` | Сабагент Open Design | 18 | Чист |
| `commands/*.md` (13) | Workflow-команды | 366 | 3 недокументированы, 1 битая ссылка |
| `skills/*/SKILL.md` (44) | Библиотека скиллов | ~6 500 | 4 битых `skill()`, 2 без frontmatter |
| `templates/tz.md` | Шаблон ТЗ | 77 | Чист |
| `README.md` | Документация проекта | 228 | 2 битых пути |

Спец-агенты (77 строк на 4 файла) — образец: ни дублей, ни устаревших ссылок.

## Устаревшее

### Под старые модели

| Файл:строка | Что | Почему устарело | Действие |
|---|---|---|---|
| — | — | Проверено: `дважды\|трижды\|перепроверь\|убедись\|не забудь\|важно:\|никогда не забывай\|будь вежлив\|извинись` + англ. эквиваленты по всем 44 SKILL.md → 2 попадания, оба в `browser-autopilot:52,79` и означают «не долби ретраями», т.е. обратное over-verification. По агентам и командам — 0 совпадений. | Не трогать |

Over-verification в prompt surface отсутствует. Этот пункт закрыт без правок.

### Под решённые задачи

| Файл:строка | Что | Что вместо | Действие |
|---|---|---|---|
| `agents/ultracode.md:159` | «найди подходящий скилл в `available_skills`» | Блок **срезается всегда**: `plugin/ultracode.ts:566` вызывает `stripAvailableSkillsV3` безусловно, приходит `<skill_hint>` с топ-3 | **Критично.** Заменить на «в `<skill_hint>` / через `triage`» |
| `plugin/ultracode.ts:405` | `SKILLS_TAG`: «В блоке available_skills (выше) найди скиллы» | Тот же срез | **Критично, но это код** — по условиям задачи не трогаем, вынесено в «заодно» |
| `agents/ultracode.md:104` | Ссылка на «evidence-гейт `plan.ts:70`» | Жива, но строка сместилась: гейт на `plan.ts:68-71` | Косметика: ссылка рабочая |
| `start/SKILL.md:99,198` | «Build mode», «переключиться в Build mode» | `continue/SKILL.md:108-112` знает только `fast/balanced/production` | Заменить на `balanced` |
| `add-feature/SKILL.md:50`, `modify-feature/SKILL.md:41`, `commit-and-push/SKILL.md:3` | Отсылка к `/ship` как к оркестратору, который «enforces mode=fast upstream» | `/ship` не существует ни в проекте, ни в глобальных командах. Замена — `/start` | Переименовать `/ship` → `/start` |
| `add-feature/SKILL.md:212,219`, `modify-feature/SKILL.md:86`, `audit/SKILL.md:101,120` | `audit-authz`, `audit-perf` как «ручные точки входа» | Скиллов нет ни локально, ни глобально; живой путь — одноимённые сабагенты | Убрать предложение, оставить сабагент |
| `browser-autopilot/SKILL.md:74`, `quality-gate/SKILL.md:7` | `farm/knowledge/state.md`, `farm/skills/quality-checker` | Каталога `farm/` в проекте нет — это пути my-manager | Заменить на `ultracode_context` |

### Команды

| Команда | Проблема | Действие |
|---|---|---|
| `/tz-check`, `/tz-init`, `/tz-refine` | Есть на ФС, не упомянуты в `ultracode-help.md` | Дописать в help |
| `/farm`, `/farm-update`, `/generate`, `/check`, `/publish`, `/fetch`, `/learn`, `/recall`, `/remember` | В help указаны как локальные, живут в `~/.config/opencode/commands/` | Пометить в help как глобальные, иначе при выходе из проекта они исчезнут |
| `ultracode-help.md:34` | Заголовок «Память (agentmemory MCP + контекст-стор)» | `agentmemory` в `mcp` не сконфигурирован (в `opencode.json` только `tg-manager`, `open-design`, `browser-mcp`) → заменить на «контекст-стор» |

## Дубли

| Тема | Первоисточник | Копии | Действие |
|---|---|---|---|
| Autonomy boundaries | `lib/ultracode/autonomy.ts:13-32` — **инжектится в system prompt** (`plugin:585`) | `agents/ultracode.md:23-97` — ~75 строк с тем же содержанием | Модель видит оба текста. Свести к ссылке |
| Skills FIRST | `plugin/ultracode.ts:403-411` — **инжектится всегда** (`plugin:582`) | `agents/ultracode.md:14-21` + `agents/ultracode.md:109` («см. выше») | Тройное дублирование в одной сессии |
| Профили и пороги | `lib/ultracode/budget.ts:53-55` (значения) | `agents/ultracode.md:111` + по цитате в `spec.md:8`, `bolt.md:8`, `goal.md:8` | Значения совпадают, дубль без вреда |
| Dependency discipline | `agents/ultracode.md:145-150` | `ultracode-executor.md:16` (одна строка), `goal.md` («см. Dependency discipline агента» — ссылка рабочая) | Нормально, это абстракция |
| Evidence-gate | `agents/ultracode.md:103,126-130` | Ни в одном из 44 SKILL.md не дублируется | Нормально: enforce в `plan.ts`, правилу в скиллах не место |

Из 9 проверенных правил реальный дубль один — **autonomy**, и он самый дорогой:
`AUTONOMY_TAG` приходит в каждый промпт, и агент повторяет его почти слово в слово.
Остальное либо ссылается на первоисточник, либо enforce'ится кодом.

## Противоречия

| Тема | Файл A | Файл B | Как снять |
|---|---|---|---|
| Где искать скилл | `agents/ultracode.md:16` — UC-032, «полного списка больше нет, приходит `<skill_hint>`» | `agents/ultracode.md:159` — «найди в `available_skills`» | Удалить 159 |
| Где искать скилл | `agents/ultracode.md:16,109,159` | `plugin/ultracode.ts:405` (`SKILLS_TAG`) — «в блоке available_skills (выше)» | Код, не трогаем: вынесено в «заодно» |
| Попытки на шаг | `agents/ultracode.md:136`, `goal.md` — «до 3 попыток» | `bolt.md:15` — «максимум **одна** итерация повтора» | Не баг: `/bolt` намеренно жёстче. Но `MAX_ATTEMPTS=3` в коде не знает про режим `/bolt` — стоит уточнить в тексте, иначе выглядит как баг |
| Контекст-стор как «под капотом» | `ultracode-help.md:40` — «не вызывается вручную из чата» | `agents/ultracode.md:161` — «Use `ultracode_context` to persist knowledge» | Help неправ: инструмент вызывается агентом постоянно |

Проверено и **чисто**: «3 вопроса» (только в агенте), «scope не расширять» (совпадает
во всех 7 скиллах), «stop and ask» (совпадает), «подтверждение только перед»
(совпадает), «open questions ТЗ» — конфликт, который ты правил ранее, действительно
снят: `agents/ultracode.md:72-77` явно выводит безопасные неоднозначности из-под
«молча запрещено».

## Битые ссылки

| Ссылка | Откуда | Куда | Статус |
|---|---|---|---|
| `skill({ name: "code-enforce-route-data" })` | `audit/SKILL.md:110` | — | **Битая.** Скилла нет. Инструкция без оговорки: упадёт на любом TanStack Start |
| `skill({ name: "code-enforce-layers" })` | `audit/SKILL.md:110` | — | **Битая** |
| `agentmemory_memory_recall/_sessions/_save` | `continue/SKILL.md:14,35,42,192,193`; `start/SKILL.md:159` | MCP `agentmemory` | **Битая:** в `mcp` только 3 сервера. `continue:36` деградирует мягко; `start:159` — **жёсткая точка без фолбэка, теряет план** |
| `lib/ultracode/evidence.ts` | `agents/ultracode.md:103` (косвенно, «evidence-гейт») | — | **Битая ссылка на несуществующий модуль.** Гейт живёт в `plan.ts` |
| `./scripts/farm-health.sh` | `README.md:202`, `commands/status.md:18` | `~/Desktop/Project/my-manager/scripts/` | Путь относительный: из корня Ultracode не выполнится. Уточнение «только из my-manager» есть, но не мешает промаху |
| `./scripts/install-farm.sh` | `README.md:202` | там же | То же |
| `farm/knowledge/state.md` | `browser-autopilot/SKILL.md:74` | my-manager | Битая в этом репозитории |
| «Build mode» | `start/SKILL.md:99,198` | — | Не существует |
| `/ship` | `add-feature:50`, `modify-feature:41`, `commit-and-push:3` | — | Команды нет |
| `audit-authz`, `audit-perf` | 5 мест | — | Скиллов нет (сабагенты есть) |
| `lib/ultracode/*.ts` из SKILL.md | — | 29 файлов | Чисто: 0 ссылок |
| `reviewer-*` (11), `runtime-contract-tracer`, `crud-surface-mapper`, `ui-pattern-inspector`, `utility-finder` | 30+ мест | `~/.config/opencode/agents/` | Чисто: все живы, глобальные агенты доступны |

## Документация отстаёт от кода (обратная проблема)

Не устаревшее, а отсутствующее — по твоему же критерию «правило описывает фичу,
которая в коде не существует», только наоборот:

| Закрытая фича | Где в коде | Упомянута в prompt surface |
|---|---|---|
| Sentinel | `spec/sentinel.md`, `lib/ultracode/sentinel.ts` | 0 упоминаний |
| skill-router (алиасы, стек проекта) | `lib/ultracode/skill-router.ts` | Только UC-032 про срез списка |
| Firewall (fail-closed, фаззер) | `lib/ultracode/confidential.ts` | 0 упоминаний в агенте |
| autonomy cleanup UC-031 | `lib/ultracode/autonomy.ts:1-12` | Комментарий в коде, в агенте — нет |

## Измеримое последствие: 2 скилла без frontmatter

`spec-first/SKILL.md` и `browser-autopilot/SKILL.md` начинаются с `#`, а не с `---`.
`parseSkill` (`skill-router.ts:110-124`) читает `name`/`description` из frontmatter
и откатывается на имя каталога с **пустым описанием**. Измерено на рабочем коде:

```
spec-first        desc=""                          ← пусто
browser-autopilot desc=""                          ← пусто
tz-review         desc="Критерии хорошего продуктового ТЗ…"  ← для сравнения
score "автопилот браузера" → (пусто)   ни один скилл не найден
score "напиши spec для фичи" → spec-first=3  spec-miner=3
```

То есть `browser-autopilot` не находится роутером вообще, а `spec-first` —
ядро SDD-шага, на который ссылается `agents/ultracode.md:110`, — конкурирует
без описания. Единственные 2 из 44 скилла без frontmatter.

## Сводка

Всего правок: **21** (удалить 4, изменить 15, добавить 2).

**Критичное — ломает работу (4):**
1. `agents/ultracode.md:159` — скилл ищется в срезанном блоке.
2. `audit/SKILL.md:110` — `skill()` на два несуществующих скилла, без оговорки.
3. `start/SKILL.md:159` — `agentmemory_memory_save` как единственная точка сохранения плана, без фолбэка; MCP не сконфигурирован.
4. `agents/ultracode.md:103` — ссылка на несуществующий `lib/ultracode/evidence.ts`.

**Желательное — шум (11):** 4× `audit-authz`/`audit-perf`, 3× `/ship`,
`Build mode` ×2, 2× пути `farm/`, 3 недокументированные команды,
`agentmemory` в заголовке help, `/bolt` vs «3 попытки».

**Косметика (6):** 2 скилла без frontmatter (но см. выше — это измеримый эффект,
поэтому вынес в отдельную секцию, а не в косметику), `evidence.ts:70` в ссылке,
`README.md:202` относительные пути, `ultracode-help.md:40` «не вызывается вручную»,
`healthcheck/SKILL.md:216` правило на португальском, `skill_hint` в CLI-логе не виден.

**Заодно (код — по условиям задачи не трогаю, но это поломка):**
`plugin/ultracode.ts:405` велит искать скиллы в блоке, который тремя строками ниже
срезается. Инжект в каждый промпт, вреднее, чем дубль в агенте.

## Не проверено

- Полнота enforcement evidence-gate в `lib/ultracode/verification.ts` — читал
  только `plan.ts`.
- Соответствует ли текущему тулингу снятое поведение в `healthcheck/SKILL.md:216`
  (португальская ремарка про `codegraph_status`).
- Мёртв ли по факту `AUTONOMY_TAG` для не-`ultracode` агентов: инжект идёт
  в `chat.system.transform` для всех сессий, но сверял только ветку агента.
