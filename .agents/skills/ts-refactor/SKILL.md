---
name: ts-refactor
description: Safely refactor and improve TypeScript code while preserving behavior, types, public APIs, and tests.
---

# TypeScript refactoring

Use this skill for cleanup, architectural improvement, decomposition, modernization, or maintainability work in TypeScript.

1. Read repository instructions and map the affected public API, callers, tests, type declarations, and runtime boundaries.
2. State the behavior and compatibility constraints that must remain true.
3. Prefer a small sequence of coherent edits. Keep unrelated formatting and dependency changes out of scope.
4. Preserve strict type information. Replace unsafe assertions with narrowing, validation, discriminated unions, or explicit boundary types where practical.
5. Check async error handling, resource cleanup, cancellation, mutation, import cycles, and browser/Node compatibility where relevant.
6. Run focused tests after risky steps, then the repository's type check, lint, build, and relevant suite.
7. Report observable changes, compatibility considerations, validation, and remaining risks.

Do not change public behavior or APIs merely to simplify the implementation unless the user authorized that change.
