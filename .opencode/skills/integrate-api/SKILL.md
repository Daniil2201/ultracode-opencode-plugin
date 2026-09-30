---
name: integrate-api
description: Scaffold integration with an external API — generate a typed client, wire retry/rate-limit/error-handling, add structured-logging observability at the boundary, and write integration tests. Hybrid approach: tries OpenAPI spec first (oapi-codegen, kubb, openapi-generator), falls back to prompt-driven typed wrapper when no spec is available. Detects the project stack (Go Gin, Vue+Vite, React Native/Expo, etc.) and generates stack-appropriate code. Trigger phrases — "integrate with X", "add Stripe", "connect to GitHub API", "webhook from Discord", "call external API", "/integrate-api", "scaffold API client". Skip for — internal/private API boundaries within the same project (use add-observability), pure mock/stub work, or changes where the external API is already fully typed and instrumented.
license: MIT
compatibility: opencode
metadata:
  requires_codegraph: true
---

> **Tool mapping (OpenCode):**
> - `question` tool for user prompts (not `AskUserQuestion`)
> - `task` tool for subagents (not `Agent` or `Task` subagent syntax)
> - `skill({ name: "..." })` to load other skills (not `Skill(skill="...", args="...")`)
> - `codegraph_explore`, `codegraph_search` for codebase exploration (preferred)
> - `todowrite` for phase/progress tracking
> - `grep`, `glob`, `read`, `bash` as fallback when `.codegraph/` not initialized
>
> **Context rule:** This skill supersedes any prior skill instructions. Follow ONLY these instructions now.

Read `mode=`, `include=`, `skip=` from conversation context. Default to `balanced` if not specified.

# Integrate API

Generate a typed, observable integration client for an external API — so every call is typed, every error is logged, and every failure is retried. The alternative (ad-hoc `fetch` in a handler) produces untyped calls that silently fail.

---

## Phase 1 — Clarify

Use `todowrite` to mark this phase as in_progress. Mark completed when done.

Ask the user (batched `question` call) covering:

1. **Target API** — name and purpose (e.g., "Stripe Payments", "GitHub Issues API")
2. **Spec availability** — OpenAPI/Swagger URL, local spec file path, or "no spec, describe manually"
3. **API auth** — API key header, Bearer token, OAuth, mTLS, or none
4. **Endpoints needed** — which specific operations (create payment, list repos, send message, etc.)
5. **Stack target** — which project/service in the workspace gets this integration (Go API, Vue backoffice, React Native mobile, etc.)
6. **Persistence** — should responses be cached? Stored in DB? Or purely pass-through?
7. **Rate limits** — does the API have known rate limits the client should respect?

If spec is available: note the URL/path and proceed to Phase 2.
If no spec: skip to Phase 3 (prompt-driven).

**Exit gate:** you can name the external API, auth method, target stack, and which endpoints. Do not proceed without confirmed endpoints.

---

## Phase 2 — Spec-driven client generation

Use `todowrite` to mark this phase as in_progress. Mark completed when done.

Fetch or read the OpenAPI spec. Use `bash` to download from URL or `read` for local file. Inspect the spec structure — confirm it covers the endpoints from Phase 1.

### Codegen by stack

| Stack | Tool | Strategy |
|---|---|---|
| Go (no framework constraints) | `oapi-codegen` | Generate typed client struct + models. Wire into project's existing HTTP client pattern. |
| Go (Gin) | `oapi-codegen` with Gin integration | Generate server interface + client separately. Use client side only for external API calls. |
| TS/JS (Vue, Vite, any Node) | `kubb` or `openapi-typescript` | Generate typed fetch/ky wrapper. `kubb` preferred if available (generates full client + zod schemas). |
| TS/JS (React Native / Expo) | `openapi-typescript` + manual wrapper | Same as above but avoid Node-specific deps. Generate types only, wrap in a thin fetch adapter. |
| Python | `openapi-python-client` | Generate typed client package. |
| No match / spec too complex | Manual typed wrapper | Use Phase 3's template as fallback. |

If the codegen tool is not installed, propose installing it via `question` with options: (a) install tool, (b) use manual wrapper instead, (c) skip codegen.

After generation, inspect the output:
- Does it include the endpoints from Phase 1?
- Does auth injection exist (custom header, Bearer token)?
- Are the response types correctly typed?

**Exit gate:** generated client files exist, types compile, and the auth mechanism is wired. Do not proceed to Phase 4 without a compilable client.

---

## Phase 3 — Prompt-driven manual wrapper (fallback)

Use `todowrite` to mark this phase as in_progress. Mark completed when done.

Run only if Phase 2 is skipped (no spec, spec too complex, user chose manual).

