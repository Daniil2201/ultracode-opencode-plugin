---
description: "Запускает Open Design workflow после подтверждения brief"
---

Явный Open Design workflow. Не запускается только из-за слова «дизайн» — только этой командой и только после подтверждения brief.

## Usage

```
/design <задача>
```

## Instructions

Строгий порядок, без пропусков:

1. `get_active_context` — что открыто у пользователя сейчас. Нет контекста → понятный blocker, `start_run` не вызывается.
2. `collect_brief` — собрать brief из задачи и контекста.
3. Показать brief пользователю текстом.
4. `confirm_brief` — дождаться явного подтверждения. Без него `start_run` запрещён.
5. `start_run` — только после подтверждения.
6. Polling через `get_run` до завершения.
7. Проверка artifact manifest: каждый файл через `safeArtifactPath` (строго внутри project root, иначе отклонить).
8. Запись результата в план (`plan_step` + evidence). Timeout и cancel тоже пишутся в evidence.

Безопасность: файлы вне project root отклоняются; timeout/cancel — это evidence, а не тихий пропуск.
