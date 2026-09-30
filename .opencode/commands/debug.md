---
description: "Ведёт отладку reproduce→fix с профилем aggressive"
---

Системный дебаг: reproduce → isolate → hypothesize → fix → regression → verify. Гений дебага — дисциплина, а не угадывание.

> `ultracode_context action=budget profile=aggressive` — профиль порогов этой сессии (перетирает ручные, приоритет за последним вызовом).

## Usage

```
/debug <симптом>
```

## Instructions

Работай по циклу (скилл `debugging-wizard`, состояние — функции `.opencode/lib/ultracode/debug.ts`):

1. **Reproduce** — добейся стабильного повтора. Зафиксируй симптом и контекст: `createDebugSession(symptom, context)`. Нет повтора — нет дебага, только гипотезы.
2. **Isolate** — сужай до минимального кейса (один файл, один вызов, один шаг). Убирай лишнее, пока баг не останется наедине с тобой.
3. **Hypothesize** — выпиши гипотезы с проверкой каждая: `addHypothesis(session, text, check)`. Проверяй строго по одной: `nextHypothesis` → `recordAttempt(hypothesisId, passed, evidence)`.
4. **Fix** — чини только подтверждённую гипотезу. Один фикс за раз, без «заодно».
5. **Regression** — fix без регресс-теста не принимается: `resolveDebug` требует непустой regressionTest. Тест должен падать на старом коде и проходить на новом.
6. **Verify** — прогони acceptance-команду целиком (`/verify`), обнови `plan_step` с evidence. Не закрывай план словами «вроде работает».

## Rules

- Проваленная гипотеза — это прогресс: фиксируй evidence и бери следующую, не возвращайся к опровергнутой.
- Все гипотезы опровергнуты (`stuck`) — выпиши новые, уже́ круг, а не шире.
- «Стоп» прекращает сессию дебага. Несвязанный найденный баг — отдельным issue, не чинить молча.
- Секреты из логов/ошибок в evidence не попадают (firewall `redactConfidential` режет автоматически).
