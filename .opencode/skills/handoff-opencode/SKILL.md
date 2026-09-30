---
name: handoff-opencode
description: Hand off a stalled task or stubborn bug to the OpenCode CLI for a second pass — package the original request, what the agent tried, and the live `git status` + `git diff` into a prompt file, then fire `opencode exec` headless at high reasoning effort against opencode's latest configured model, wait, and verify what changed. Trigger phrases — "/handoff-opencode", "hand off to opencode", "debug with opencode", "finish off using opencode", "let opencode try", "opencode it". Use when stuck after multiple attempts or to get a second model's pass on a hard bug. Skip for — first-pass fresh tasks, tasks needing mid-flight user input (opencode exec is one-shot), or when `opencode` is not on PATH.
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

> **User-question protocol:** Whenever this skill needs the user to pick between options, confirm an action, or answer a multiple-choice prompt, you MUST call the `question` tool to render a proper interactive picker. Do NOT print numbered options as plain text and wait for the user to type a number — that produces a degraded UX. Free-form questions (open-ended typing) may be asked in prose, but any time you would write "1) … 2) … 3) …", use `question` instead.


# handoff-opencode

Hand off the current task to `opencode exec` (OpenCode CLI) when the agent is stuck or wants a second pass. Fire-wait-verify, not fire-and-forget.

The user is delegating because *the existing approach didn't work* — so the value of this skill is in the **handoff packet**: the original goal, what was tried, what failed, and the exact diff the agent has produced so far. A thin packet wastes the opencode run.

---

## When NOT to run

- First-pass attempts on a fresh task — try yourself before delegating.
- Tasks where you don't yet know what to ask for. Clarify with the user first; don't punt ambiguity to opencode.
- When `opencode` is not on PATH (run `command -v opencode` to verify before doing anything else).

---

## Workflow

### Step 1 — Preflight

Use `todowrite` to mark this phase as in_progress.

Run these checks. If any fail, stop and tell the user.

1. `command -v opencode` — opencode CLI must exist. If missing, instruct the user to install it and abort.
2. `git rev-parse --is-inside-work-tree` — note whether we're in a git repo. If not, set a flag to add `--skip-git-repo-check` later and skip the diff/status capture.
3. `git status --short` and `git diff` — capture **right now**, not from earlier in the session. Stale diffs are worse than no diffs.

### Step 2 — Build the handoff packet

Use `todowrite` to mark this phase as in_progress.

Write the full prompt to `/tmp/opencode-handoff-prompt.md` (use the `Write` tool). Argv has length limits; piping a file via stdin does not.

Required sections, in this order:

```markdown
# Task handoff from OpenCode

## Original request
[verbatim or close paraphrase of what the user asked for]

## What I tried
[bullet list — each attempt + what happened. Include error messages verbatim.]

## Where I got stuck
[the specific blocker, in one paragraph. Be honest about what you don't understand.]

## Files I touched
[list with one-line summary per file]

## Current `git status`
```
[paste output]
```

## Current `git diff`
```
[paste output — truncate to ~500 lines if huge, and say so]
```

## What I need from you
[concrete ask — "finish wiring X to Y", "find why Z silently fails", "get the test in foo.test.ts to pass"]
```

If the diff is enormous (>1000 lines), include a summary plus the most relevant hunks rather than raw output.

### Step 3 — Invoke `opencode exec` headless at high reasoning effort

Use `todowrite` to mark this phase as in_progress.

Do not pin a specific model version. `opencode exec` defaults to the latest model the user's installation is configured for — that's the right one to use, because model lineup evolves faster than this skill can. Pass `-c model_reasoning_effort=high` so opencode spends extra reasoning budget on the hard problem you're handing off (this is the whole point of delegating — you wouldn't be calling opencode if the task were easy).

**User override** — if the user explicitly named a model in their prompt ("hand off to opencode with o4-mini"), honor that with `--model <name>`. Otherwise omit `--model` entirely and let opencode pick its default.

Use the `bash` tool with **`timeout: 600000`** (10 minutes — opencode runs are not 2-minute jobs):

```bash
opencode exec \
  -c model_reasoning_effort=high \
  --sandbox workspace-write \
  --ask-for-approval never \
  -o /tmp/opencode-output.md \
  - < /tmp/opencode-handoff-prompt.md
```

Add `--skip-git-repo-check` if preflight flagged non-repo. Add `--model <name>` only when the user named one.

The trailing `-` reads the prompt from stdin. The `-o` flag writes opencode's final message to a file for clean parsing (stdout also gets it; stderr has progress noise).

