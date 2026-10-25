# Changelog

Все значимые изменения Ultracode. Формат: Keep a Changelog, версионирование: SemVer.

## [Unreleased]

### Изменено

- **Наблюдаемость context-pruner'а.** Стор `pruned/<sessionID>.jsonl` писал
  только успехи, поэтому по нему нельзя было понять, почему проход не состоялся:
  на замере 30.09 под `collapse-bash` подходили 65 частей, а в стор попало 0 —
  и ретроспективно это не устанавливалось. Добавлен append-only диагностический
  лог `pruned/<sessionID>.log` (`prune-store.ts`: `prunedLogFor`,
  `appendPrunerLog`) со строками на продуктивный проход, на пустой проход и на
  каждый ранний выход (`skip=epoch`, `skip=same-level`, `skipped … originals
  unwritable`), с троттлингом раз в 50 ходов.
  Не в `console.error`: `opencode.log` на 100% состоит из структурированных строк
  opencode (0 неструктурированных на 47 МБ), поэтому stderr плагина туда не
  попадает.
- **`spec/context-pruner.md`:** обоснование гейта `level !== lastLevel`
  дополнено замером и оставлено в силе; добавлен раздел «Ограничения» и
  поправлен устаревший baseline прогонов (`225/4` → фактические `346/0/3`).

### Не изменено (осознанно)

- **Гейт `level === lastLevel` (`ultracode.ts`) оставлен.** Гипотеза «снять его»
  опровергнута замером: валовая экономия 1 558 889 токенов против цены
  инвалидации кэша 12 359 043 — **чистая −10 800 154 (−5.46%)**. Причина:
  провайдер кеширует по длинному префиксу, а сжатие меняет старые части, поэтому
  каждый проход перечитывает защищённый хвост (медиана 41 320 токенов).
- Фиксы `state.input` у `edit` (0.018%) и `thresholdEmergency` 60→33 (0.022%)
  отложены: сжатие не переживает ход, потолок pruner'а — 0.79% счёта.

### Документация

- **`spec/real-levers.md`** (новый): реальные рычаги после закрытия pruner-трека —
  порог платформенного компакта (59.9%, вне Ultracode), лимиты вывода `read`
  (13.6% на 4 вызова) и `bash` (52.2%), масса `write`/`edit` во входе (19.4%).
- **`spec/pruner-fix.md`** помечен закрытым, каждый фикс получил статус.

## [1.0.0] — 2026-09-30

Первая стабильная версия. Собрана из этапов bootstrap → prompt-audit, проверена на
двух реальных проектах. CI: **349 тестов / 346 pass / 0 fail / 3 skip**
(`install-smoke.sh` — 53 OK / 0 MISS).

### Добавлено

- **Бюджет и пороги:** реальный подсчёт токенов через `js-tiktoken`
  (`cl100k_base`) с fallback-эвристикой, пороги 40/60/75 и три профиля
  (`aggressive` / `balanced` / `conservative`). Конфигурируется без правки
  кода: `ultracode_context action=budget profile=…`.
- **Handoff:** запись и чтение между сессиями; единый стор для TUI и
  `opencode run` (иначе run-режимы писали в разные файлы).
- **Skill-router:** срез `<available_skills>` из system prompt, инжект
  `<skill_hint>` с топ-3 релевантных скиллов. Экономия ~14k токенов на
  сообщение. Алиасы стека (+2) и приоритет стека проекта (`process.cwd()`),
  молчание при запросе длиннее 500 символов.
- **Sentinel:** advisory pre-check перед вердиктом — синтаксис, ghost
  comments, changelog, scope creep.
- **Idle Evaluator (UC-036):** `evaluateGoal` / `enforceGoal` в `plan.ts` —
  план не закрывается, если не достигнута цель. Провал добавляет шаг `gf`
  один раз на план, дальше терминально `blocked`. Evidence-гейт закрывает
  **шаги**, Idle Evaluator закрывает **план**.
- **Evidence-гейт:** `applyEvidence` принимает шаг только из
  `in_progress | verify_required` и сверяет `command` с
  `plan.acceptance.command`; stale evidence прошлой попытки не закрывает шаг.
- **ТЗ-слой:** команды `/tz-init`, `/tz-check`, `/tz-refine`, шаблон
  `templates/tz.md`, скилл `tz-review`.
- **SDD и AFD:** `/spec`, `/bolt`, `/verify`, `/goal`, скилл `afd-method`.
- **Context Pruner (UC-037):** динамическое сжатие истории через
  `experimental.chat.messages.transform`. Пять стратегий (dedupe,
  purge-error, supersede, collapse-bash, truncate) на трёх уровнях;
  эпохи, чтобы не инвалидировать prompt cache; оригиналы в
  `pruned/<sessionID>.jsonl`, возврат через тулу `recall_pruned`.
- **Prompt-audit:** инвентаризация 5 агентов / 13 команд / 44 скиллов,
  D1–D13 закрыты, D14 (дедупликация `AUTONOMY_TAG`) разобран.
- **Guardrails:** блокировка `rm -rf`, `git push`, глобальных установок и
  записей вне проекта.

### Исправлено

- **Firewall больше не портит код:** типы вроде `sessionId: string` не
  превращаются в `sessionId=[redacted]`. Fail-closed на секретных ключах;
  точка с запятой снята как синтаксис, а не часть значения. 0 утечек на
  фаззере 1000 секретов × 60 форм.
- **Двойной sources of truth для правил:** `AUTONOMY_TAG` инжектится из
  кода, а не дублируется в теле агента.
- **Резолв `projectPath` унифицирован** для TUI и `opencode run`.
- `root-3t1w` больше не используется как fallback-стор (остался только
  комментарий в `store.ts`).

### Известные ограничения

- **Flaky-тесты:** ~1 прогон из 3 падает на разных тестах в
  `tests/runtime/` — гонка за общий `XDG_DATA_HOME` в `fixtures.ts`
  при параллельном запуске. В изоляции `runtime/*.test.ts` стабильны.
- `PRUNE_EPOCH_TURNS = 5` не измерен на живой сессии.
- `metadata.trivial` в плане не переживает `migratePlan`.

[1.0.0]: https://example.invalid/ultracode/releases/v1.0.0
