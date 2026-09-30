---
name: audit
description: Whole-codebase tech-debt sweep. First maps architecture and data flow, then orchestrates every available audit/harden/cleanup skill (duplication, type safety, data integrity, security, contracts, error boundaries, loading states, a11y, concurrency, client-bundle, observability, perf, simplify) across the repo — not just the diff — to find and remove accumulated tech-debt. Produces an architecture summary, severity-ranked findings report, refactoring strategy, then applies mechanical fixes inline and gates structural fixes per-item. Use when the user says "audit the codebase", "understand this codebase", "refactor without behavior changes", "tech-debt sweep", "deep clean", "/audit", "find all the rot", "production-readiness pass", "full cleanup", or when ship routes here for a production-grade hardening pass. Skip for — focused diff-only reviews (use simplify), single-concern audits (call the specific `audit-*` skill directly), and any context where the user only wants a quick fix.
license: MIT
compatibility: opencode
metadata:
  source: "Adapted from AgentSystemLabs/core (MIT)"
  requires_codegraph: true
---

> **Tool mapping (OpenCode):** This skill uses:
> - `question` tool for user prompts (not `AskUserQuestion`)
> - `task` tool for subagents (not `Agent` or `Task` subagent syntax)
> - `skill({ name: "..." })` to load other skills (not `Skill(skill="...", args="...")`)
> - `codegraph_explore`, `codegraph_search`, `codegraph_context` for codebase exploration (preferred)
> - `todowrite` for phase/progress tracking
> - `grep`, `glob`, `read`, `bash` as fallback when `.codegraph/` not initialized
>
> **Context rule:** This skill supersedes any prior skill instructions. Follow ONLY these instructions now. Read the user's goal and any mode/include/skip from the conversation context.

Read `mode=`, `include=`, and `skip=` from the conversation context. Default to the mode specified in this skill if not provided. If `skip=` is present, exclude those audits from the battery.

# Audit

A whole-codebase tech-debt sweep. The diff-scoped `simplify` and the per-concern `audit-*` / `harden-*` skills each cover a slice; this skill runs the full battery against the whole repo, deduplicates findings, and walks the user through fixes. It is heavier than `simplify` and slower than any single `audit-*` — invoke it deliberately.

---

## Phase 1 — Scope and confirm

Use `todowrite` to mark this phase as `in_progress`. Mark it `completed` when done.

1. Detect repo root, primary language(s), frameworks (TanStack/Next/Electron/etc.), and rough size: `git ls-files | wc -l`.
2. If the working tree is dirty, surface it: an audit on top of in-progress changes will tangle findings with WIP. Ask via `question`: "(s)tash and audit clean tree / (a)udit current state / (q)uit". Default `s`.
3. If the repo has >2000 source files, ask the user to narrow scope (a directory, a feature area, a route group) before running. A whole-monorepo audit produces noise instead of signal.
4. Announce the battery of audit skills that will run (Phase 4) so the user knows what's coming and can `skip=` any.

**Inputs accepted from caller (e.g., `ship`):**
- `scope=<path>` — narrow to a directory
- `skip=<csv>` — comma-separated list of audit skill names to skip
- `mode=fast|balanced|production` — `fast` runs only `simplify` + typecheck/lint; `balanced` adds the high-leverage audits; `production` runs everything. Default `balanced` when invoked directly; honor caller-supplied mode otherwise.

---

## Phase 2 — Architecture and data-flow map

Use `todowrite` to mark this phase as `in_progress`. Mark it `completed` when done.

**Prefer `codegraph_explore`** for tracing entry points, state stores, data-access modules, and call graphs. Use `codegraph_search` for finding symbols by name. Fall back to `grep` + `read` + `glob` only when `.codegraph/` is not initialized (mention the user can run `codegraph init -i`).

Before judging structure, understand it:

1. Identify app entry points, route/server boundaries, state stores, data-access modules, job/worker entry points, and external integration boundaries.
2. Trace the main data flow for 2–3 representative user actions: UI/input -> validation -> API/server function -> domain/use-case -> persistence/external service -> cache invalidation/refetch -> rendered state.
3. Name ownership boundaries: which modules own domain rules, persistence, UI composition, infrastructure concerns, and cross-cutting utilities.
4. Record architecture smells separately from code smells: mixed UI/data access, duplicate domain rules, unclear source of truth, circular dependencies, cross-layer imports, stale cache patterns, overgrown modules.
5. **Structural hygiene pass.** Walk the directory tree and flag layout rot — *don't* fix it here, just record findings for Phase 5:
   - Directories with mixed concerns (UI components next to data-access next to domain logic with no separation).
   - Files that have outgrown their location (a single 800-line file holding three unrelated features; a `utils.ts` that has become a junk drawer).
   - Naming drift (sibling files using inconsistent casing/conventions; "v2"/"new"/"old" suffixes that stuck around).
   - Misplaced files (tests not co-located with the convention; types floating in random folders; one-off scripts in `src/`).
   - Dead directories (empty folders, or folders whose last meaningful change is ancient and whose contents look orphaned).
   If layout issues are material, the Phase 5 report should call them out and recommend invoking `reorganize-files` as a follow-up — *after* the in-place fixes land, so the move diff isn't tangled with content changes.

