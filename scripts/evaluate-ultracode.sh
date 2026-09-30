#!/usr/bin/env bash
# EV-001 — лабораторная оценка Ultracode: shell — только launcher/CI gate.
# Скоринг живёт в .opencode/lib/ultracode/evaluation/cli.ts (evaluateProject):
#   run gates → collect evidence → build criteria → evaluateProject()
#   → hard gates → score/level/verdict → toReportJson/toReportMarkdown.
#   evaluate-ultracode.sh --smoke   — быстрые ворота (без release/docs/repro-cap 79)
#   evaluate-ultracode.sh --all     — полный acceptance + двойной прогон (repro)
# Возвращает код cli: non-zero при blockers или score < 60.
# Отчёт без секретов: .opencode/eval-last.json + .opencode/eval-last.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="--smoke"
TARGET=""
PREV=""
for a in "$@"; do
  if [[ "$PREV" == "--target" ]]; then TARGET="$a"; PREV=""; continue; fi
  case "$a" in
    --smoke|--all) MODE="$a" ;;
    --help|-h)
      echo "UC-020 lab matrix: --smoke (fast gates) | --all (full acceptance, CI gate)"
      echo "UC-026 portable: --target <path> — чужая кодовая база, гейты из stack-contract"
      echo "weighted scoring via evaluation/cli.ts — no PASS-ratio score"
      exit 0 ;;
    --target) PREV="--target" ;;
    *) echo "usage: evaluate-ultracode.sh [--smoke|--all] [--target <path>]" >&2; exit 2 ;;
  esac
done
if [[ "$PREV" == "--target" ]]; then echo "missing path after --target" >&2; exit 2; fi
if [[ "$MODE" != "--smoke" && "$MODE" != "--all" ]]; then
  echo "usage: evaluate-ultracode.sh [--smoke|--all] [--target <path>]" >&2
  exit 2
fi

# UC-026 portable branch: гейты чужого проекта (read-only, без записей в target).
# Отчёты — отдельно от lab (eval-portable.*), target не трогаем.
if [[ -n "$TARGET" ]]; then
  if [[ ! -d "$TARGET" ]]; then echo "target is not a directory: $TARGET" >&2; exit 2; fi
  set +e
  node .opencode/lib/ultracode/evaluation/portable.ts \
    --root "$TARGET" \
    --out-json .opencode/eval-portable.json \
    --out-md .opencode/eval-portable.md
  CODE=$?
  set -e
  echo "Report: .opencode/eval-portable.json + .opencode/eval-portable.md"
  if [[ $CODE -eq 0 ]]; then echo "RESULT: PASS (portable)"; exit 0; fi
  if [[ $CODE -eq 1 ]]; then echo "RESULT: FAILURE (portable)"; exit 1; fi
  echo "RESULT: INCONCLUSIVE (portable)"; exit 2
fi

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/uceval.XXXXXX")"
trap "rm -f $TMPD/*; rmdir $TMPD" EXIT
NAMES=()
START_ALL=$SECONDS

redact() {
  # stdin -> stdout, без секретов. Логи гейтов хранятся почти полностью:
  # summary node --test — в КОНЦЕ вывода, короткий head отрезал бы его и ломал
  # pass_count + keyword-классификацию; консольный показ всё равно tail -n 6.
  sed -E -e 's/(api_id|api_hash|password|passwd|bot[_-]?token|api[_-]?key)[ =:]+[^[:space:]"'\'']+/\1=[redacted]/g' \
         -e 's/(bearer +)[A-Za-z0-9._-]+/\1[redacted]/g' \
         -e 's#(bot)[0-9]+:[A-Za-z0-9_-]+#\1:[redacted]#g' | head -c 200000
}

run_gate() {
  local name="$1"; shift
  local out code start end
  NAMES+=("$name")
  printf '%s' "$*" > "$TMPD/$name.cmd"
  echo "== gate: $name =="
  echo "\$ $*"
  start=$SECONDS
  set +e
  out="$("$@" 2>&1)"
  code=$?
  set -e
  end=$SECONDS
  printf '%s' "$code" > "$TMPD/$name.exit"
  printf '%s' "$(( (end - start) * 1000 ))" > "$TMPD/$name.dur"
  printf '%s' "$out" | redact > "$TMPD/$name.log"
  tail -n 6 "$TMPD/$name.log"
  echo ""
  if [[ $code -eq 0 ]]; then echo "gate $name: PASS"; else echo "gate $name: FAIL (exit $code)"; fi
  echo ""
}

