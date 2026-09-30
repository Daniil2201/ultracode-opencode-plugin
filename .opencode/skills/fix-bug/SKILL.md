---
name: fix-bug
description: Diagnose an integration/feature that "should work but didn't" — hooks not firing, status not updating, callbacks not arriving, jobs not running, webhooks silent. Lead with the concrete runtime contract (endpoints, env vars, file paths, log locations) and the single fastest diagnostic before listing hypotheses. Also handles regressions — features that used to work and recently broke — via `mode=regression`, which uses git history (log/blame/bisect) instead of runtime tracing. Run when the user says "this didn't trigger", "X didn't update", "the hook never fired", "should have happened but didn't", "this used to work", "worked yesterday", "broken since [deploy/update]", "what changed", "/fix-bug", or reports a missing side effect from an action they performed. Accepts `mode=fast|balanced|production|regression` to control depth (default: balanced); also accepts `include=` / `skip=` overrides. Skip for crashes with a stack trace, type errors, or test failures — those have their own evidence already.
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

> **Mode handling:** Parse `mode=` from the user's message before executing the workflow. Default to `balanced` when no mode is specified. Apply `include=` / `skip=` overrides after mode selection to add or remove workflow steps.

# fix-bug

Diagnose silent integration failures — code that runs without error but the expected side effect never happens. The bug is almost always in the seams: a hook that wasn't loaded, an env var that wasn't injected, a fail-soft `|| true` that swallowed the real error, a shell-quoting mistake, a stale process.

The user has already done the hard part — they noticed the absence. Don't make them ask follow-up questions to extract information you could have given upfront.

---

## When NOT to run

The description covers when to activate. The non-obvious filter:

**Do NOT run** when the failure already has a concrete error message, stack trace, or failing test — those have evidence; this skill is for the *no evidence* case where the side effect silently failed to occur.

**Auto-switch to `mode=regression`** when the user reports that this used to work and recently broke with a named time/version anchor — "worked yesterday", "worked in v1.4", "broken since the deploy", "worked before the auth refactor". Git history is faster than runtime tracing when there's a known-good past. If the user cannot name a past-working anchor, stay in the default workflow — it's a debugging task, not a regression hunt.

---

## Modes

This skill accepts a `mode=` argument. Default — when no `mode=` is specified — is `balanced`: the full 7-step workflow below.

| Mode | Behavior |
|---|---|
| `fast` | Skip the full "Response shape for first message" structure. Trace, identify, patch. For known-cause bugs where the user has already named the suspected line, or trivial single-file fixes. |
| `balanced` (default) | Full 7-step workflow: trace → runtime contract → silent-failure grep → single diagnostic → ranked hypotheses → read evidence literally → propose fix. |
| `production` | `balanced` + after Step 7 (propose fix), invoke `skill({ name: "add-regression-test" })` to pin the bug with a test that fails on the pre-fix code and passes on the post-fix code. |
| `regression` | Load [`references/regression-hunt.md`](references/regression-hunt.md) and follow its phased workflow (confirm anchor → clean tree → repro → log/blame → bisect → root cause). For the bisect phase, read [`references/git-bisect.md`](references/git-bisect.md) for the manual walkthrough (good/bad/skip protocol, merge commits, recovery). Skip fix-bug's default workflow entirely — regression hunting works through git history, not runtime tracing. Stops at root-cause identification; user decides whether to revert, patch, or refactor. |

**`include=` / `skip=` overrides.** Add or remove specific steps — `mode=fast include=regression-test` runs the lean trace + adds a regression test; `mode=production skip=regression-test` runs the full diagnostic without pinning.

**Mode safety override.** If `mode=fast` is requested for a bug touching auth, payments, secrets, schema integrity, or external webhooks, surface the conflict via the `question` tool and confirm before honoring. Silent integration failures in those areas often have second-order causes the runtime contract surfaces — `mode=fast` skips that surfacing.

