#!/usr/bin/env bash
# Сборка publish-артефакта package/ из исходников .opencode/.
# package/ — ГЕНЕРИРУЕМАЯ копия, руками её не правь: правь .opencode/ и запусти снова.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/.opencode"
OUT="$ROOT/package"
VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/package.json'))['version'])")"

rm -rf "$OUT/plugin" "$OUT/lib"
mkdir -p "$OUT"
cp -R "$SRC/plugin" "$OUT/plugin"
cp -R "$SRC/lib" "$OUT/lib"

# Только то, что плагин реально импортирует. agents/commands/skills/templates
# opencode читает из конфиг-дира, из пакета они не подхватаются — положил бы мёртвый груз.
python3 - "$OUT/package.json" "$VERSION" <<'PY'
import json, sys, collections
out, version = sys.argv[1], sys.argv[2]
d = json.load(open(out), object_pairs_hook=collections.OrderedDict)
d["version"] = version
json.dump(d, open(out, "w"), indent=2, ensure_ascii=False)
open(out, "a").write("\n")
PY

echo "package/ собран из .opencode/ (v$VERSION)"
echo "  файлов: $(find "$OUT" -type f | wc -l | tr -d ' ')  размер: $(du -sh "$OUT" | cut -f1)"
echo "  README.md и package.json — правь руками, они не генерируются."
