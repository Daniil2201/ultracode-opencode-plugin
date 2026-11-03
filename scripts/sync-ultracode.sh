#!/usr/bin/env bash
# sync-ultracode.sh — синхронизация ultracode-части из dev-проекта в глобальный
# ~/.config/opencode/. Разделение с install-farm.sh: этот скрипт НЕ трогает
# opencode.json, mcp-блок (в т.ч. mcp.tg-manager) и ферму — только копирует файлы.
#
#   sync-ultracode.sh            — синхронизировать (идемпотентно)
#   sync-ultracode.sh --status   — только показать: SRC / DST / IDENTICAL / DIFF / MISS
#
# farm.ts НЕ синхронизируется: ферма принадлежит my-manager.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.opencode"
DEST="${OPENCODE_DIR:-$HOME/.config/opencode}"
MODE="${1:-install}"

# Все три плагина используют OpenCode v2 Plugin.define/ctx.* API.
PLUGINS=(ultracode guardrails agentmemory-capture)

# Печатает пары "SRC<TAB>DST" для всех файлов, которые должны синхронизироваться.
pairs() {
  local f rel
  for p in "${PLUGINS[@]}"; do
    [[ -f "$SRC/plugin/$p.ts" ]] && printf '%s\t%s\n' "$SRC/plugin/$p.ts" "$DEST/plugins/$p.ts"
  done
  for f in "$SRC"/lib/ultracode/*.ts "$SRC"/lib/ultracode/evaluation/*.ts; do
    [[ -f "$f" ]] || continue
    rel="${f#"$SRC"/}"
    printf '%s\t%s\n' "$f" "$DEST/$rel"
  done
  for f in "$SRC"/agents/*.md "$SRC"/commands/*.md; do
    [[ -f "$f" ]] || continue
    rel="${f#"$SRC"/}"
    printf '%s\t%s\n' "$f" "$DEST/$rel"
  done
  if [[ -d "$SRC/skills" ]]; then
    while IFS= read -r f; do
      rel="${f#"$SRC"/}"
      printf '%s\t%s\n' "$f" "$DEST/$rel"
    done < <(find "$SRC/skills" -name SKILL.md | sort)
  fi
  [[ -f "$SRC/templates/tz.md" ]] && printf '%s\t%s\n' "$SRC/templates/tz.md" "$DEST/templates/tz.md"
  return 0
}

report_missing_sources() {
  local p
  for p in "${PLUGINS[@]}"; do
    [[ -f "$SRC/plugin/$p.ts" ]] || echo "MISS-SRC  plugin/$p.ts (нет в проекте — пропущен, в $DEST не трогаем)"
  done
}

if [[ "$MODE" == "--status" || "$MODE" == "status" ]]; then
  echo "== sync-ultracode --status =="
  echo "SRC: $SRC"
  echo "DST: $DEST"
  echo
  same=0; diff=0; miss=0
  while IFS=$'\t' read -r src dst; do
    rel="${dst#"$DEST"/}"
    if [[ ! -f "$dst" ]]; then
      echo "MISS     $rel"; miss=$((miss+1))
    elif cmp -s "$src" "$dst"; then
      same=$((same+1))
    else
      echo "DIFF     $rel"; diff=$((diff+1))
    fi
  done < <(pairs)
  report_missing_sources
  echo
  echo "identical=$same  diff=$diff  missing_in_dst=$miss"
  echo "opencode.json: НЕ ТРОГАЕТСЯ этим скриптом (mcp.* и plugins[] остаются как есть)"
  exit 0
fi

echo "== sync-ultracode: $SRC -> $DEST =="
copied=0; updated=0
while IFS=$'\t' read -r src dst; do
  mkdir -p "$(dirname "$dst")"
  if [[ -f "$dst" ]] && ! cmp -s "$src" "$dst"; then
    updated=$((updated+1))
  elif [[ ! -f "$dst" ]]; then
    :
  fi
  cp "$src" "$dst"
  copied=$((copied+1))
done < <(pairs)
report_missing_sources

count() { find "$1" -type f 2>/dev/null | wc -l | tr -d ' '; }
echo
echo "скопировано файлов: $copied (из них обновлено отличающихся: $updated)"
echo "в проекте:  plugin=$(( ${#PLUGINS[@]} )) ожидаемых · lib=$(count "$SRC/lib/ultracode") · agents=$(count "$SRC/agents") · commands=$(count "$SRC/commands") · skills=$(count "$SRC/skills") · templates=$(count "$SRC/templates")"
echo "в $DEST:    lib=$(count "$DEST/lib/ultracode") · agents=$(count "$DEST/agents") · commands=$(count "$DEST/commands") · skills=$(count "$DEST/skills")"
echo
echo "opencode.json, mcp.* и farm/ НЕ ТРОГАЛИСЬ. Проверка: bash scripts/sync-ultracode.sh --status"
