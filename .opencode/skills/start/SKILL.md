---
name: start
description: Intelligent orchestrator for ANY engineering task — feature, bug, infra, architecture, refactor, research. Accepts a free-form goal, clarifies ambiguities via conditional Q&A, infers depth mode from risk signals, and routes to the optimal core skill or orchestrates ad-hoc orchestration. Replaces /ship as the universal front-door.
license: MIT
compatibility: opencode
metadata:
  requires_codegraph: true
---

> **Tool mapping (OpenCode):**
> - `question` tool for user prompts (not `AskUserQuestion`)
> - `task` tool for subagents (not `Agent` or `Task` subagent syntax)
> - `skill({ name: "..." })` to load other skills (not `Skill(skill="...", args="...")`)
> - `codegraph_explore`, `codegraph_search`, `codegraph_context` for codebase exploration (preferred)
> - `todowrite` for phase/progress tracking
> - `grep`, `glob`, `read`, `bash` as fallback when `.codegraph/` not initialized
>
> **Context rule:** This skill supersedes any prior skill instructions. Follow ONLY these instructions now. Read the user's goal and any mode/include/skip from the conversation context.

Read `mode=`, `include=`, and `skip=` from the conversation context. Default to the mode specified in this skill if not provided.

# start

The user gave you an engineering goal. Any goal. Clarify it when needed, pick the right depth, route to the best toolchain, run it, report. Stop before git.

The tax on a vibe coder is picking *which* workflow to invoke and *how* thorough to be. This skill removes that tax while keeping full visibility of what was decided.

---

## Step 0 — Clarify (conditional Q&A)

Use `todowrite` to mark this step as in_progress. Mark it completed when done.

Analyze the user's request for:

1. **Ambiguity** — does the goal have multiple interpretations?
2. **Missing inputs** — is key info absent (which system, what tech, expected behavior)?
3. **Decision-tree branches** — does the problem have unresolved forks (e.g., "fix auth" → fix login, fix signup, fix token refresh, fix permissions)?

**If clear** → skip this step entirely. Proceed to Step 1.

**If ambiguous** → ask questions to resolve. Batch related questions in a single `question` call when possible. Only drill one-at-a-time (grill-me style) for genuinely complex decision trees where answers change follow-up questions.

**No question limit.** But don't over-ask — one round of batched questions resolves 90% of cases.

Examples of when to ask:
- "Add a payment feature" → "Which payment provider? Stripe, Paddle, or custom?"
- "Fix the dashboard" → "What's broken — data not loading, wrong calculations, layout issues, or something else?"
- "Build infra" → "Self-hosted or cloud? Which provider? What's the stack?"

Examples of when to skip:
- "Add a dark mode toggle" → clear, specific, self-contained
- "Fix the 500 error on /checkout when clicking 'Pay Now'" → clear + has reproduction

---

## Step 1 — Analyze & Route

Use `todowrite` to mark this step as in_progress. Mark it completed when done.

Read the user's prompt and classify the request into one of these categories:

| Task type | Intent | Routes to |
|---|---|---|---|
| New project or service from scratch | INIT | `init-project` |
| New feature, screen, component, endpoint, module in an existing codebase | CREATE | `add-feature` |
| Update, extend, change behavior, small cosmetic tweak on an existing feature | EVOLVE | `modify-feature` |
| Apply UX polish checklist without behavior change | POLISH | `polish-ui` |
| Remove, delete, deprecate, rip out a feature | REMOVE | `remove-feature` |
| Integrate with an external API — typed client, retry, observability | INTEGRATE | `integrate-api` |
| Bug, broken, not working, silent failure, regression | FIX | `fix-bug` |
| Codebase audit, tech-debt sweep, deep clean, production-readiness | AUDIT | `audit` |
| Domain model rename, enum migration, status/vocabulary change with persisted data | REALIGN | `realign` |
| Architecture design, system design, thinking through structure | DESIGN | `general` subagent(s) + codegraph exploration |
| Infrastructure setup, debugging, or review | INFRA | `general` subagent(s) + relevant tooling |
| Codebase research, explain a system, understand a flow | RESEARCH | `explore` subagent(s) + codegraph |
| Anything else / multi-faceted / doesn't fit above | GENERAL | Orchestrate ad-hoc with subagents + available tooling |

**Routing rules:**

- If the request maps to a core skill (INIT / CREATE / EVOLVE / POLISH / REMOVE / INTEGRATE / FIX / AUDIT / REALIGN), route there with mode= and any include=/skip= overrides.
- If the request maps to DESIGN / INFRA / RESEARCH / GENERAL, do NOT try to force-fit into a core skill. Instead:
  1. Use `task` with appropriate subagent types to do the work
  2. Use codegraph_explore for understanding
  3. Use the full MCP + tool arsenal
  4. If a sub-skill exists that partially matches (add-migration, add-observability, etc.), invoke it as part of the orchestration
- **Multi-intent** — if the user lists clearly separable goals ("add X and remove Y"), execute sequentially as separate /start routings. State the order before starting.

