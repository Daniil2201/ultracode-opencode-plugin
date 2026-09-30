---
name: init-project
description: Scaffold a new project from scratch — init git, choose stack, generate modular-monolith structure, configure tooling (linter, formatter, lefthook, CI), and setup codegraph. Stack is chosen at invocation time (Go, Vue, React Native, Python, etc.). Always produces a modular monolith with clear module boundaries inside a single deployable unit. Trigger phrases — "new project", "scaffold project", "init project", "start a project", "create project", "/init-project", "/scaffold". Skip for — adding features to an existing project (use add-feature), one-off scripts, or experiments that don't need git/tooling/CI.
license: MIT
compatibility: opencode
metadata:
  requires_codegraph: false
---

> **Tool mapping (OpenCode):**
> - `question` tool for user prompts (not `AskUserQuestion`)
> - `task` tool for subagents (not `Agent` or `Task` subagent syntax)
> - `skill({ name: "..." })` to load other skills (not `Skill(skill="...", args="...")`)
> - `bash` for shell commands (git, npm, go, etc.)
> - `todowrite` for phase/progress tracking
>
> **Context rule:** This skill supersedes any prior skill instructions. Follow ONLY these instructions now. Read the user's goal and any mode/include/skip from the conversation context.

Read `mode=`, `include=`, `skip=` from conversation context. Default to `balanced` if not specified.

# Init Project

Scaffold a new project with the user's preferred setup: git, modular-monolith structure, stack-specific tooling, codegraph, and CI. The goal is to go from `mkdir` to the first `typecheck` green in one session — so the user starts coding against a working foundation, not a blank directory.

---

## Phase 1 — Clarify

Use `todowrite` to mark this phase as in_progress. Mark completed when done.

Ask the user (batched `question` call) covering:

