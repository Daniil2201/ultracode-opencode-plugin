#!/usr/bin/env bash
# UC-012 smoke: новая установка содержит все нужные файлы, help без несуществующих команд.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fail=0
need=(
  ".opencode/plugin/ultracode.ts"
  ".opencode/plugin/guardrails.ts"
  ".opencode/plugin/agentmemory-capture.ts"
  ".opencode/lib/ultracode/sentinel.ts"
  ".opencode/lib/ultracode/schema.ts"
  ".opencode/lib/ultracode/store.ts"
  ".opencode/lib/ultracode/plan.ts"
  ".opencode/lib/ultracode/injection.ts"
  ".opencode/lib/ultracode/metrics.ts"
  ".opencode/lib/ultracode/classifier.ts"
  ".opencode/lib/ultracode/orchestrator.ts"
  ".opencode/lib/ultracode/verification.ts"
  ".opencode/lib/ultracode/design.ts"
  ".opencode/lib/ultracode/checkpoint.ts"
  ".opencode/lib/ultracode/autonomy.ts"
  ".opencode/lib/ultracode/runtime-contract.ts"
  ".opencode/lib/ultracode/confidential.ts"
  ".opencode/lib/ultracode/debug.ts"
  ".opencode/lib/ultracode/stack-detect.ts"
  ".opencode/lib/ultracode/stack-contract.ts"
  ".opencode/lib/ultracode/evaluation/schema.ts"
  ".opencode/lib/ultracode/evaluation/lab-runner.ts"
  ".opencode/lib/ultracode/evaluation/scoring.ts"
  ".opencode/lib/ultracode/evaluation/report.ts"
  ".opencode/lib/ultracode/evaluation/criteria.ts"
  ".opencode/lib/ultracode/evaluation/cli.ts"
  ".opencode/lib/ultracode/evaluation/portable.ts"
  ".opencode/agents/ultracode.md"
  ".opencode/agents/ultracode-planner.md"
  ".opencode/agents/ultracode-executor.md"
  ".opencode/agents/ultracode-reviewer.md"
  ".opencode/agents/ultracode-designer.md"
  ".opencode/commands/goal.md"
  ".opencode/commands/verify.md"
  ".opencode/commands/design.md"
  ".opencode/commands/checkpoint.md"
  ".opencode/commands/status.md"
  ".opencode/commands/ultracode-help.md"
  ".opencode/commands/evaluate.md"
  ".opencode/commands/debug.md"
  "scripts/sync-ultracode.sh"
  "scripts/evaluate-ultracode.sh"
)
for f in "${need[@]}"; do
  if [[ -f "$ROOT/$f" ]]; then echo "OK   $f"; else echo "MISS $f"; fail=1; fi
done
# help не содержит несуществующих команд: каждая /команда из help должна иметь файл
for c in goal verify design checkpoint status ultracode-help evaluate debug; do
  if grep -q "/$c" "$ROOT/.opencode/commands/ultracode-help.md"; then
    if [[ -f "$ROOT/.opencode/commands/$c.md" ]]; then echo "OK   help -> /$c"; else echo "MISS help -> /$c (нет файла)"; fail=1; fi
  else
    echo "MISS help без /$c"; fail=1
  fi
done
# node --check ключевых модулей
for f in .opencode/plugin/ultracode.ts .opencode/lib/ultracode/schema.ts .opencode/lib/ultracode/store.ts; do
  if node --check "$ROOT/$f" >/dev/null 2>&1; then echo "OK   node --check $f"; else echo "FAIL node --check $f"; fail=1; fi
done
exit $fail