Output a short architecture summary before running the audit battery. If you cannot name the data flow, keep exploring; otherwise the findings will be local observations without system context.

---

## Phase 3 — Baseline gates

Use `todowrite` to mark this phase as `in_progress`. Mark it `completed` when done.

Run first, in parallel via Bash:
- Project typecheck (e.g., `tsc --noEmit`, `pyright`, `cargo check`)
- Linter (e.g., `eslint`, `ruff`, `clippy`)
- Formatter check (no auto-fix yet)
- Test suite (smoke only — full run gated to Phase 7)

Baseline failures get fixed first. Stacking refactors on top of a red baseline buries the signal.

---

## Phase 4 — Parallel audit fan-out

Use `todowrite` to mark this phase as `in_progress`. Mark it `completed` when done.

Launch the applicable audit skills concurrently via `skill({ name: "..." })`, each scoped to the agreed Phase 1 scope (not just the diff). Pass `mode=audit` so each skill knows it's running repo-wide and should not auto-fix.

**Host-portability fallback.** If the `skill()` call is not available in the current session (Codex and other non-OpenCode hosts), Read each applicable skill's SKILL.md at `skills/<skill-name>/SKILL.md` and execute them sequentially in this turn, treating each as the next phase of work. Reviewer subagents (`reviewer-*`) still go through `task({ subagent_type: "general", ... })` — most CLIs that lack `skill()` still have a general-purpose agent primitive, and you can pass the reviewer's SKILL.md path to it. Surface the degradation up-front: tell the user "Skill tool unavailable — audits will run inline, sequentially, without subagent isolation." Inline sequential execution is slower and loses fan-out parallelism, but the findings are still produced.

**Always (every mode):**
- `skill({ name: "simplify" })` — DRY, magic numbers, naming, oversized files, parallel-enum drift, repeated literals (override default diff-only scope to Phase 1 scope)
- `skill({ name: "harden-types" })` — strip `any`, dangerous casts, missing return types, missing boundary validation

**Balanced and production:**
- **`reviewer-data-integrity`** — dispatch via `task({ subagent_type: "reviewer-data-integrity", description: "Audit data integrity", prompt: "Audit data integrity across the repo. Scope: <Phase 1 scope>. Return severity-ranked findings with file:line refs." })`.
- **`reviewer-error-boundaries`** — dispatch via `task({ subagent_type: "reviewer-error-boundaries", description: "Audit error boundaries", prompt: "Audit error boundaries across the repo. Scope: <Phase 1 scope>. Return severity-ranked findings with file:line refs." })`.
- **`reviewer-loading-states`** — dispatch via `task({ subagent_type: "reviewer-loading-states", description: "Audit loading states", prompt: "Audit loading states across the repo. Scope: <Phase 1 scope>. Return severity-ranked findings with file:line refs." })`.
- **`reviewer-contracts`** — dispatch via `task({ subagent_type: "reviewer-contracts", description: "Audit contracts", prompt: "Audit contracts across the repo. Scope: <Phase 1 scope>. Return severity-ranked findings with file:line refs." })`.
- **`reviewer-observability-coverage`** — dispatch via `task({ subagent_type: "reviewer-observability-coverage", description: "Audit observability coverage", prompt: "Audit observability coverage across the repo. Scope: <Phase 1 scope>. Return severity-ranked findings with file:line refs." })`.
- **`reviewer-perf`** — dispatch via `task({ subagent_type: "reviewer-perf", description: "Audit performance", prompt: "Audit performance across the repo. Scope: <Phase 1 scope>. Isolate the read-heavy perf audit. Return severity-ranked findings with file:line refs." })`.

**Production only (additionally):**
- **`reviewer-security-regression`** — dispatch via `task({ subagent_type: "reviewer-security-regression", description: "Audit security regression", prompt: "Audit security regression across the repo. Scope: <Phase 1 scope>. Isolate the read-heavy security audit. Return severity-ranked findings with file:line refs." })`.
- **`reviewer-concurrency`** — dispatch via `task({ subagent_type: "reviewer-concurrency", description: "Audit concurrency", prompt: "Audit concurrency across the repo. Scope: <Phase 1 scope>. Return severity-ranked findings with file:line refs." })`.
- **`reviewer-client-bundle`** — dispatch via `task({ subagent_type: "reviewer-client-bundle", description: "Audit client bundle", prompt: "Audit client bundle across the repo. Scope: <Phase 1 scope>. Return severity-ranked findings with file:line refs." })`.
- **`reviewer-accessibility-regression`** — dispatch via `task({ subagent_type: "reviewer-accessibility-regression", description: "Audit accessibility regression", prompt: "Audit accessibility regression across the repo. Scope: <Phase 1 scope>. Return severity-ranked findings with file:line refs." })`.

