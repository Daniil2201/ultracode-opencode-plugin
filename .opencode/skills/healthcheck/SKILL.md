---
name: healthcheck
description: >
  Health check and auto-update for the opencode binary, MCPs, LSPs, and plugins configured in opencode.
  Verifies opencode version against GitHub releases, checks MCP/LSP/plugin versions, connectivity, and binary availability. Auto-updates outdated packages. Use when user says "healthcheck", "check health", "are mcp/lsp updated", "update mcp", "update lsp", "check plugins", "/healthcheck", "opencode health", or "check opencode version".
---

# Healthcheck — opencode, MCPs, LSPs & Plugins

## Step 1: Read config

Read `~/.config/opencode/opencode.jsonc` (or `opencode.json` if `.jsonc` absent).
Extract:
- **MCPs**: keys under `mcp`
- **LSPs**: value of `lsp` (boolean or object)
- **Plugins**: entries under `plugin` array

Also read project-level `./opencode.json` if it exists and has additional MCPs/LSPs/plugins.

## Step 2: Check opencode binary

### 2a. Detect current version
```bash
# Primary: wrapper script delegates to real binary
REAL_BIN="${OPENCODE_REAL_BIN:-$HOME/.opencode/bin/opencode}"
if [[ -x "$REAL_BIN" ]]; then
  CURRENT=$("$REAL_BIN" --version 2>/dev/null | head -1)
else
  CURRENT=$(opencode --version 2>/dev/null | head -1)
fi
```

### 2b. Fetch latest version from GitHub
```bash
LATEST=$(curl -sf https://api.github.com/repos/anomalyco/opencode/releases/latest \
  | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/')
```

### 2c. Compare
- If `CURRENT` < `LATEST` → mark **OUTDATED**
- If `CURRENT` = `LATEST` → mark **OK**
- If binary not found → mark **MISSING**

### 2d. Auto-update (if OUTDATED or MISSING)
Run the official install script:
```bash
curl -fsSL https://opencode.ai/install | bash
```
Report before and after versions. If install fails, report error and suggest manual update from https://github.com/anomalyco/opencode/releases.

## Step 3: Check MCPs

For each MCP entry:

### 3a. Detect package name
- If `command` starts with `npx -y <pkg>` → package = `<pkg>`
- If `command` starts with a binary name (e.g. `codegraph serve --mcp`) → package = binary name
- If `type: "remote"` → skip version check, only test URL reachability

### 3b. Check version
```bash
# Latest on registry
npm view <package> version 2>/dev/null

# For global binaries
<binary> --version 2>/dev/null

# For npx packages — find cached version
find ~/.npm/_npx -name "package.json" -path "*<package>*" 2>/dev/null \
  -exec grep '"version"' {} + | head -1
```

### 3c. Compare
- If local version < latest → mark **OUTDATED**
- If local version = latest → mark **OK**
- If binary not found → mark **MISSING**
- If `enabled: false` → mark **DISABLED**

### 3d. Auto-update (if OUTDATED or MISSING)
- For `npx -y` packages: no action needed (npx fetches latest on run), but report the version gap
- For global npm binaries: run `npm install -g <package>@latest`
- For pip/uv packages (detect via `uv tool list`): run `uv tool upgrade <package>`
- For other non-npm binaries: report the manual update command

### 3e. Connectivity test (if enabled)
- For local MCPs: attempt a simple MCP ping via the command with timeout
- For remote MCPs: `curl -sf <url>` with timeout

### 3f. Agentmemory-specific checks (if agentmemory MCP is configured)
For any MCP entry whose command contains `@agentmemory/mcp`:

**API backend check** — testa se o processo está escutando na porta (confiável, não depende de rota HTTP específica):
```bash
PORT=3111
if lsof -ti :$PORT >/dev/null 2>&1; then
  echo "api:ok"
else
  echo "api:not responding"
fi
```

**Version check:**
```bash
# npm registry latest
npm view @agentmemory/mcp version 2>/dev/null
```
If installed via npx, version is fetched fresh each run; report registry version.