For each endpoint from Phase 1, generate a typed wrapper function following the project's existing HTTP call patterns:

### Go template

```go
// Created in internal/infrastructure/<api>/client.go
package <api>

type Client struct {
    baseURL    string
    httpClient *http.Client
    apiKey     string
}

type <Entity> struct {
    ID   string `json:"id"`
    Name string `json:"name"`
    // ... fields from Phase 1 description
}

func (c *Client) <Operation>(ctx context.Context, params <Params>) (*<Entity>, error) {
    // — boundary: outbound-http —
    log.DebugContext(ctx, "event", "<api>.<operation>.dispatched", "params", params)
    
    req, _ := http.NewRequestWithContext(ctx, "POST", c.baseURL+"/endpoint", jsonBody(params))
    req.Header.Set("Authorization", "Bearer "+c.apiKey)
    req.Header.Set("Content-Type", "application/json")
    
    resp, err := c.httpClient.Do(req)
    if err != nil {
        log.ErrorContext(ctx, "event", "<api>.<operation>.failed", "error", err)
        return nil, fmt.Errorf("<api> <operation>: %w", err)
    }
    defer resp.Body.Close()
    
    if resp.StatusCode >= 400 {
        body, _ := io.ReadAll(resp.Body)
        log.ErrorContext(ctx, "event", "<api>.<operation>.failed", "status", resp.StatusCode, "body", string(body))
        return nil, fmt.Errorf("<api> <operation>: %d %s", resp.StatusCode, string(body))
    }
    
    var result <Entity>
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, fmt.Errorf("decode <api> <operation>: %w", err)
    }
    
    return &result, nil
}
```

### TypeScript template (Vue / Node)

```typescript
// Created in src/lib/<api>/client.ts
import { log } from '@/lib/logger'  // or project's logger

export interface <Entity> {
  id: string
  name: string
  // ... fields from Phase 1
}

export interface <Operation>Params {
  // ... params from Phase 1
}

export async function <operation>(params: <Operation>Params): Promise<<Entity>> {
  log.info({ event: '<api>.<operation>.dispatched', params })
  
  const res = await fetch(`https://api.external.com/endpoint`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${import.meta.env.VITE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  })
  
  if (!res.ok) {
    const body = await res.text()
    log.error({ event: '<api>.<operation>.failed', status: res.status, body })
    throw new Error(`<api> <operation>: ${res.status} ${body}`)
  }
  
  const data: <Entity> = await res.json()
  return data
}
```

For **React Native** (Expo): same pattern, use `import.meta.env` or a config object, avoid Node-specific deps.

**Exit gate:** one typed wrapper function per endpoint from Phase 1. Typecheck passes. Auth is wired.

---

## Phase 4 — Wire error handling, retry, rate-limit

Use `todowrite` to mark this phase as in_progress. Mark completed when done.

Add to the client from Phase 2 or 3:

### Retry with exponential backoff

Wrap the HTTP call in a retry loop. Use the project's existing patterns:
- **Go**: `github.com/cenkalti/backoff/v4` or manual loop
- **TS**: inline retry with `setTimeout` or `async-retry` package

If neither project has retry logic, implement a minimal inline retry:

```typescript
// Go — inside client.go
func (c *Client) retry(ctx context.Context, fn func() error) error {
    var err error
    for attempt := 0; attempt < 3; attempt++ {
        if err = fn(); err == nil {
            return nil
        }
        log.WarnContext(ctx, "event", "<api>.retry", "attempt", attempt+1, "error", err)
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(time.Duration(math.Pow(2, float64(attempt))) * time.Second):
        }
    }
    return fmt.Errorf("<api> retry exhausted: %w", err)
}
```

### Rate-limit awareness

If Phase 1 identified rate limits, add:
- **Pre-call throttle**: check elapsed since last call, sleep if under limit
- **Header-based**: if API returns `X-RateLimit-Remaining`, read it after each call and back off

### Timeout

Every HTTP call must have a context-derived timeout (Go) or `AbortSignal` (TS). If the generated client doesn't pass a context/signal, wrap it.

### Silent-failure check

Grep the generated client for `|| true`, empty `catch {}`, `>/dev/null 2>&1` — if any exist, replace with logged catches (see `add-observability` Phase 4 recipes). The client must never fail silently.

**Exit gate:** retry loop + timeout verified. A single failing endpoint produces a logged error, not a hang.

---

## Phase 5 — Observability at the boundary

Use `todowrite` to mark this phase as in_progress. Mark completed when done.

Every external API call must produce structured logs at:
- **Dispatch** — `.dispatched` event with method, path, params (redact secrets)
- **Success** — `.completed` event with status, duration
- **Failure** — `.failed` event with status, error, response body (truncated)

If the project has structured logging, use it. If not, invoke `skill({ name: "add-observability" })` first — this skill creates typed clients with no evidence trail if the logger itself doesn't exist.

Add a one-line comment at the client definition: `// Logs: stdout (dev) | <path> (prod via LOG_FILE env)`

