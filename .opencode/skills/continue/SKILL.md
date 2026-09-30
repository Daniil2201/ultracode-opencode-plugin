---
name: continue
description: Resume and continue work from a previous session. Recovers context via agentmemory (primary) or handoff doc (fallback), assesses remaining work, and routes through the same orchestration pipeline as /start. Use when a previous run didn't fully resolve the goal or needs iterative refinement.
license: MIT
compatibility: opencode
metadata:
  requires_codegraph: true
---

> **Tool mapping (OpenCode):**
> - `question` tool for user prompts (not `AskUserQuestion`)
> - `task` tool for subagents (not `Agent` or `Task` subagent syntax)
> - `skill({ name: "..." })` to load other skills (not `Skill(skill="...", args="...")`)
> - `agentmemory_memory_recall`, `agentmemory_memory_sessions` for context recovery
> - `codegraph_explore`, `codegraph_search`, `codegraph_context` for codebase exploration (preferred)
> - `todowrite` for phase/progress tracking
> - `grep`, `glob`, `read`, `bash` as fallback when `.codegraph/` not initialized
>
> **Context rule:** This skill supersedes any prior skill instructions. Follow ONLY these instructions now.

# continue

The user has work in progress from a previous session. Pick up where it left off — recover context, assess state, and continue the engineering pipeline.

---

## Step 1 — Recover context

Use `todowrite` to mark this step as in_progress. Mark it completed when done.

Attempt context recovery in this order:

### Primary: agentmemory

1. Run `agentmemory_memory_recall` with keywords from the user's prompt (task type, feature name, file paths, etc.)
2. **If the tool call fails** (MCP disconnected, connection refused, timeout) — catch the error silently, log "agentmemory MCP unavailable, skipping" and proceed to fallback. Do NOT crash.
3. If results are found, read the most relevant session observations to understand:
   - What was the original goal?
   - What was completed?
   - What was left incomplete or blocked?
   - What approach was being used?
4. Also check `agentmemory_memory_sessions` for recent sessions.

### Fallback: handoff doc

If agentmemory returns nothing useful or the MCP is offline:

1. Search for the most recent handoff doc under `/tmp/` matching `handoff-*.md` or similar patterns
2. Read the newest one
3. If none found, search the working directory for any recent `.md` handoff files

### Tertiary: git log search

If agentmemory and handoff docs both fail:

1. Run `git log --all --grep="handoff\|continue" --since="48 hours" --format="%H %s" --max-count=10`
2. If any commits match, read their diffs and messages for context about what was being done
3. If nothing found, also check `git stash list` for any stashed work

### Error

If none of the above yield context:
- Inform the user: "No previous session context found. Starting fresh."
- Proceed to /start's pipeline from Step 0 (Clarify Q&A)

---

## Step 2 — Assess state

Use `todowrite` to mark this step as in_progress. Mark it completed when done.

From the recovered context, determine:

1. **Goal** — what was the original objective?
2. **Completed** — what was delivered / resolved?
3. **Remaining** — what's still open, blocked, or untested?
4. **Blockers** — why wasn't it finished? (Unclear spec, runtime error, need more info, tool limitation?)
5. **Files touched** — which files were modified in the previous session?

Present this assessment to the user:

```
Continuing from previous session:

Goal:    <original goal>
Done:    <what was completed>
Left:    <what remains>
Blocker: <why it wasn't finished (if known)>
```

---

## Step 3 — Q&A (conditional)

Use `todowrite` to mark this step as in_progress. Mark it completed when done.

If the remaining work has ambiguities, missing inputs, or unresolved decision-tree branches → ask questions (same logic as /start Step 0).

If the remaining work is clearly specified → skip.

Common questions:
- "The previous session was blocked on X. Has that been resolved?"
- "Do you want to continue with the same approach, or try a different one?"
- "The previous session touched files A, B, C. Still focused there, or has the scope changed?"

---

## Step 4 — Infer mode

Use `todowrite` to mark this step as in_progress. Mark it completed when done.

Apply the same mode inference as /start Step 2 (fast / balanced / production).

**Bias:** Default to `balanced` for continuation work (we're already iterating, so lighter gates are appropriate unless risk signals are present).

---

## Step 5 — Announce the plan

Use `todowrite` to mark this step as in_progress. Mark it completed when done.

Same format as /start Step 3. Note that this is a continuation:

```
Continue:
Mode:    <fast | balanced | production>
Delta:   <what specifically remains to be done>
Pipeline:
  1. <phase>
  2. <phase>
  ...
```

Confirmation gating follows the same rules as /start Step 3 (production → confirm, balanced → print and proceed, fast → inline preamble).

---

## Step 6 — Execute

Use `todowrite` to mark this step as in_progress. Mark it completed when done.

Route to the appropriate handler based on the remaining work:

- **If remaining work maps to a core skill** → `skill({ name: "<core-skill>" })` with `mode=` from Step 4
- **If ad-hoc investigation / debugging** → Use subagents, codegraph, and tooling directly
- **If the previous session was mid-way through a skill's pipeline** → Continue from where it left off rather than restarting

Append `include=` with the specific scope (files, modules, functions) from Step 2's assessment to narrow the routed skill's focus.

**Host-portability fallback.** Same as /start Step 4.

---

## Step 7 — Report and hand off

Use `todowrite` to mark this step as in_progress. Mark it completed when done.

Same format as /start Step 5. Add a note about continuation status:

```
✔ <phase 1>  — outcome
✔ <phase 2>  — outcome

Continuation status: <fully resolved | partial — run /continue again if needed>

Findings:
  - <findings>

To publish:
  • /commit
  • /commit-and-push
  • /open-pr
  • /continue    — keep iterating if still not resolved
```

**Do not commit. Do not push.**

---

## NEVER

- **NEVER start from scratch.** The entire point of /continue is to reuse context. If context recovery fails, inform the user before falling back to a fresh /start.
- **NEVER overwrite or discard handoff docs.** Read them, don't delete them. The user may need them for audit.
- **NEVER commit, push, or open PRs.** Stop at Step 7.

---

## Appendix — agentmemory tips

For optimal context recovery in /continue:

- `agentmemory_memory_recall` accepts queries like "feature X implementation", "bug fix for Y", "files changed in last session"
- `agentmemory_memory_sessions` lists recent sessions with timestamps
- Session observations from previous runs contain file paths, decisions, and outcomes
- If the previous session was a /start run, the task classification and mode are stored in observations — use them to infer the continuation approach