**Never reject a request that doesn't fit the first 9 categories (INIT, CREATE, EVOLVE, POLISH, REMOVE, INTEGRATE, FIX, AUDIT, REALIGN).** DESIGN, INFRA, RESEARCH, and GENERAL cover everything else. If none of those fit either, the problem is so unusual that ad-hoc orchestration is the right answer — still don't reject.

---

## Step 2 — Infer the depth mode

Use `todowrite` to mark this step as in_progress. Mark it completed when done.

Three base modes — `fast`, `balanced`, `production`. Pick one before announcing.

**Plan-only modifier:** `plan-only` can be appended to any base mode (e.g. `mode=production+plan-only` or just `mode=plan-only`). When present, the skill stops after Step 3 (announce plan) — no execution, no changes. The plan is saved to the context store (`ultracode_context action=plan_new`) for later `/continue`. Use this when the user is in Plan mode (read-only) and wants to review before executing.

**Risk signals (any one → `production`)**:
- Touches auth, permissions, payments, billing, secrets, or external webhooks
- Schema migration or persisted-data rewrite
- Destructive deletion or deprecation of an external/public contract
- Background jobs, queues, cron, retries, email/SMS/push, imports/exports, file writes, spawned processes, IPC, or external APIs
- Caching, query invalidation, feature flags, analytics/business reporting, or concurrency-sensitive mutations
- Multi-subsystem in the same change (frontend + backend + DB)

**Tiny-scope signals (all four → `fast`)**:
- Single file
- Cosmetic / copy / styling only
- No data layer touched
- No new public API surface

**Default → `balanced`**.

**Override:** explicit `mode=fast`, `mode=balanced`, or `mode=production` in the user's prompt always wins — except when it conflicts with a high-risk signal (see NEVER below).

For DESIGN / INFRA / RESEARCH / GENERAL tasks, mode means:
- `fast` — minimal analysis, direct answer
- `balanced` — moderate depth with subagent exploration
- `production` — full multi-subagent analysis with cross-validation

---

## Step 3 — Announce the plan

Use `todowrite` to mark this step as in_progress. Mark it completed when done.

Output a structured plan block before executing. Format:

```
Detected: <CREATE | EVOLVE | POLISH | REMOVE | FIX | AUDIT | REALIGN | DESIGN | INFRA | RESEARCH | GENERAL>
Risk:     <low | medium | high — one-line reason>
Mode:     <fast | balanced | production | plan-only — one-line reason or "user-specified">
Pipeline:
  1. <phase>  → <core skill, sub-skill, or subagent>
  2. <phase>  → <core skill, sub-skill, or subagent>
  ...
```

Pipeline numbering must match what the routed core skill or ad-hoc plan will actually run at the chosen mode. Do not invent phases the routed skill won't execute.

**Confirmation gating depends on mode:**

| Mode | Gating |
|---|---|
| `production` | Use `question` "Proceed with this pipeline?" before Step 4. Decline → stop. |
| `balanced` | Print the plan inline, then proceed to Step 4 in the same turn. User can abort with ESC or a new prompt before execution begins. |
| `fast` | Print the plan inline as a one-line preamble, then execute immediately. No confirm prompt. |
| `* + plan-only` | Print the plan. Skip Step 4. Proceed to Step 5 with save-to-memory. |

---

## Step 4 — Execute

Use `todowrite` to mark this step as in_progress. Mark it completed when done.

**Plan-only gate:** If mode contains `plan-only`, skip execution entirely. Save the plan, then proceed to Step 5 without calling any core skill.

1. Primary: `ultracode_context action=plan_new` with the goal, steps and acceptance — this channel always works, and it is what `/continue` reads back.
2. If the `agentmemory` MCP is connected, ALSO save via `agentmemory_memory_save` with type="plan" and concepts including the detected intent and file paths. If the call fails (MCP disconnected/timeout), swallow the error silently and continue — step 1 already persisted the plan.
3. Never tell the user "plan saved" unless step 1 returned success. If `plan_new` itself failed, say so explicitly and print the plan inline so the user can copy it.

**If routing to a core skill:** Use `skill({ name: "<core-skill>" })`. The skill reads the user's goal and mode/include/skip from the conversation context — no explicit args needed.

**If routing to DESIGN / INFRA / RESEARCH / GENERAL:** Orchestrate directly:
1. Launch appropriate `task` subagents for analysis
2. Use `codegraph_explore` / `codegraph_search` for understanding
3. Invoke any matching sub-skills (add-migration, add-observability, etc.) when their gates trigger
4. Synthesize and present results

**Host-portability fallback.** If `skill` is not available:
1. Read the routed skill's SKILL.md directly.
2. Execute its instructions inline.
3. Surface the degradation in the Step 3 announcement: add a line like `Routing: inline (skill tool unavailable)`.