1. **Project name** — directory name and module name
2. **Stack** — what language/framework. Options depend on what the user types (free-form), but suggest common: Go, Vue+Vite, React Native+Expo, Python, Elixir, Bun, or "custom (I'll describe)"
3. **Database** — which DB client library / ORM to include? (optional, "none" is valid)
4. **Docker** — scaffold a `Dockerfile` + `docker-compose.yml`?
5. **CI** — GitHub Actions workflow for check and test?
6. **Directory** — parent path (defaults to `$PWD` or the project's working directory)

After answers, confirm scope:

```
Project:     <name>
Stack:       <stack>
Database:    <db or none>
Docker:      <yes/no>
CI:          <yes/no>
Parent dir:  <path>
```

**Exit gate:** confirmed scope. Do not proceed without explicit confirmation.

---

## Phase 2 — Git init + base files

Use `todowrite` to mark this phase as in_progress. Mark completed when done.

Create the project directory, then init the foundation:

```bash
mkdir -p <parent>/<name>
cd <parent>/<name>
git init
```

### Base files (always)

Write `.gitignore` for the selected stack (common patterns — `node_modules/`, `.env`, `dist/`, `*.exe`, `.codegraph/`, etc.).

Write `AGENTS.md` with the user's standard guardrails (copy from `/home/acauhi/AGENTS.md` or `/home/acauhi/.config/opencode/instructions/*` — preference: project-specific AGENTS.md inheriting the global safety rules).

Write `CONTEXT.md` with:
- Project name and purpose (from Phase 1)
- Stack and key dependencies
- Architecture note: "Modular monolith — single deployable unit with clear module boundaries"
- Build/run/test commands (to be filled in Phase 4)

Write `README.md` with:
```markdown
# <name>

<description>

## Stack

<stack>

## Dev

```bash
# TODO: fill in Phase 4
```

## License

MIT
```

**Exit gate:** `git status` shows the base files. `git log --oneline` shows first commit (optional — commit or not based on user preference; default: stage but don't commit yet).

---

## Phase 3 — Stack scaffold

Use `todowrite` to mark this phase as in_progress. Mark completed when done.

Generate the project structure for the chosen stack. Modular-monolith layout: a single deployable unit with internal module boundaries (no microservices). Adapt the tooling to the stack.

### Go (Gin)

```bash
go mod init <name>
mkdir -p cmd/server internal/{application,domain,infrastructure,interfaces,shared} docs
```

Create `cmd/server/main.go` — empty Gin server with health endpoint.

Create `internal/interfaces/http/router.go` — Gin router setup.

Create `internal/domain/` — empty domain types package.

Create `Makefile` with standard targets: `lint`, `test`, `build`, `run`, `checkup-fast`, `checkup-full` (matching the user's hoje-eh-onde conventions).

If database was chosen: scaffold DB connection in `internal/infrastructure/db/`.

### Vue + Vite (backoffice)

```bash
npm create vite@latest . -- --template vue-ts  # or use pnpm
pnpm install
pnpm add vue-router pinia zod
pnpm add -D vitest @vue/test-utils eslint prettier tailwindcss postcss autoprefixer
```

Create modular structure under `src/`:
```
src/
  modules/       # domain modules, each with components/composables/views
  lib/           # shared utilities (api client, logger, validators)
  router/        # vue-router setup
  stores/        # pinia stores
  assets/        # static assets
  App.vue
  main.ts
  global.css
```

Create `AGENTS.md`, `CONTEXT.md`, README.md with stack-specific content.

Create `eslint.config.ts` + `.prettierrc` with the project's conventions.

### React Native + Expo (mobile)

```bash
npx create-expo-app@latest . --template blank-typescript
pnpm install
pnpm add nativewind zustand expo-router
pnpm add -D vitest @testing-library/react-native eslint prettier tailwindcss
```

Create modular structure under `src/`:
```
src/
  modules/       # feature modules
  lib/           # shared utilities
  app/           # expo-router pages
  components/    # shared components
```

If Expo Router is not desired, use React Navigation. Ask via `question`.

### Python

```bash
mkdir -p src/<name> tests docs
python3 -m venv .venv
.venv/bin/pip install pytest ruff mypy
```

Create `pyproject.toml` with ruff + mypy config + pytest runner.

Create modular structure:
```
src/<name>/
  domain/        # business logic
  infrastructure # DB, external clients
  interfaces/    # HTTP handlers, CLI
  shared/        # shared types, utils
tests/
```

### Custom stack

If the user chose "custom", ask them to describe the directory structure and dependency setup they want. Create the layout they describe. Write `setup.sh` (or equivalent) with the install commands they specified.

---

**Exit gate:** `go build ./...` / `tsc --noEmit` / `npm run build` / equivalent passes. The scaffold is green before tooling is added.

---

## Phase 4 — Tooling setup

Use `todowrite` to mark this phase as in_progress. Mark completed when done.

### Linter + formatter

Configure with stack-appropriate defaults:

| Stack | Linter | Formatter |
|---|---|---|
| Go | `go vet` + `gofmt` / `golangci-lint` | `gofmt -s` + `goimports` |
| Vue/TS | ESLint with project's existing config | Prettier |
| React Native/Expo | ESLint with project's existing config | Prettier |
| Python | Ruff | Ruff format |

### Git hooks (lefthook)

Install lefthook and create `lefthook.yml`:

```yaml
pre-push:
  commands:
    check:
      run: make checkup-fast  # or equivalent

pre-commit:
  commands:
    lint:
      run: npx eslint --fix --cache  # or gofmt / ruff check
```

```bash
lefthook install
```

### CI (GitHub Actions)

If Phase 1 opted for CI, create `.github/workflows/check.yml`:

```yaml
name: check
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5  # or node/python
      - run: make checkup-fast  # or npm run check
```

For Go, also add vulncheck step matching the user's hoje-eh-onde pattern.

### Update README

Fill in the `## Dev` section with exact commands: `make run`, `make test`, `make lint`, etc.

**Exit gate:** `lefthook --help` works. CI file exists (if opted). Makefile / npm scripts are populated.

---

## Phase 5 — Codegraph init

Use `todowrite` to mark this phase as in_progress. Mark completed when done.

```bash
codegraph init -i
```

If codegraph is not installed, surface: "codegraph not found — skip or install?" via `question` tool. Skip if user declines.

**Exit gate:** `.codegraph/` directory exists and `codegraph status` reports the indexed files.

---

## Phase 6 — Verify

Use `todowrite` to mark this phase as in_progress. Mark completed when done.

Full verification sweep:

1. **Build / typecheck** — `go build ./...` / `tsc --noEmit` / `ruff check` / equivalent
2. **Lint** — `make lint` / `npm run lint`
3. **Test** — `make test` / `npm test` (should be zero tests or one placeholder)
4. **Lefthook** — verify hooks installed: `lefthook run pre-commit 2>&1 || true` (may warn about unstaged files, not a failure)
5. **CI dry-run** — if GitHub Actions were set up, read the file to verify syntax; don't push

If any step fails, fix and re-run. Do not declare done with a red check.

---

## NEVER

- **NEVER scaffold microservices as default**
  **Instead:** Always produce a modular monolith — one deployable with clear internal module boundaries.
  **Why:** Monolith-first avoids distributed-monolith syndrome. Splitting later is cheaper than coordinating N services from day one.

- **NEVER skip AGENTS.md or CONTEXT.md**
  **Instead:** Write both in Phase 2. They're the project's contract for future agent sessions.
  **Why:** Every `/continue` and `/fix-bug` session reads these files first. Without them, each session starts blind.

- **NEVER commit scaffolding commits without the user's approval**
  **Instead:** Stage everything in Phase 6 and present as a single "ready to commit?" prompt. Let the user decide.
  **Why:** Scaffold commits are noisy. The user may want to amend the structure before the first commit.

- **NEVER install global tooling without asking**
  **Instead:** Use `npx`, `go run`, or `brew` — ask before `npm install -g` / `go install`.
  **Why:** Global tooling has version conflicts the user has to resolve later.

- **NEVER overwrite an existing directory without confirming**
  **Instead:** Check if `<parent>/<name>` exists. If it does, ask: "Directory already exists — scaffold inside it? Overwrite? Choose different name?"
  **Why:** Destructive scaffolding is unrecoverable.

---

## Post-step: /simplify

After scaffolding completes, run `skill({ name: "simplify" })` against the generated files to check for duplicate config boilerplate and inconsistent patterns.
