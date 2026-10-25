---
description: "Выполняет короткий болт: до 3 шагов с acceptance, нужен spec-файл"
---

Короткий «болт» AI-DLC: 1–3 шага, каждый с acceptance-гейтом. Больше — это `/goal`.

> `ultracode_context action=budget profile=aggressive` — профиль порогов этой сессии (перетирает ручные, приоритет за последним вызовом).

## Usage

```
/bolt <slug>
```

## Instructions

1. Проверь `spec/<slug>.md`. Нет файла — стоп, попроси сначала `/spec`. Болт без spec не начинается.
2. Создай план через `ultracode_context action=plan_new`, максимум **3 шага**.
3. Каждый шаг обязан иметь `acceptance.command` — shell-команда с детерминированным exit code (0 = pass, 1 = fail). «Проверка строки/паттерна» должна быть упакована в команду (например, `grep -q 'pattern' file.txt`). Шаг без acceptance.command не принимается. File/line verifier исключён.
4. После каждого шага — `action=plan_step` + `action=evidence` с фактическим результатом.
5. Acceptance не прошёл — не переходи дальше, максимум **одна** итерация повтора (жёстче обычных 3 попыток в `/goal`, где `MAX_ATTEMPTS=3`). Вторая неудача — стоп, доклад пользователю.
6. В конце — `action=plan_step step=done` и знание `action=add kind=decision text="bolt <slug> завершён"`.
