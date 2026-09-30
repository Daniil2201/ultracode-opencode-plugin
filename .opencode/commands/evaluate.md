---
description: "Прогоняет лабораторную оценку Ultracode (UC-020)"
---

Запуск лабораторной оценки Ultracode (UC-020). Только явной командой.

## Usage

```
/evaluate [smoke|all]
```

## Instructions

1. Запусти allowlist-скрипт (никакого произвольного shell):
   - `/evaluate` или `/evaluate smoke` → `scripts/evaluate-ultracode.sh --smoke`;
   - `/evaluate all` → `scripts/evaluate-ultracode.sh --all` (полный acceptance, дольше).
2. Матрица:
   1. compile (`node --check` плагина);
   2. unit (helper-контракты);
   3. runtime contract (настоящий tool path + бинарь);
   4. security/concurrency (adversarial + Rust);
   5. scoring (веса + hard gates);
   6. report (JSON + Markdown, без секретов).
3. Покажи score и уровень: `junior (<60) / middle (60–79) / senior (80–94) / staff (95+)`.
4. Senior требует runtime, security и reproducibility evidence; score ниже 60 или critical blocker = failure (non-zero exit).
5. Скоринг взвешенный, не счёт гейтов: `evaluation/cli.ts` строит критерии
   (correctness 30, tests 20, runtime 15, security 15, reliability 10,
   architecture 5, performance 3, docs 2), вызывает `evaluateProject()`,
   применяет hard/soft caps и только потом вычисляет уровень. Performance меряет
   p95 gate-latency против SLO 120s (3-й балл — измерением, не авансом).
6. Отчёт: `.opencode/eval-last.json` + `.opencode/eval-last.md` — приложи путь и итог.
7. Никогда не печатай секреты из вывода команд.

## Portable-режим (чужой проект, UC-026)

```
/evaluate all --target <path>
```

- Гейты выводятся из `stack-contract` target, а не из lab-матрицы.
- Нет рантайма → `blocked` (не fail). Нет тестов → `no-tests` (N/A, не fail).
- Нет команд → `skipped`. Score — только по применимым гейтам; portable-score
  НЕ сравним с lab 0–100 (другая рубрика) — так и говори.
- Отчёты: `.opencode/eval-portable.json` + `.opencode/eval-portable.md`
  (в своём проекте; target не трогаем). Exit: 0 pass, 1 fail, 2 inconclusive.
