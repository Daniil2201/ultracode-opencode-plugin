---
description: "Сохраняет checkpoint активного плана перед сжатием контекста"
---

Сохранить компактный checkpoint активного плана перед сжатием контекста.

## Usage

```
/checkpoint
```

## Instructions

1. Найди активный план в `ultracode_context` (`plan_show`).
2. Нет плана → верни `No active plan`, ничего не пиши.
3. Собери summary (только это, не всю историю):
   - `PLAN: <id>`;
   - `GOAL: <цель>`;
   - `CURRENT: <текущий in_progress шаг или none>`;
   - `BLOCKERS: <через "; " или none>`.
4. Не дублируй: повторный `/checkpoint` того же плана+шага ничего не добавляет.
5. Не переписывай историю сообщений вручную — только компактный summary в `session.compacting`.
