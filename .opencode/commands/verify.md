---
description: "Проверяет шаг evidence-gate указанной командой"
---

Проверка шага evidence-gate: закрывает шаг только успешной командой.

## Usage

```
/verify <команда>
```

## Instructions

1. Запусти указанную команду (пример: `node --test`, `node --check <файл>`). Не запускай произвольный shell из плагина автоматически — команду выполняет агент явно.
2. Собери evidence: `command`, `exitCode`, обрезанные `stdout/stderr` (до 4000 символов), секреты вычищены (`api_id`, `api_hash`, `password`, `bot token` → `[redacted]`).
3. Примени к текущему шагу плана:
   - `exitCode 0` → `done`;
   - `exitCode != 0` → `failed` (+1 к `attempts`);
   - без evidence шаг остаётся `verify_required` — `done` без проверки невозможен.
4. Ручная проверка:
   - `/verify node -e "process.exit(0)"` → done;
   - `/verify node -e "process.exit(1)"` → failed.
5. Покажи команду, exit code и обрезанный вывод как доказательство.