**Exit gate:** `rg 'event:\s*"<api>\.' src/lib/<api>/` returns the dispatch/failure sites. The trail is greppable.

---

## Phase 6 — Integration test

Use `todowrite` to mark this phase as in_progress. Mark completed when done.

Write a test that exercises the new client against a **mocked HTTP server** — never against the real external API in unit tests.

### Go — `httptest.Server`

```go
func TestClient_CreatePayment(t *testing.T) {
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        assert.Equal(t, "POST", r.Method)
        assert.Equal(t, "Bearer test-key", r.Header.Get("Authorization"))
        w.WriteHeader(http.StatusCreated)
        json.NewEncoder(w).Encode(map[string]string{"id": "pi_123"})
    }))
    defer srv.Close()

    client := NewClient(srv.URL, "test-key")
    result, err := client.CreatePayment(context.Background(), &PaymentParams{...})
    assert.NoError(t, err)
    assert.Equal(t, "pi_123", result.ID)
}
```

### TypeScript — `msw` or `nock`

Use msw if the project already has it. Otherwise use a simple `fetch` mock via vitest:

```typescript
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

const server = setupServer(
  http.post('https://api.external.com/endpoint', ({ request }) => {
    return HttpResponse.json({ id: 'pi_123' }, { status: 201 })
  }),
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

it('creates payment', async () => {
  const result = await createPayment({ amount: 1000 })
  expect(result.id).toBe('pi_123')
})
```

Place the test next to the client file following the project's convention (`_test.go` suffix, `.test.ts` sibling, or `__tests__/` directory). Run it. If the project has no test harness, invoke `skill({ name: "write-tests" })` first.

**Exit gate:** test passes. The mock exercises auth, request body, and response parsing.

---

## Phase 7 — Verify the integration contract

Use `todowrite` to mark this phase as in_progress. Mark completed when done.

Before declaring done:
1. Run `typecheck` / build — confirms types compile
2. Run the test from Phase 6 — confirms mock-level correctness
3. If possible, trigger one real API call (with user-provided credentials) to confirm the wire path works end-to-end. Log the response status. Do not commit real credentials.
4. If end-to-end can't run (sandbox only), document the manual verification step.

**Exit gate:** typecheck + test green. Real or mocked wire path confirmed.

---

## NEVER

- **NEVER commit real API keys, tokens, or secrets into the codebase**
  **Instead:** Use env vars, `.env.example`, or a config system. Never inline credentials in generated code.
  **Why:** Generated client code is easy to commit without review. Leaked secrets are the most expensive mistake this skill can make.

- **NEVER generate an untyped client — even without a spec**
  **Instead:** Write typed request/response interfaces in the prompt-driven wrapper. A raw `any` fetch defeats the purpose of the skill.
  **Why:** The whole point is typed API calls. An untyped wrapper is just `fetch` with extra ceremony.

- **NEVER skip observability because "it's just one endpoint"**
  **Instead:** Add `event: "<api>.<operation>.(dispatched|failed)"` at the boundary even for a single endpoint. The log line costs nothing and saves `fix-bug` a hypothesis round.
  **Why:** External APIs are the most common source of silent integration failures. The first question `fix-bug` asks is "did the call leave the server?" — the log line answers it in one grep.

- **NEVER ship the client without at least one test against a mock**
  **Instead:** Follow Phase 6's templates. Even a single "created successfully" test verifies auth wiring, request marshalling, path construction, and response parsing — every one of which will be wrong the first time.
  **Why:** The first call to a new integration client never works. The mock catches serialization/auth/URL bugs in <1s instead of the user discovering them in staging.

- **NEVER add retry without timeout**
  **Instead:** Always wrap the HTTP call in a context-derived timeout before entering the retry loop. A stuck connection with infinite retries = a stuck goroutine forever.
  **Why:** Retry-without-timeout is the top reason "the API recovered but my server is still hung."

---

## Post-step: /simplify

After the client lands and tests pass, run `skill({ name: "simplify" })` against the integration files to consolidate repeated patterns (header construction, retry loops, error formatting) into shared helpers.

## Post-step: /polish-ui (UI-boundary only)

If the integration surfaces data in a new UI component (e.g., a "Connected accounts" panel), run `skill({ name: "polish-ui" })`.