### 3g. Codegraph-specific checks (if codegraph MCP is configured)
For any MCP entry whose binary is `codegraph`:

**Binary version:**
```bash
codegraph --version 2>/dev/null
```

**Latest version:**
```bash
npm view @colbymchenry/codegraph version 2>/dev/null
```
Auto-update: `npm install -g @colbymchenry/codegraph@latest`

### 3h. Headroom-specific checks (if headroom MCP is configured)
For any MCP entry whose binary is `headroom`:

**Binary & version:**
```bash
headroom --version 2>/dev/null
uv tool list 2>/dev/null | grep headroom-ai
```
Compare local version vs latest on PyPI:
```bash
# Latest on PyPI
curl -s https://pypi.org/pypi/headroom-ai/json | python3 -c "import sys,json; print(json.load(sys.stdin)['info']['version'])"
```
Auto-update: `uv tool upgrade headroom-ai`

**Proxy check** — look for `HEADROOM_PROXY_URL` in the MCP's `env` block first, then check `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`:
```bash
# Read proxy URL from the MCP env in opencode config
# Fallback to default port
PROXY_URL="${HEADROOM_PROXY_URL:-http://127.0.0.1:8787}"
curl -sf "$PROXY_URL/livez" >/dev/null 2>&1 && echo "proxy:running" || echo "proxy:not detected"
```

**Stats snapshot** from proxy:
```bash
curl -sf http://127.0.0.1:8787/stats 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
s=d.get('summary',{})
c=s.get('compression',{})
print(f\"Tokens saved: {c.get('total_tokens_removed',0):,}  |  Ratio: {c.get('avg_compression_pct',0):.1f}%\")
" 2>/dev/null || echo "stats unavailable"
```

## Step 4: Check LSPs

### 4a. If `lsp: true` (built-in)
Check opencode's built-in LSP servers:
```bash
which typescript-language-server 2>/dev/null && typescript-language-server --version
which vscode-json-languageserver 2>/dev/null && vscode-json-languageserver --version
which bash-language-server 2>/dev/null && bash-language-server --version
```
For each found: compare version vs `npm view <pkg> version`.

### 4b. If `lsp` is an object with custom commands
Check each custom LSP command exists in PATH and report version.

### 4c. Auto-update
- Run `npm install -g <package>@latest` for outdated global LSPs

## Step 5: Check plugins

For each plugin entry:
- If string starts with `./` or `file://` → local file relative to config dir, resolve path and check exists
- Example: OpenCode v2 auto-discovers `~/.config/opencode/plugins/guardrails.ts`; configured local entries must point to a directory through `plugins`, not to a single file.
- If npm package (e.g. `opencode-gemini-auth`) → check `npm view <pkg> version` vs installed
- If tuple `[name, opts]` → check name as npm package
- Report status: **OK** / **MISSING** / **OUTDATED**

## Step 6: Report

Print a formatted table:

```
=== opencode Healthcheck ===

opencode:
  ✅ v1.17.7 (ok)

MCP Servers:
  ✅ agentmemory     v0.9.27 (npx, fresh)          api:ok
  ✅ codegraph       v0.9.9 → v1.0.0   UPDATED
  ✅ headroom        v0.24.0 (ok)
  ⚠️  old-server      (disabled)

LSP Servers:
  ✅ typescript-language-server  v5.3.0 (ok)
  ✅ vscode-json-languageserver  v3.0.0 (ok)

Plugins:
  ✅ ultracode.ts               (~/.config/opencode/plugins/ultracode.ts, exists)

Summary: opencode v1.17.7, 3 MCPs, 2 LSPs, 2 plugins — all healthy
```

## Rules
- Never force-delete or rm anything
- If npm install fails, report error and suggest manual fix
- If a server is disabled, skip connectivity test but report it
- Use colored output when terminal supports it
- Dry run first (show what would update), then execute on user confirmation or if running in auto mode
- **Проверка индекса Codegraph не выполняется.** Скилл проверяет только версию бинаря и сравнивает с registry. Index health check был удалён, чтобы избежать случайной инициализации.