**Failures** — surface the exit code and stderr to the user verbatim. Do not retry blindly. The most common failures are auth (opencode not signed in), billing (quota exhausted), and CLI flag drift (a `-c` key or flag was renamed in a newer opencode release). Each requires a user decision, not an automatic retry.

**Note on CLI flag drift** — `opencode exec` flags and config keys evolve with the `opencode` releases. If a flag or `-c key=value` is rejected as unknown, surface the error verbatim (don't silently strip it) and ask the user to upgrade `opencode` or adjust the invocation. The flag set documented here matches the CLI as published; pin nothing else.

### Step 4 — Verify

Use `todowrite` to mark this phase as in_progress.

After opencode returns:

1. Re-run `git status --short` and `git diff --stat` to see what opencode actually changed.
2. Read `/tmp/opencode-output.md` — opencode's final message explaining what it did.
3. Cross-check: did opencode's claimed changes match the actual diff? If opencode says "I fixed X" but the diff doesn't touch the relevant file, flag it.
4. Summarize for the user: what opencode changed, whether it looks like the original ask is satisfied, and any concerns.

**If the bash call hits the 10-min timeout** — report it explicitly, surface stderr, and do not retry automatically. The user decides whether to re-invoke with a tighter prompt or a different model.

**If `/tmp/opencode-output.md` is empty or missing after a zero exit code** — treat the run as failed. Surface the captured stderr, do not assume opencode did the work silently.

**Do NOT commit.** Staging and commit decisions stay with the user.

---

## NEVER

- **NEVER pass the handoff prompt as a shell argument** (`opencode exec "huge prompt..."`)
  **Instead:** Write to a file, pipe via stdin (`opencode exec ... - < file`).
  **Why:** Argv length limits truncate large prompts silently on macOS/Linux; the diff section is the first thing to get cut.

- **NEVER run opencode with `--ask-for-approval` set to anything except `never`**
  **Instead:** Always use `--ask-for-approval never` for headless invocation.
  **Why:** Any other value can block waiting for an interactive approval that will never arrive — your bash call hangs until the 10-minute timeout.

- **NEVER auto-commit or push opencode's changes**
  **Instead:** Report what changed; let the user stage and commit.
  **Why:** OpenCode sometimes "fixes" the wrong file or makes confident-sounding changes that miss the real bug. The user is the reviewer.

- **NEVER skip the live `git status` + `git diff` capture in Step 1**
  **Instead:** Capture immediately before writing the prompt file, even if you ran them earlier in the session.
  **Why:** OpenCode starts from a cold context; without the current diff, it edits files the agent already modified and clobbers in-progress work.

- **NEVER pin a specific model version in this skill**
  **Instead:** Omit `--model` and let opencode use its configured default (the latest the user's install supports). Only pass `--model <name>` when the user named one in their prompt.
  **Why:** Model lineup turns over faster than this skill is updated. A pinned model goes stale in months; the user's opencode install always knows the current default. Hard-coding here just produces broken runs after the next release.

- **NEVER drop `-c model_reasoning_effort=high`**
  **Instead:** Always pass it. If the user wants a cheaper run, they'll say so.
  **Why:** The whole reason to invoke this skill is that the agent is stuck on a hard problem. Handing it off without high effort wastes the round-trip — you'd get the same shallow answer the agent already produced.

- **NEVER report success based on opencode's final message alone**
  **Instead:** Cross-check opencode's claimed changes against the actual `git diff`. If opencode says "I fixed X in foo.ts" but the diff doesn't touch foo.ts, treat the run as failed.
  **Why:** OpenCode sometimes hallucinates edits — its final message describes what it intended to do, not what landed on disk.

- **NEVER invoke this skill proactively**
  **Instead:** Wait for an explicit trigger phrase ("hand off to opencode", "/handoff-opencode", etc.).
  **Why:** The agent reaching for opencode on its own circumvents the user's judgment about when delegation is warranted and burns API credits without consent.

---

## Reference — `opencode exec` flags used

| Flag | Why |
|------|-----|
| `-c model_reasoning_effort=high` | Forces high reasoning effort — this skill exists for hard problems, so spend the budget |
| `--model <name>` | Omitted by default (opencode picks its latest). Pass only when the user explicitly named a model |
| `--sandbox workspace-write` | Lets opencode edit files in cwd; blocks system-wide writes |
| `--ask-for-approval never` | Mandatory for headless |
| `-o <path>` | Final message → file for parsing |
| `-` | Read prompt from stdin |
| `--skip-git-repo-check` | Only when not in a git repo |
