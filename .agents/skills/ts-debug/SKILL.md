---
name: ts-debug
description: Reproduce and debug TypeScript or Node.js runtime defects, test failures, crashes, hangs, and incorrect behavior.
---

# TypeScript debugging

Use this skill for runtime bugs, crashes, hangs, flaky tests, unexpected output, or failed TypeScript tests.

1. Establish the expected behavior and a reliable reproduction from existing tests, scripts, logs, and the smallest relevant input.
2. Capture the full error, stack trace, runtime version, entry point, and configuration without exposing secrets.
3. Follow the data and control flow from the observable failure to the earliest broken invariant. Distinguish application defects from environment, dependency, timing, and fixture failures.
4. Add temporary instrumentation only when existing evidence is insufficient. Remove diagnostic-only changes before finishing.
5. When implementation is requested, fix the root cause and add or update a focused regression test when it provides meaningful protection.
6. Rerun the reproduction, focused tests, type checking, and the nearest relevant broader check.
7. Explain the trigger, root cause, fix, and evidence. Call out nondeterministic or unverified behavior precisely.

Do not catch and discard errors, weaken assertions, increase timeouts blindly, or mark failing tests as skipped.
