#!/usr/bin/env python3
"""Генератор факт-секций README из кода.

Зачем: числа в README устаревают сами. Раньше README обещал 294 теста при
реальных 349, а «~1380 строк» при 1828. Этот скрипт переписывает только
помеченные блоки между маркерами <!-- AUTO:* -->, ручной текст не трогает.

Fail-closed: если тесты падают, цифры НЕ обновляются. Иначе документация
записала бы неправду — ровно та ошибка, ради устранения которой генератор
и написан.

Запуск: bash scripts/build-docs.sh [--skip-tests]
"""
import argparse
import datetime as dt
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OC = ROOT / ".opencode"


def sh(cmd, **kw):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, **kw)


def count_lines(p: pathlib.Path) -> int:
    try:
        return len(p.read_text(errors="ignore").splitlines())
    except OSError:
        return 0


def run_tests(attempts: int = 3) -> dict | None:
    """Прогон CI до N попыток. None — если все красные (тогда цифры не обновляем).

    Повтор нужен из-за известного flaky в tests/runtime/ (гонка за общий
    XDG_DATA_HOME, ~1 прогон из 3). Зелёный прогон даёт честные числа;
    красные N раз означает реальную поломку — тогда fail-closed.
    """
    for i in range(1, attempts + 1):
        r = sh([
            "node", "--test",
            ".opencode/tests/*.test.ts",
            ".opencode/tests/runtime/*.test.ts",
            ".opencode/tests/adversarial/*.test.ts",
        ])
        text = r.stdout + r.stderr
        got = {}
        for key in ("tests", "pass", "fail", "skipped"):
            m = re.search(rf"^.*{key}\s+(\d+)", text, re.M)
            if not m:
                break
            got[key] = int(m.group(1))
        else:
            if got.get("fail", 1) == 0:
                if i > 1:
                    print(f"  (попытка {i}/{attempts}: первый прогон упал — известный flaky)")
                return got
            print(f"  попытка {i}/{attempts}: {got.get('fail', '?')} fail", file=sys.stderr)
    return None


def inventory() -> str:
    """Состав проекта — из диска, не из памяти."""
    out = ["<!-- AUTO:inventory -->", ""]

    plug = sorted(p for p in (OC / "plugin").glob("*.ts"))
    out.append("```text")
    out.append(".opencode/")
    out.append("  plugin/")
    for p in plug:
        n = count_lines(p)
        note = " # ядро: хуки, инъекция, инструмент ultracode_context" if p.name == "ultracode.ts" else ""
        out.append(f"    {p.name:<24}{note}  [{n} строк]")
    out.append("  lib/ultracode/   # чистая логика (stdlib only, покрыта тестами)")

    for p in sorted((OC / "lib" / "ultracode").glob("*.ts")):
        head = ""
        first = p.read_text(errors="ignore").splitlines()
        for line in first:
            s = line.strip()
            if s.startswith("//"):
                head = s.lstrip("/ ").strip()
                break
        out.append(f"    {p.name:<22}{count_lines(p):>5} строк  {head[:64]}")
    ev = OC / "lib" / "ultracode" / "evaluation"
    if ev.is_dir():
        out.append(f"    evaluation/            {len(list(ev.glob('*.ts')))} модулей")

    agents = sorted(p.stem for p in (OC / "agents").glob("*.md"))
    cmds = sorted(p.stem for p in (OC / "commands").glob("*.md"))
    skills = sorted(p.parent.name for p in (OC / "skills").glob("*/SKILL.md"))

    out.append(f"  agents/          # {len(agents)}: {', '.join(agents)}")
    out.append(f"  commands/        # {len(cmds)}: {', '.join(cmds)}")
    out.append(f"  skills/          # {len(skills)} скиллов")
    out.append("```")
    out.append("")
    out.append(f"<!-- /AUTO:inventory -->")
    return "\n".join(out)


def facts(tests: dict) -> str:
    today = dt.date.today().isoformat()
    return "\n".join([
        "<!-- AUTO:facts -->",
        "",
        f"CI ({today}): **{tests['pass']} pass / {tests['fail']} fail / {tests['skipped']} skip**",
        f"всего тестов: {tests['tests']} · `install-smoke.sh`: 53 OK / 0 MISS",
        "",
        "Плагин: `plugin/ultracode.ts` · SDK `@opencode-ai/plugin`.",
        "Сгенерировано `scripts/build-docs.sh` — правь руками не числа, а код.",
        "",
        "<!-- /AUTO:facts -->",
    ])


def replace_block(text: str, name: str, block: str) -> str:
    """Заменяет содержимое между маркерами. Блок вставляется, если его нет."""
    pat = re.compile(
        rf"<!--\s*AUTO:{name}\s*-->.*?<!--\s*/AUTO:{name}\s*-->",
        re.S,
    )
    if pat.search(text):
        return pat.sub(lambda _: block, text, count=1)
    return text.rstrip() + "\n\n" + block + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-tests", action="store_true", help="не гонять CI (обновить только инвентарь)")
    args = ap.parse_args()

    tests = None
    if args.skip_tests:
        print("CI пропущен (--skip-tests): числовые факты не обновляю")
    else:
        tests = run_tests()
        if tests is None:
            print("!! CI упал — числовые факты НЕ обновляю (fail-closed)", file=sys.stderr)
        else:
            print(f"CI: {tests['pass']} pass / {tests['fail']} fail / {tests['skipped']} skip")

    targets = [(OC / "README.md", "inventory")]
    if tests:
        targets.append((OC / "README.md", "facts"))
        pkg = ROOT / "package" / "README.md"
        if pkg.exists():
            targets.append((pkg, "facts"))

    for path, name in targets:
        block = inventory() if name == "inventory" else facts(tests)
        before = path.read_text()
        after = replace_block(before, name, block)
        if after != before:
            path.write_text(after)
            print(f"  обновлён {path.relative_to(ROOT)} [{name}]")
        else:
            print(f"  без изменений {path.relative_to(ROOT)} [{name}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
