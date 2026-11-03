---
name: ts-code-review
description: Review TypeScript changes for correctness, regressions, security, type safety, performance, and missing tests.
---

# TypeScript code review

Use this skill when the user asks for a review of TypeScript code, a diff, branch, commit, or pull request.

1. Read repository instructions and inspect the complete diff with enough surrounding code to understand behavior.
2. Prioritize concrete defects: incorrect results, broken contracts, races, unsafe parsing, authorization mistakes, injection, resource leaks, error loss, invalid type assumptions, and compatibility regressions.
3. Verify each finding against callers, tests, configuration, and runtime behavior. Do not report style preferences as defects.
4. For every finding, give the exact location, trigger, impact, and a practical correction.
5. Check whether tests exercise failure paths, boundary values, concurrency, and the regression being fixed.
6. Run relevant read-only checks when available. Clearly distinguish verified failures from risks inferred from code.
7. Order findings by severity. If no actionable defects are found, say so and mention material areas that were not executable or verified.

Keep the review focused on the requested change and avoid rewriting the code unless the user asks for implementation.
