# Vercel Migration — HTTP Match + Serverless Export

> **Goal**: Convert WebSocket match flow to HTTP sync, remove WS dependency, export Express app as Vercel serverless handler.

## TL;DR (For humans)

- HTTP `POST /api/jobs/search` already returns ranked match results — we keep it, delete the WebSocket wrapper
- Remove `ws` package, `jobsWsController.ts`, and WS test
- Export `app` from `app.ts` as default for Vercel
- Guard `server.listen()` behind VERCEL env check in `index.ts`
- Update API.md, smoke script, and tests

---

## TODO

### T1: Remove WebSocket controller and update app.ts
- Delete `controller/jobsWsController.ts`
- Remove `import { attachJobsWebSocket }` and its call from `app.ts`
- Remove `ws` field from `AppDeps` type
- Add `export default app` to `app.ts` for Vercel

**Acceptance**: `app.ts` has no reference to `ws`, `WebSocketServer`, or `attachJobsWebSocket`. Exports `default app`.

### T2: Update index.ts with Vercel guard
- Guard `server.listen()` behind `if (!process.env.VERCEL)`
- Import `app` from `app.ts` for Vercel handler export

**Acceptance**: VERCEL env set → no `listen()`. No VERCEL → `listen()` on port as before.

### T3: Create vercel.json
```json
{
  "functions": {
    "api/**/*.ts": { "maxDuration": 30 }
  }
}
```

**Acceptance**: `vercel.json` exists at project root with valid JSON.

### T4: Remove ws dependency from package.json
- Remove `"ws"` and `"@types/ws"` from dependencies
- Add `"build": "bun build ./index.ts --outdir ./dist"` script

**Acceptance**: `package.json` has no `ws` or `@types/ws`.

### T5: Update API.md — WS → HTTP match docs
- Remove WebSocket section (`## Jobs WebSocket`)
- Rename existing `search` section to `match`
- Document that `POST /api/jobs/search` returns async results with `score`, `matched_skills`, `missing_skills`, `rank_reasons`
- Update Base URL from Render to Vercel

**Acceptance**: No mention of WebSocket in API.md. Match endpoint documented correctly.

### T6: Replace WS test with HTTP match test
- Delete `test/jobsWs.e2e.test.ts`
- Create `test/jobsHttp.e2e.test.ts` that:
  - Tests `POST /jobs/search` through `createApiRouter` with fake auth/filters
  - Asserts response has `jobs: []`, first job has `score`, `matched_skills`, `rank_reasons`
  - Asserts `source` is `"cache"` or `"computed"`
  - Uses existing `createFakeDatabase` and `createFakeSearchService` helpers

**Acceptance**: `bun test` passes (4 tests). HTTP match test covers the flow.

### T7: Update e2e-live.ts — replace WS with HTTP
- Remove `import { WebSocket } from "ws"` and `import type { RawData } from "ws"`
- Remove `waitForMessage()` function
- Remove entire WebSocket block (lines 117-143)
- Add HTTP match call via `POST /api/jobs/search` with auth header and filters
- Log the match results

**Acceptance**: Script compiles without `ws` import. Match uses `fetch` POST.

---

## Final Verification Wave

### F1: Code review
- All changed files reviewed line-by-line
- No dangling WS references
- `export default app` is correct for Vercel

### F2: Build check
- `bun build ./index.ts --no-bundle` exits 0
- `bunx tsc --noEmit` exits 0

### F3: Test suite
- `bun test` passes (4 tests)
- HTTP match test verifies score, matched_skills, rank_reasons

### F4: Dependency audit
- No `ws` in node_modules or package-lock/bun.lock after install
- No `WebSocket`/`WebSocketServer` references in production code