pass_count() {
  # Итог node --test ("pass N") из ПОЛНОГО лога гейта. Всегда exit 0: пустой
  # результат — это "0", а не повод ронять скрипт (под set -euo pipefail голый
  # grep без совпадений возвращает 1 и убивал бы присвоение VAR=$(...)).
  grep -o 'pass [0-9][0-9]*' "$TMPD/$1.log" 2>/dev/null | tail -n 1 | awk '{print $2}END{if (NR==0) print 0}'
  return 0
}

cd "$ROOT"
run_gate "compile" node --check .opencode/plugin/ultracode.ts
run_gate "unit" node --test .opencode/tests/*.test.ts
run_gate "runtime" node --test .opencode/tests/runtime/*.test.ts
run_gate "security" node --test .opencode/tests/adversarial/autonomy.test.ts .opencode/tests/adversarial/secrets.test.ts
run_gate "concurrency" node --test .opencode/tests/adversarial/concurrency.test.ts
run_gate "mcp-test" bash -c 'cd farm && cargo test -p mcp'
run_gate "mcp-clippy" bash -c 'cd farm && cargo clippy -p mcp --all-targets -- -D warnings'
run_gate "mcp-fmt" bash -c 'cd farm && cargo fmt -p mcp -- --check'

if [[ "$MODE" == "--all" ]]; then
  run_gate "mcp-release" bash -c 'cd farm && cargo build --release -p mcp'
  run_gate "farm-health" ./scripts/farm-health.sh
  run_gate "install-status" ./scripts/install-farm.sh --status
  run_gate "install-smoke" ./.opencode/tests/install-smoke.sh
  # Reproducibility: второй прогон TS-гейтов, сравниваем pass-counts.
  UNIT1="$(pass_count unit)"; RUN1="$(pass_count runtime)"; SEC1="$(pass_count security)"; CON1="$(pass_count concurrency)"
  run_gate "repro" bash -c 'node --test .opencode/tests/*.test.ts .opencode/tests/runtime/*.test.ts .opencode/tests/adversarial/autonomy.test.ts .opencode/tests/adversarial/secrets.test.ts .opencode/tests/adversarial/concurrency.test.ts'
  echo "first-run counts: unit=$UNIT1 runtime=$RUN1 security=$SEC1 concurrency=$CON1"
  SECOND_TOTAL="$(pass_count repro)"
  echo "second-run total pass: $SECOND_TOTAL"
  FIRST_TOTAL=$(( ${UNIT1:-0} + ${RUN1:-0} + ${SEC1:-0} + ${CON1:-0} ))
  echo "first-run total pass: $FIRST_TOTAL"
  if [[ -z "$SECOND_TOTAL" || "$SECOND_TOTAL" != "$FIRST_TOTAL" ]]; then
    echo "REPRO MISMATCH"
    printf '%s' "1" > "$TMPD/repro.exit"
  else
    echo "REPRO OK"
  fi >> "$TMPD/repro.log" 2>&1
fi

TOTAL_MS=$(( (SECONDS - START_ALL) * 1000 ))
GATES_JSON="$TMPD/gates.json"
python3 - "$TMPD" "$GATES_JSON" "${NAMES[@]}" <<'PY'
import json, sys, os
tmpd, out = sys.argv[1], sys.argv[2]
names = sys.argv[3:]
gates = []
for n in names:
    def read(ext, default=""):
        try:
            with open(os.path.join(tmpd, f"{n}.{ext}")) as f:
                return f.read()
        except OSError:
            return default
    try:
        code = int(read("exit", "1").strip() or "1")
    except ValueError:
        code = 1
    try:
        dur = int(read("dur", "0").strip() or "0")
    except ValueError:
        dur = 0
    gates.append({"name": n, "command": read("cmd"), "exitCode": code,
                  "durationMs": dur, "output": read("log")})
with open(out, "w") as f:
    json.dump({"gates": gates}, f)
print(f"gates collected: {len(gates)}")
PY

set +e
node .opencode/lib/ultracode/evaluation/cli.ts \
  --gates "$GATES_JSON" \
  --root "$ROOT" \
  --goal "Ultracode 2.0" \
  --mode "${MODE#--}" \
  --duration-ms "$TOTAL_MS"
CODE=$?
set -e
echo "Report: .opencode/eval-last.json + .opencode/eval-last.md"
if [[ $CODE -ne 0 ]]; then echo "RESULT: FAILURE (evaluator exit $CODE)"; exit $CODE; fi
echo "RESULT: PASS (evaluator exit 0)"
