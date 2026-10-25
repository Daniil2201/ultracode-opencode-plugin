# Spec: встроенная верификация отчетов в Ultracode (V2)

## Статус и границы
- Статус: draft, только спецификация; код не менялся.
- Scope: Ultracode plugin в репозитории `Ultracode`, OpenCode v2.0.32, V2 Plugin API.
- Цель: сделать так, чтобы отчет агента проходил через слой верификации перед выдачей.
- Не цель: менять внешние скиллы и промты, добавлять новые зависимости, реализовывать UI.

## Мотивация
Сейчас отчет агента принимается на веру. Нет проверки, что утверждения в отчете ("тесты прошли", "изменен только файл X") соответствуют реальным артефактам (git diff, выводы команд, логи, состояние файлов). Это позволяет агенту "сдавать" непроверенные результаты.

## Архитектура

### 1. Точка перехвата
- Новый tool `ultracode_verify_report` или action `verify_report` в `ultracode_context`.
- Вызывается агентом перед финализацией отчета (или автоматически из хука).
- Принимает текст отчета + контекст (planId, stepId, evidence).

### 2. Разбор на claims
- Отчет разбивается на атомарные утверждения (одно предложение = один claim).
- Каждый claim классифицируется: test-result, file-change, endpoint-addition, config-change, etc.
- Критичные claim-ы: те, что утверждают изменение состояния (тесты, файлы, API).

### 3. Источники истины (evidence)
- `git diff` (рабочее дерево + staged) — для file-change claims.
- Записанные вызовы команд и exit-коды — для test-result claims.
- Фактическое содержимое файлов — для endpoint-addition claims.
- Логи выполнений — для config-change claims.

### 4. Вердикты
- **SUPPORTED** — есть прямое доказательство (exit code 0, файл существует, diff показывает изменение).
- **CONTRADICTED** — доказательство противоречит claim-у (тест упал, файл не изменён).
- **UNPROVEN** — claim проверяем, но доказательств нет (не принимать как «ок»).
- **REFUSED** — проверить невозможно (внешний сервис, нет доступа).

### 5. Жесткое правило
- Отчет валиден **только если все критичные claim-ы имеют вердикт SUPPORTED**.
- Любой CONTRADICTED или UNPROVEN блокирует выпуск отчета (fail closed).
- Вердикты сохраняются в лог (metrics.jsonl или отдельный файл).

### 6. Интеграция
- Хук `ctx.session.hook("context")` может автоматически проверять отчеты.
- Если верификация провалена — агент получает задачу исправить отчет, а не «сдать» его.
- Результат верификации возвращается как структурированный JSON.

## Интерфейс

```ts
// Новый tool: ultracode_verify_report
interface VerifyReportArgs {
  report: string        // текст отчета
  planId?: string       // ID плана (для контекста)
  stepId?: string       // ID шага (для контекста)
  evidence?: string     // записанные evidence (command, exitCode, stdout)
}

interface ClaimVerdict {
  claim: string
  verdict: "SUPPORTED" | "CONTRADICTED" | "UNPROVEN" | "REFUSED"
  evidence: string      // что нашли (или почему не проверили)
  source: string        // git diff / command output / file content / refused
}

interface VerifyReportResult {
  valid: boolean        // true только если все критичные claim-ы SUPPORTED
  claims: ClaimVerdict[]
  summary: string       // краткий итог
}
```

## Минимальный поток

1. Агент формирует отчет.
2. Вызывает `ultracode_verify_report({ report, planId, stepId })`.
3. Plugin разбивает отчет на claims.
4. Для каждого claim проверяет evidence:
   - "тесты прошли" → сверяет с последним evidence (exitCode === 0)
   - "изменен файл X" → сверяет с `git diff --name-only`
   - "добавлен эндпоинт Y" → проверяет существование файла/строки
5. Возвращает вердикты.
6. Если есть CONTRADICTED или UNPROVEN — отчет не выпускается.

## Референсы
- truth: https://github.com/blasrodri/truth
- agent-done-or-not: https://github.com/mohamedzhioua/agent-done-or-not
- attest: https://github.com/peace-orefejo/attest
- fact-gate: https://github.com/AnonZ7/fact-gate

## Acceptance
1. Tool принимает текст отчета и возвращает структурированный результат.
2. Каждый claim получает вердикт SUPPORTED/CONTRADICTED/UNPROVEN/REFUSED.
3. Отчет с хотя бы одним CONTRADICTED/UNPROVEN блокируется (valid: false).
4. Вердикты сохраняются в лог.
5. Полный suite не хуже baseline.

## Ограничения
- Только node stdlib + git.
- Не менять внешние скиллы и промты.
- Не добавлять новые зависимости.
- Не реализовывать UI.
- Не менять storage schema v3.
