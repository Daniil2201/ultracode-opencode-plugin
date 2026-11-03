---
name: ts-diagnose
description: Diagnose TypeScript type, lint, build, and module-resolution failures and identify their root cause.
---

# TypeScript diagnostics

Use this skill when the user asks to analyze TypeScript errors, failed builds, lint failures, or module-resolution problems.

1. Read repository instructions, package scripts, the lockfile, `tsconfig` files, ESLint configuration, and relevant CI workflows.
2. Preserve the package manager selected by the lockfile. Do not rewrite dependencies or lockfiles during diagnosis.
3. Reproduce the smallest relevant failure using existing scripts. Prefer `tsc --noEmit` only when it matches the repository configuration.
4. Group diagnostics by likely root cause. Trace secondary errors back to the first invalid type, import, generated file, configuration, or dependency boundary.
5. Inspect the involved declarations and call sites before proposing a fix. Check project references, path aliases, module mode, generated types, and runtime/type-only import differences.
6. If asked to fix the issue, make the smallest coherent change and rerun the failing command plus focused tests.
7. Report the root cause, changed behavior, validation, and any remaining errors separately.

Never silence errors with broad `any`, `@ts-ignore`, disabled lint rules, or weakened compiler settings unless the user explicitly requests that tradeoff.
