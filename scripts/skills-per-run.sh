#!/usr/bin/env bash
# Skill-вызовы по сессиям opencode (read-only к БД).
#
#   skills-per-run.sh [N=10]           последние N сессий, построчно
#   skills-per-run.sh --summary [N=50] сводка: сессии с/без скиллов + частота + разрез по проектам
#   skills-per-run.sh <session_id>     одна сессия по префиксу id
#
# Почему постфактум по БД, а не в event-хуке плагина: (1) покрывает и прошлые сессии,
# не только будущие; (2) ноль затрат в горячем пути; (3) `part` с type=tool, tool=skill —
# фактический источник, который opencode уже пишет. Рантайм-путь тоже возможен
# (event → message.part.updated → part.tool === "skill"), но он увидит только будущее.
set -euo pipefail

DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
[ -f "$DB" ] || { echo "нет БД: $DB" >&2; exit 1; }

# WAL: копируем db + -wal + -shm согласованно, иначе часть parts теряется (был баг «0 parts»).
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp "$DB" "$TMP/db"
[ -f "$DB-wal" ] && cp "$DB-wal" "$TMP/db-wal"
[ -f "$DB-shm" ] && cp "$DB-shm" "$TMP/db-shm"

python3 - "$TMP/db" "$@" <<'PY'
import json, os, sqlite3, sys
from collections import Counter

db, argv = sys.argv[1], sys.argv[2:]
summary = False
if argv and argv[0] in ("--summary", "-s"):
    summary, argv = True, argv[1:]
sid = argv[0] if argv and not argv[0].isdigit() else None
limit = int(argv[0]) if argv and argv[0].isdigit() else (int(argv[1]) if len(argv) > 1 else 10)

con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)

if sid:
    # substr, а не LIKE: '_' в LIKE — wildcard и матчит чужие id.
    rows = con.execute("select id, directory from session where substr(id,1,?)=?", (len(sid), sid)).fetchall()
else:
    rows = con.execute("select id, directory from session order by time_created desc limit ?", (limit,)).fetchall()

if not rows:
    print("сессии не найдены")
    sys.exit(0)


def skills_of(session):
    out = []
    for (raw,) in con.execute("select data from part where session_id=? order by id", (session,)):
        try:
            part = json.loads(raw)
        except Exception:
            continue
        if part.get("type") != "tool" or part.get("tool") != "skill":
            continue
        state = part.get("state", {}) or {}
        name = (state.get("input") or {}).get("name") or "?"
        status = "completed" if state.get("status") == "completed" else state.get("status", "?")
        out.append((name, status))
    return out


if not summary:
    print(f"{'session_id':28} | {'skills':>6} | names")
    for session, directory in rows:
        got = skills_of(session)
        names = ", ".join(f"{n} ({'ok' if s == 'completed' else s})" for n, s in got) or "-"
        print(f"{session:28} | {len(got):>6} | {names}")
    sys.exit(0)

# ─── сводка ───
total = len(rows)
freq = Counter()          # skill -> ok
errs = Counter()          # skill -> не-ok
per_project = Counter()   # project -> сессий со скиллами
per_project_all = Counter()
empty = []
calls = 0
for session, directory in rows:
    got = skills_of(session)
    project = os.path.basename((directory or "?").rstrip("/")) or "?"
    per_project_all[project] += 1
    if not got:
        empty.append((session, project))
        continue
    per_project[project] += 1
    calls += len(got)
    for name, status in got:
        (freq if status == "completed" else errs)[name] += 1

with_skills = total - len(empty)
print(f"== Сводка skill-вызовов: последние {total} сессий ==")
print(f"со скиллами: {with_skills} ({with_skills * 100 // max(total, 1)}%)   без скиллов: {len(empty)} ({len(empty) * 100 // max(total, 1)}%)")
print(f"всего вызовов skill: {calls}   успешных: {sum(freq.values())}   с ошибкой: {sum(errs.values())}")
print()
print("частота (skill — ok/err):")
for name, n in freq.most_common():
    extra = f"/{errs[name]}" if errs.get(name) else ""
    print(f"  {name:34} {n}{extra}")
for name, n in errs.most_common():
    if not freq.get(name):
        print(f"  {name:34} 0/{n}")
if not freq and not errs:
    print("  — ни одного вызова —")
print()
print("по проектам (сессий со скиллами / всего):")
for project, n in per_project_all.most_common():
    print(f"  {project:34} {per_project[project]:>3} / {n}")
print()
print(f"сессии без скиллов (последние 5 из {len(empty)}):")
for session, project in empty[:5]:
    print(f"  {session}  [{project}]")
PY