**Stack-conditional (auto-include when the stack matches):**
- TanStack Start present → **route-data / layers** диспатчатся как `task({ subagent_type: "reviewer-contracts", description: "Audit route data and layer contracts", prompt: "Audit route params ↔ links and layer boundary contracts across the repo. Scope: <Phase 1 scope>. Return severity-ranked findings with file:line refs." })` (скиллов `code-enforce-route-data` / `code-enforce-layers` в этом репозитории нет).

Honor `skip=` from the caller. Do not run audits the user explicitly excluded.

---

## Phase 5 — Consolidate findings

Use `todowrite` to mark this phase as `in_progress`. Mark it `completed` when done.

Each audit returns a list. Merge into one report grouped by **severity** (critical / suggested / nit), then by **category**, then by **file**. Deduplicate findings that multiple audits flagged (e.g., a `Promise.all` miss flagged by both `reviewer-perf` and `simplify`) — keep one entry, cite both sources.

Print the architecture summary and consolidated report **before** applying anything. Format:

```
Architecture summary
  entry points: <routes/server/jobs>
  data flow:    <core path in one line>
  boundaries:   <what owns UI/domain/data/infrastructure>

Audit summary — N findings across K categories
  critical: <count>  — <one-line headline>
  suggested: <count>
  nit: <count>

By category:
  type-safety (12):    <top 1–2 examples with file:line>
  duplication (8):     <top examples>
  data-integrity (3):  ...
  ...

Refactoring strategy:
  1. <mechanical chunk>
  2. <type/data-flow chunk>
  3. <structural item requiring approval>
```

---

## Phase 6 — Apply (gated)

Use `todowrite` to mark this phase as `in_progress`. Mark it `completed` when done.

Two paths, mirroring `simplify`:

- **Auto-apply (no per-item prompt):** mechanical fixes only — magic-number → named constant, swap inline logic for a confirmed existing util, single-file local rename, dead-comment delete, formatter auto-fix, lint auto-fix.
- **Per-item gate (via `question` tool):** every structural fix, every cross-module rename, every behavior-adjacent change. Use `question` to present each item: "(a)pply / (s)kip / (q)uit".

Before any structural fix on a code path with no covering test, invoke `skill({ name: "write-tests" })` for that path and confirm green — same safety-net rule as `simplify`.

Apply in this order to keep the diff bisectable:
1. Formatter / lint auto-fixes (one commit-shaped chunk)
2. Type hardening (one chunk)
3. Mechanical simplifications
4. Structural refactors — one at a time, re-run typecheck + targeted tests after each

---

## Phase 7 — Re-verify and report

Use `todowrite` to mark this phase as `in_progress`. Mark it `completed` when done.

1. Re-run typecheck, linter, full test suite.
2. Print final summary: architecture risks addressed, applied N, skipped M, surfaced K (couldn't auto-fix).
3. List remaining surfaced findings the user must decide on (architectural, design-input-needed, out-of-scope-but-flagged).
4. **Do not commit.** Hand off to the user: `/commit`, `/commit-and-push`, or `/open-pr`.

---

## NEVER

- **NEVER run all audits silently in the background without announcing the battery**
  **Instead:** Phase 1 must list which audits will run at the chosen mode so the user can `skip=` any.
  **Why:** A 12-audit fan-out that surprises the user looks like runaway tooling. Visibility is the whole point of the orchestrator.

- **NEVER batch-apply structural fixes across categories**
  **Instead:** apply the formatter/lint pass, then types, then mechanical, then one structural fix at a time with verification between.
  **Why:** When a typecheck or test goes red after a batch, you've lost which change caused it; bisectability is the only cheap path to recovery.

- **NEVER expand the audit beyond the agreed Phase 1 scope without asking**
  **Instead:** if a finding points to siblings outside scope, surface them in Phase 7 and ask before touching.
  **Why:** the user agreed to a scope; silently auditing more files turns a 30-minute pass into a multi-hour rewrite they didn't ask for.

- **NEVER honor `mode=fast` on a request that explicitly says "deep dive" or "production"**
  **Instead:** surface the conflict via `question` and let the user pick informed.
  **Why:** the autopilot caller may pass `fast` based on a heuristic that's wrong for an explicit audit request; the user's wording wins.

- **NEVER auto-apply a fix that one audit flagged but another would conflict with**
  **Instead:** during Phase 5 consolidation, mark conflicting findings and route them through the gate even if each individually looks mechanical.
  **Why:** "extract this helper" from `simplify` can collide with "inline this for bundle size" from the `reviewer-client-bundle` subagent; the user decides which wins.

- **NEVER skip the baseline gates in Phase 3**
  **Instead:** fix typecheck/lint/test failures first, then audit.
  **Why:** stacking refactors on a red baseline means every subsequent failure is ambiguous — was it the audit fix or the pre-existing break?
