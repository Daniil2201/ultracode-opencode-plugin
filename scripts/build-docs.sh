#!/usr/bin/env bash
# Перегенерация факт-секций README из кода.
# Ручной текст не трогается: правится только содержимое между маркерами <!-- AUTO:* -->.
#   bash scripts/build-docs.sh                 # инвентарь + прогон CI
#   bash scripts/build-docs.sh --skip-tests    # только инвентарь, CI не гоняется
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$ROOT/scripts/gen-docs.py" "$@"