**Respect downstream gates.** Core skills have their own approval gates (e.g., `add-feature mode=production`'s Plan-approval). Let them fire. Don't bypass them from /start.

**Adjunct skills live downstream.** /start only chooses the top-level workflow. The routed skill owns stack/plugin-specific handoffs.

---

## Step 5 — Report and hand off to git

Use `todowrite` to mark this step as in_progress. Mark it completed when done.

Output a visible pipeline summary:

```
✔ <phase 1>  — <one-line outcome>
✔ <phase 2>  — <one-line outcome>
✔ <phase 3>  — <one-line outcome>
...

Findings:
  - <each finding surfaced by the routed skill or audits>
```

If execution was skipped (plan-only mode), append:
```
Plan saved to the context store. Run /continue to execute.
```

If execution completed:
```
Code is production-ready. To publish:
  • /commit           — group the working tree into staged commits without pushing
  • /commit-and-push  — commit then push the current branch
  • /open-pr          — open a GitHub PR
  • /continue         — continue this work if something still needs fixing
```

Surface findings, not just "done." If a sub-skill audit returned issues that weren't auto-fixed, name them here.

**Do not commit. Do not push.** The user picks the publish path.

---

## NEVER

- **NEVER commit, push, or open PRs from inside this skill**
  **Instead:** Stop at Step 5 and direct the user to `/commit`, `/commit-and-push`, `/open-pr`, or `/continue`.

- **NEVER bypass a routed core skill's own approval gate**
  **Instead:** Let the gate fire. The user interacts with the core skill's gate, not with /start.

- **NEVER replicate the core skill's pipeline inline from memory**
  **Instead:** Always delegate via `skill(...)`. When unavailable, read the SKILL.md and follow it verbatim.

- **NEVER hide which mode and pipeline you picked**
  **Instead:** Announce in every mode. Even `fast` prints the one-line preamble.

- **NEVER guess between two plausible intents without asking**
  **Instead:** Use Step 0's Q&A to resolve ambiguities before routing.

- **NEVER honor a `mode=fast` override on a high-risk change without surfacing the conflict**
  **Instead:** Pause and ask: "Detected high-risk signals (e.g., payments). You requested fast mode. Confirm fast anyway, or upgrade to production?"

- **NEVER reject a request that doesn't fit the first 9 categories (INIT, CREATE, EVOLVE, POLISH, REMOVE, INTEGRATE, FIX, AUDIT, REALIGN)**
  **Instead:** Route to DESIGN / INFRA / RESEARCH / GENERAL or orchestrate ad-hoc. There is always a path forward.

- **NEVER execute in plan-only mode**
  **Instead:** Stop at Step 3, save the plan, report. The user will return via /continue (which defaults to `balanced`).
  **Why:** Plan mode is read-only. Executing code changes violates the user's mode contract.

---

## Appendix — Adjunct skills and sub-skills

/start routes to core skills. Those core skills own the following adjunct invocations (gate-driven, not automatic):

### CREATE → `add-feature` may invoke

- **UI scaffolding:** `add-empty-error-states`, `polish-ui`, `propagate-ui-pattern`
- **Backend scaffolding:** `add-migration`, `add-observability`, `reviewer-authz`
- **Tests:** `write-tests`, `add-e2e-test`
- **Audits (Phase 7):** `reviewer-contracts`, `reviewer-concurrency`, `reviewer-data-integrity`, `reviewer-security-regression`, `reviewer-error-boundaries`, `reviewer-loading-states`, `reviewer-accessibility-regression`, `reviewer-client-bundle`, `reviewer-observability-coverage`, `reviewer-perf`, `audit-responsive`
- **Cleanup:** `simplify`, `polish-ui`

### EVOLVE → `modify-feature` may invoke

- **UI extensions:** `add-empty-error-states`, `polish-ui`
- **Backend extensions:** `add-migration`, `add-observability`, `reviewer-authz`
- **Tests:** `write-tests`, `add-e2e-test`
- **Audits:** `reviewer-contracts`, `reviewer-concurrency`, `reviewer-observability-coverage`, `reviewer-data-integrity`, `reviewer-security-regression`, `reviewer-error-boundaries`, `reviewer-loading-states`, `reviewer-accessibility-regression`, `reviewer-client-bundle`
- **Cleanup:** `simplify`, `polish-ui`

### POLISH → `polish-ui`

Runs UX checklist; no fan-out.

### FIX → `fix-bug` may invoke

- `add-regression-test`
- `polish-ui` (if UI changed)

### REMOVE → `remove-feature` may invoke

- `add-migration` (if schema change)
- `reviewer-data-integrity`, `reviewer-contracts`

### AUDIT → `audit` may invoke

Full reviewer-* family across the repo, plus `audit-responsive`, `audit-seo-meta`, `audit-analytics`, `simplify`, `harden-types`.

### REALIGN → `realign` may invoke

- `add-migration` (if persisted data needs migration)
- `reviewer-data-integrity` (post-step audit)

### DESIGN / INFRA / RESEARCH / GENERAL

These are ad-hoc orchestration paths. They may invoke any of the above sub-skills on demand, plus direct subagent work, codegraph exploration, web research, and CLI tooling. No fixed adjunct list.