**Phase-gated NEVER scope.** When `mode=fast` is in effect, *"NEVER list hypotheses without first stating the runtime contract"* is suspended for that run — fast mode explicitly opts out of the contract-first structure. The remaining NEVERs (no overconfident assertion, no parallel-hypothesis test asks, no theorizing past pasted evidence, no ignoring silent-failure patterns, no assuming the running process has latest code) stay in force in every mode.

---

## Workflow

### Step 1 — Trace the integration end-to-end with file:line refs

> **`todowrite`**: Create a todo for "Trace integration end-to-end" (status: `in_progress`). Mark complete when all 4 links are mapped.

Before forming hypotheses, map the *actual* runtime path. **Strongly prefer dispatching a subagent** via `task({ subagent_type: "general", description: "Trace runtime contract", prompt: "For the following integration, trace the runtime path: ..." })` with the integration description — it returns the 4-link trace plus silent-failure sites in a fresh context, which keeps the parent's window clean for hypothesis formation. Use the inline guidance below only when running the trace inline is genuinely faster (single-file integration, you already have the file:line refs from prior turns).

**Prefer `codegraph_explore` for structural trace questions** (file-level symbols, call graphs, type relationships) over grep. Use `grep` only for literal text patterns (error messages, string constants, log lines). When searching for functions by name, use `codegraph_search`.

The trace must cover:

1. Where the side effect is **triggered** (the user's action → handler).
2. Where the side effect is **dispatched** (the outbound call: HTTP, IPC, queue, file write, env injection).
3. Where the side effect is **received** (server handler, listener, hook target).
4. Where the side effect is **observed** (DB row, UI status, log line).

Use Explore/grep/`codegraph_explore` liberally; cite each link with `file:line`. If any link is missing — that's the bug, stop.

**Library boundary as a seam.** If a third-party library mediates any step (terminal emulator, parser, framework router, RPC client, ORM), treat the library as part of the seam. Name the exact entry point you call (e.g. `term.attachCustomKeyEventHandler`) and the exact behavior you assume (e.g. `returning false stops further processing`). Assumed library behavior is a hypothesis until verified against the library's source — not its README, not a code comment, not prior memory (see NEVER #7 below).

**State store as a seam.** If the integration boundary is a stack-specific state layer (a React reducer/context, Redux/Zustand store, Vue reactivity, SwiftUI `@State`, etc.), it is its own seam — with its own update mechanics that can drop or delay messages (lazy updaters, batching, stale closures, double-invocation in dev modes). Don't treat the store as a verified link just because it "ran" — verify the actual stored value after the update, not just that the dispatch fired.

### Step 2 — Surface the runtime contract UPFRONT

> **`todowrite`**: Create a todo for "Surface runtime contract" (status: `pending`). Mark `in_progress` before assembling the contract, mark `completed` when all 6 items are included in the response.

In your **first** response to the user, include all of these without being asked:

- **Exact endpoint(s) hit** — full URL template with substitutions, e.g. `POST http://127.0.0.1:<port>/api/hooks/open-code?taskId=<id>`.
- **Auth shape** — header name, where the token comes from (`Bearer ${apiToken}` from settings DB at `…`).
- **Required env vars** — name, where injected (`MC_TASK_ID`, `MC_API_URL`, `MC_API_TOKEN` injected at `pty-manager.ts:106-108`).
- **On-disk artifacts** — config files written, where (`<cwd>/.opencode/settings.local.json`).
- **Log/observation locations** — where output goes, or "no logs — errors are swallowed at `file:line`".
- **The exact event name / payload shape** the system expects (`hook_event_name: "UserPromptSubmit"`).

**Rule of thumb:** if the user could plausibly ask "what endpoint?" / "what env var?" / "where is it written?" — you failed Step 2. Put it in the first message.

### Step 3 — Identify silent failure points

> **`todowrite`**: Create a todo for "Identify silent failure points" (status: `pending`). Mark `in_progress` before running the grep, mark `completed` when all swallow sites are listed with file:line refs.

Grep the dispatch path for swallowing patterns and call them out explicitly:

```
Use the `grep` tool (or `bash` with `rg -n`) to search the dispatch path:

grep pattern: `\|\| true|catch\s*\{\s*\}|\.catch\(\s*\(\s*\)?\s*=>\s*(undefined|null|void)`
grep pattern: `>/dev/null 2>&1|2>/dev/null`
```

For each hit, note: *"errors here are silently dropped — the only way to know if it ran is to instrument it."* This is almost always where the bug is hiding.

### Step 4 — Ask for the ONE piece of runtime evidence that disambiguates

> **`todowrite`**: Create a todo for "Request disambiguating evidence" (status: `pending`). Mark `in_progress` while selecting the diagnostic, mark `completed` when the user's evidence arrives and is processed.

Don't present 3 hypotheses and ask the user to test all of them. Pick the **single observation** that splits the hypothesis space in half, and ask for it.

**Before picking, ask yourself:** *"Which single observation, if I had it right now, would let me discard the most hypotheses?"* That's the diagnostic to request — not the easiest, not the most familiar, the most disambiguating.

| Integration type | Symptom keywords | Fastest diagnostic |
|------------------|------------------|--------------------|
| HTTP / webhook | "endpoint silent", "callback never came", "POST didn't arrive" | Tail the receiver log while user repros — does the request arrive at all? |
| OpenCode hook | "hook didn't fire", "/hooks" | Run `/hooks` in the OpenCode session — it prints execution errors verbatim (note: `/hooks` may not be available in all OpenCode installations; fall back to checking shell or plugin logs) |
| Env-var injection | "empty value", "command not found in subprocess" | In the spawned shell: `echo "$VAR1\|$VAR2\|$VAR3"` — empty fields = injection failed |
| Config file write | "settings missing", "config not picked up" | Does `<path>` exist? `cat` it. Diff against expected shape. |
| Queue / job worker | "job never ran", "task stuck queued" | Is the worker process alive? Tail its log. Inspect the queue depth/dead-letter. |
| Cron / scheduled | "didn't run at <time>" | Check the scheduler's log for a fire entry; verify the schedule expression and timezone. |
| File watcher | "save didn't trigger rebuild" | `lsof` or platform-specific watcher list — is the path actually being watched? |
| MCP / tool call | "tool returned nothing", "agent didn't call it" | Check the MCP server's stderr; verify the tool is exposed in the tools list. |
| Library boundary | "lib's API didn't behave as documented", payload-swap fixes don't stick | Open the installed JS source (`node_modules/<pkg>/lib/...` or `dist/`), grep the function name, read the branch your code actually hits — `.d.ts` files often misrepresent runtime behavior. |

Pick the cheapest diagnostic that the user can run in <30 seconds.

**If the diagnostic comes back ambiguous** (e.g., "the file exists but I can't tell if the curl ran"): instrument the swallowed-error site identified in Step 3. Replace the `>/dev/null 2>&1` / empty `catch {}` with a redirect to a log file (or `console.error`), have the user repro once, then read the log. Treat this as the next single diagnostic — do not branch into multiple parallel checks.

**If the user can't run shell commands** (locked-down env, dashboard-only access, hosted CI without exec): swap the shell diagnostic for a paste-or-screenshot ask — the relevant dashboard panel, log viewer entry, network tab response, or queue UI row. Name the exact field/column you need ("the `Last delivery` column for webhook X", not "send a screenshot of the page") so the single round trip still disambiguates.

### Step 5 — Rank hypotheses by likelihood, mark confidence honestly

> **`todowrite`**: Create a todo for "Rank hypotheses" (status: `pending`). Mark `in_progress` when assembling the list, mark `completed` when all hypotheses are marked with confidence indicators and shared with the user.

When listing possible causes, order by likelihood given the evidence so far, and **flag uncertainty explicitly**:

- ✅ "Confirmed by `<evidence>`" — when you've verified.
- 🟡 "Likely — `<reason>`" — when the code path supports it.
- ⚪ "Possible — depends on `<thing I don't know>`" — speculation.

If the user pushes back ("are you sure?"), do not double down. Re-read the relevant docs/code and revise.

### Step 6 — When evidence arrives, read it literally

> **`todowrite`**: Create a todo for "Read evidence literally" (status: `pending`). Mark `in_progress` when raw user evidence arrives, mark `completed` when the literal cause is identified in the output.

If the user pastes runtime output (a `/hooks` dialog, log line, error message), the bug is usually **in the output verbatim**, not in your hypothesis list. Read the literal text — shell-quoting bugs, missing env vars, 401 responses, and typos all show up as plain text in real evidence.

Example from a real session: an OpenCode `/hooks` dialog (if available) showed `sh -c if [ -z … then exit 0; fi …` with a syntax error. The bug was the `["sh","-c",script].join(" ")` produced `sh -c <unquoted-script>` — OpenCode wraps `command` in `/bin/sh -c` itself, so the inner `sh -c` left the script unquoted. The error was visible in the first line of output; no hypothesis-testing needed.

### Step 7 — Propose the fix

> **`todowrite`**: Create a todo for "Propose fix" (status: `pending`). Mark `in_progress` when root cause is confirmed, mark `completed` when the patch is written and verified.

Once root-caused, edit the file and add one sentence the standard fix narration doesn't already cover: **why the existing code looked plausible** — what made the bug ship past review. Do not refactor surrounding code unless it's part of the fix.

---

## Post-fix adjunct routing

After the fix is implemented and verified, run only the adjuncts whose gates match the patch. Honor `skip=` from the caller.

- **contracts review** (`task({ subagent_type: "general", description: "Review contracts", prompt: "Review the patch for client/server, route/schema, IPC, DTO, generated-client, server-function, OpenAPI, tRPC, or API boundary issues." })`) — when the patch changes a client/server, route/schema, IPC, DTO, generated-client, server-function, OpenAPI, tRPC, or API boundary.
- **concurrency review** (`task({ subagent_type: "general", description: "Review concurrency", prompt: "Review the patch for mutations, jobs, webhooks, retries, idempotency, transactions, async UI writes, polling, or stale async responses." })`) — when the patch touches mutations, jobs, webhooks, retries, idempotency, transactions, async UI writes, polling, or stale async responses.
- **observability review** (`task({ subagent_type: "general", description: "Review observability", prompt: "Review the patch for critical-path async/error/integration observability gaps." })`) — after critical-path async/error/integration fixes. If missing evidence is still in scope, invoke `skill({ name: "add-observability" })`.
- **security review** (`task({ subagent_type: "general", description: "Review security", prompt: "Review the patch for auth, payments, secrets/env, file upload, webhook signing, external APIs, unsafe redirects, or user-rendered HTML." })`) — when the patch touches auth, payments, secrets/env, file upload, webhook signing, external APIs, unsafe redirects, or user-rendered HTML.
- **error boundaries review** (`task({ subagent_type: "general", description: "Review error boundaries", prompt: "Review the patch for user-facing failure paths, route loaders, form submits, background failures surfaced in UI, or blank-screen risks." })`) — when the bug or fix affects a user-facing failure path, route loader, form submit, background failure surfaced in UI, or blank-screen risk.
- **add-migration** (`skill({ name: "add-migration" })`) — when the bug fix requires a corrective migration (schema needed an additional column the bug exposed, NOT NULL added without backfill, missing index causing the symptom, enum value never written, broken default, orphaned rows from a prior migration). Use this skill instead of hand-writing the migration so the fix gets the multi-phase deploy plan and data-integrity audit. Then dispatch a **data integrity review** (`task({ subagent_type: "general", description: "Review data integrity", prompt: "Review the migration + code diff for data integrity risks." })`).
- **realign** (`skill({ name: "realign" })`) — when the root cause is not a local bug but a domain-model mismatch: enum/state/vocabulary drift, persisted status value mismatch, lifecycle-state rename, or a state machine whose code and business meaning diverged.

In `production`, also invoke `skill({ name: "add-regression-test" })` unless explicitly skipped. If the patch touched UI files, run `skill({ name: "polish-ui" })` after the checks above unless the UI delta is copy-only.

---

## Response shape for first message

When invoked, structure the first response as:

```
**Trace:** <action> → <dispatch site at file:line> → <transport: HTTP/IPC/file> → <receiver at file:line> → <observed state at file:line>

**Runtime contract:**
- Endpoint: <full URL template>
- Auth: <header + source>
- Env vars required: <list with injection site>
- On-disk: <files written, paths>
- Logs/observation: <where, or "swallowed at file:line">
- Expected event/payload: <shape>

**Silent failure points found:** <list of fail-soft sites with file:line>

**Most likely causes (ranked):**
🟡 <hypothesis 1> — would manifest as <observable>
⚪ <hypothesis 2> — depends on <unknown>

**Single fastest diagnostic:** <one command or observation>, run it and paste the output.
```

Adapt headings to the situation, but every section above should appear or be explicitly noted as N/A.

---

## NEVER

- **NEVER list hypotheses without first stating the runtime contract.**
  **Instead:** Endpoint, env vars, file paths, log location go in message #1, before any "could be X, could be Y".
  **Why:** The user asking "what endpoint does it hit?" is a sign you front-loaded speculation over facts. Facts narrow the search; speculation expands it.

- **NEVER assert hook/integration behavior with confidence unless you've verified it in this session.**
  **Instead:** Mark with 🟡/⚪. If you said something with confidence and the user pushes back, re-verify; don't double down.
  **Why:** Tooling behavior (OpenCode hook approval, framework lifecycle, env propagation) varies by version. Overconfident claims send the user down dead-end branches and erode trust.

- **NEVER ask the user to test 3 hypotheses in parallel.**
  **Instead:** Pick the single observation that disambiguates fastest, ask for that, then iterate.
  **Why:** Each parallel test costs the user a context switch. One sharp diagnostic finishes the loop in one round trip.

- **NEVER theorize past runtime evidence the user has already pasted.**
  **Instead:** Read the literal output first. Shell errors, 4xx codes, empty env vars, missing files are usually verbatim in the paste.
  **Why:** The actual error beats any hypothesis. Skipping it wastes a round and signals you didn't read carefully.

- **NEVER ignore silent-failure patterns (`|| true`, empty `catch {}`, `>/dev/null 2>&1`).**
  **Instead:** Grep for them on the dispatch path and call them out as the prime suspect for "ran but didn't work".
  **Why:** These are the #1 cause of "code looks fine but the side effect never lands". They are also the easiest to fix temporarily for diagnosis (redirect to a log file).

- **NEVER assume the running process has the latest code.**
  **Instead:** For Electron main / long-lived workers / daemons, ask whether the process was restarted since the relevant code landed. HMR only reloads renderers.
  **Why:** Stale main-process code is invisible — the file on disk is correct, the running behavior isn't. Easy to chase for an hour.

- **NEVER trust a code comment, doc snippet, or prior memory about a third-party library's behavior at the bug's exact boundary.**
  **Instead:** Open the library's installed source (`node_modules/<pkg>/...`, vendored path, or git source) and read the function you're calling. Confirm what it does on the branch your code takes — especially early returns, what DOM/events it does or doesn't suppress, and what side effects it still emits when your handler short-circuits.
  **Why:** Library behavior at edge cases (modifier keys, error paths, lifecycle short-circuits) regularly diverges from comments and docs — e.g. a comment promised "ESC+CR is what `/terminal-setup` wires up", but the real bug was xterm's `_keyDown` not calling `preventDefault` on early return, so a phantom `keypress` re-emitted `\r`; 30 lines of installed source would have caught it in round one.

---

## Design note

This skill is intentionally single-file. Diagnostic decisions need full context in one read — splitting into `references/` would force a routing step exactly when the agent should be tracing code paths.

---

## Trigger question before responding

Before sending the first message, ask: **"If the user reads only this message and nothing else, do they know the exact endpoint, env vars, file paths, log locations, and the one command to run next?"** If not, the message is theory-heavy — add the contract.

---

## Post-step: /simplify

Once the bug is fixed and verified, run `skill({ name: "simplify" })` on the diff to clean up any duplication, magic numbers, or quick-fix shortcuts the patch introduced — without changing behavior.
