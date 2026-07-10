# Draft: Vercel Migration — HTTP Match + Serverless Export

**intent**: clear
**review_required**: false
**status**: awaiting-approval
**pending**: write `.omo/plans/vercel-migration-http-match.md`

## Approach

Convert the WebSocket `/api/ws/jobs` match flow to a plain HTTP `POST /api/jobs/search` (already exists). Remove the WebSocket controller, the `ws` dependency, and the WS attachment from the server. Export the Express app as a Vercel-compatible default export. Add `vercel.json` for function config. The existing `POST /jobs/search` already calls `JobApplicationController.Search()` which runs the full match pipeline — no new endpoint needed.

## Ledger

### What stays
- `POST /api/jobs/search` — already does the match HTTP-sync, returns `{ status, jobs: RankedJob[], source, generated_at, cache_key }`
- All controller logic (`jobMatcher.ts`, `jobApplication.ts`) — unchanged
- Cache layer (Redis) — unchanged
- Auth layer — unchanged

### What goes
- `controller/jobsWsController.ts` — entire file deleted
- `ws` + `@types/ws` — removed from package.json
- `test/jobsWs.e2e.test.ts` — replaced with HTTP match test
- WS protocol from `API.md`
- WebSocket live smoke from `scripts/e2e-live.ts`

### What changes
- `app.ts` — remove WS import/attach, export `app` as default, simplify `AppDeps`
- `index.ts` — export Vercel handler, guard `listen()` behind `!process.env.VERCEL`
- `vercel.json` — create with function maxDuration and build config
- `API.md` — HTTP match request/response documented, WS removed
- `package.json` — remove `ws`/`@types/ws`, add `build` script
- `scripts/e2e-live.ts` — replace WS match with HTTP POST
- `test/jobsWs.e2e.test.ts` → `test/jobsHttp.e2e.test.ts`

### Must-NOT-Have
- NO new endpoint — reuse existing `POST /jobs/search`
- NO change to `jobMatcher.ts`, `jobApplication.ts`, `jobMatcherService` types
- NO change to the scoring formula or cache behavior
- NO change to auth or resume controllers

## Approval Gate

Brief presented above. Waiting for user's explicit okay before writing the full `.omo/plans/vercel-migration-http-match.md`.
