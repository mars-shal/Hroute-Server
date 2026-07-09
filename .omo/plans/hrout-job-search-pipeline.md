# hrout-job-search-pipeline — Work Plan

## TL;DR (For humans)

**What you'll get:** A working backend that crawls Nigerian job sites → extracts jobs via Groq → embeds them locally via Xenova/transformers → stores in Supabase pgvector → matches against your CV → pushes results via WebSocket. Three build waves, each produces something testable.

**Why this approach:** Build the core loop (crawl→extract→embed→store) with ONE URL before scaling to many URLs. This de-risks every downstream decision — embedding dimension, schema design, extraction prompt shape, error handling — before you invest in crawling hundreds of pages.

**What it will NOT do (v1 scope):**
- No auto-apply to jobs
- No mobile app frontend (this is purely the backend API)
- No multi-user auth/session management beyond user_id (simplified for now)
- No sophisticated job dedup beyond URL matching
- No continuous background crawl (only on-demand or simple setInterval)

**Effort:** ~10-14 days of focused solo work. Wave 1 ~4 days, Wave 2 ~4 days, Wave 3 ~4 days.

**Risk:** The biggest risk is Groq rate limits batching 100+ pages. Mitigated by batching with delays and a simple retry queue.

**Decisions made:**
| Decision | Choice |
|----------|--------|
| Embedding | `@xenova/transformers` with `all-MiniLM-L6-v2` (384-dim, local, free) |
| LLM extraction | Groq (via `groq-sdk`) |
| Crawler | Firecrawl (already wired, API key in `.env`) |
| Database | Supabase + pgvector |
| Cache | Redis (via `bun` built-in or `ioredis`) |
| Real-time | WebSocket (via `ws` with Express) |
| Web framework | Express (already in dependencies) |
| Resume format | Plain text + LLM extraction (PDF parsing deferred) |

## Scope

**IN:**
- Seed URL list → Firecrawl crawl → markdown output
- Groq extraction: raw markdown → structured Job object (title, company, location, description, skills, remote_status, salary_range, apply_url, posted_date, source_site)
- Xenova embedding of structured job data → 384-dim vector
- Supabase pgvector storage + HNSW index
- Resume upload (text) → LLM extracts structured profile → Xenova embed → Redis cache
- Vector similarity search → ranked job results with match score + missing skills list
- WebSocket delivery of matched jobs to frontend
- Application CRUD (save, apply, interview, offer, reject) with status machine
- URL dedup via Redis (seen URL → skip with TTL)

**OUT:**
- PDF resume parsing (accept text only for v1)
- OAuth / auth provider integration (simple user_id-based for v1)
- Job board auto-discovery via web search (use curated seed list)
- Automated scheduling / cron (use simple `setInterval` for v1)
- Frontend / mobile app
- Auto-apply
- Payment / billing

## Verification strategy

Every todo must pass:
1. **Happy path:** The intended operation works with valid input → evidence = console output + DB row exists
2. **Failure path:** The operation handles invalid/missing input gracefully → evidence = error logged, no crash, sensible error response
3. **Idempotency where required:** Running the same operation twice does NOT duplicate data

Test via:
- `bun run index.ts` for server smoke test
- Direct `curl` / WebSocket client for endpoint testing
- `bun test` for extraction + embedding unit tests (validation of output shape)
- Supabase dashboard to verify rows + vectors

## Execution strategy

Three sequential waves, each building on the previous. No parallel waves — Wave 2 assumes Wave 1's core loop works.

### Wave 1: Core loop (crawl → extract → embed → store)
Prove ONE job URL can go through the entire pipeline and come out stored as a vector in Supabase.

### Wave 2: Scale + match
Take the proven core loop and make it work for many URLs, with resume-based matching.

### Wave 3: Delivery + UX
Add WebSocket push, application tracking, and state machine.

---

## Todos

### Wave 1 — Foundation (core loop)

---

#### Todo 1.1: Set up Supabase client + pgvector schema

**References:**
- `model/database.ts` (exists, currently a comment stub)
- Supabase JS SDK v2: `@supabase/supabase-js`
- pgvector: `CREATE EXTENSION vector;`

**Actions:**
1. `bun add @supabase/supabase-js`
2. Create `model/database.ts` with Supabase client init from env vars (`SUPABASE_URL`, `SUPABASE_ANON_KEY`)
3. Write SQL migration (run via Supabase dashboard SQL editor):
   - `CREATE EXTENSION IF NOT EXISTS vector;`
   - Table `jobs`: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `title TEXT NOT NULL`, `company TEXT NOT NULL`, `location TEXT`, `description TEXT`, `skills TEXT[]`, `remote_status TEXT`, `salary_range TEXT`, `apply_url TEXT`, `source_url TEXT UNIQUE NOT NULL`, `source_site TEXT`, `posted_date TIMESTAMP`, `crawled_at TIMESTAMP DEFAULT NOW()`, `raw_markdown TEXT`
   - Table `job_vectors`: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `job_id UUID REFERENCES jobs(id) ON DELETE CASCADE`, `embedding vector(384)`, `created_at TIMESTAMP DEFAULT NOW()`
   - Create HNSW index: `CREATE INDEX ON job_vectors USING hnsw (embedding vector_cosine_ops);`
   - Table `users`: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at TIMESTAMP DEFAULT NOW()`, `resume_text TEXT`, `resume_embedding vector(384)`, `skills TEXT[]`
   - Table `applications`: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `user_id UUID REFERENCES users(id)`, `job_id UUID REFERENCES jobs(id)`, `status TEXT CHECK(status IN ('saved','applied','interviewing','offer','accepted','rejected')) DEFAULT 'saved'`, `notes TEXT`, `deadline TIMESTAMP`, `created_at TIMESTAMP DEFAULT NOW()`, `updated_at TIMESTAMP DEFAULT NOW()`, `UNIQUE(user_id, job_id)`

**Acceptance criteria:**
- Supabase client connects and returns a valid response on query
- All tables exist in Supabase dashboard
- pgvector extension is enabled
- HNSW index on `job_vectors.embedding` exists

**QA:**
- Happy: `SELECT * FROM pg_extension WHERE extname='vector'` returns a row
- Failure: wrong env vars → client throws descriptive error, does not crash server

**Commit:** `feat: add supabase client and pgvector schema`

---

#### Todo 1.2: Set up Redis client

**References:**
- `utils/crawler.ts` (imports `redis` from `bun`)
- Bun built-in Redis: `Bun.Redis` or fallback to `ioredis`

**Actions:**
1. Create `model/redis.ts` — Redis client singleton
2. Connection via `REDIS_URL` env var (or `localhost` default for dev)
3. Export helper functions: `cacheGet(key)`, `cacheSet(key, value, ttlSeconds)`, `cacheExists(key)`, `cacheIncrement(key)`
4. TTL defaults: URL dedup = 7 days, resume cache = 1 hour

**Acceptance criteria:**
- Redis client connects on server start
- `cacheSet` and `cacheGet` roundtrip a value successfully
- `cacheExists` returns true/false correctly
- `cacheIncrement` atomically increments a counter

**QA:**
- Happy: set key → get key → returns value
- Failure: Redis unavailable → client logs warning, server continues (graceful degradation)
- Idempotent: setting same key twice overwrites correctly

**Commit:** `feat: add redis client with cache helpers`

---

#### Todo 1.3: Set up Groq LLM client + structured extraction

**References:**
- `model/LLM.ts` (exists, comment stub "initialises LLM for with groq")
- Groq SDK: `groq-sdk`
- Model: `llama-3.3-70b-versatile` (fast, 8k context, free tier)

**Actions:**
1. `bun add groq-sdk`
2. Implement `model/LLM.ts`:
   - Init Groq client from `GROQ_API_KEY` env var
   - `async function extractJobFromMarkdown(markdown: string): Promise<StructuredJob | null>`
   - System prompt: "You are a job listing parser. Extract structured data from the following job page markdown. Return ONLY valid JSON matching this schema: {title, company, location, description, skills: string[], remote_status: 'remote'|'hybrid'|'onsite'|'unknown', salary_range: string|null, apply_url: string|null, posted_date: string|null, source_site: string}. If the content is not a job listing, return null."
   - `async function extractProfileFromResume(text: string): Promise<StructuredProfile | null>`
   - System prompt for resume: "Extract structured profile data from this resume. Return JSON: {skills: string[], experience_years: number, top_roles: string[], locations_preferred: string[], remote_preference: 'remote'|'hybrid'|'onsite'|'not_specified'}."
3. Create `types/job.ts` with shared TypeScript interfaces: `StructuredJob`, `StructuredProfile`

**Acceptance criteria:**
- `extractJobFromMarkdown` returns valid `StructuredJob` when given a real job page markdown
- `extractJobFromMarkdown` returns `null` for non-job content (e.g., about page, privacy policy)
- `extractProfileFromResume` returns valid `StructuredProfile`
- Both functions handle Groq API errors gracefully (log + return null)

**QA:**
- Happy: feed a real Jobberman job page excerpt → receives parsed JSON with all fields
- Failure: feed garbage text → returns null, error logged
- Rate limit: Groq rate-limited → retry after 1s, max 3 retries

**Commit:** `feat: add groq LLM client with job and resume extraction`

---

#### Todo 1.4: Set up Xenova/transformers embedding pipeline

**References:**
- User choice: `@xenova/transformers`
- Model: `Xenova/all-MiniLM-L6-v2` → 384-dim vectors
- docs: https://huggingface.co/docs/transformers.js

**Actions:**
1. `bun add @xenova/transformers`
2. Create `model/embeddings.ts`:
   - Initialize pipeline ONCE (singleton, model load is expensive)
   - `async function embedText(text: string): Promise<number[]>`
   - `async function embedBatch(texts: string[]): Promise<number[][]>`
   - Normalize the embedding vector (unit vector for cosine similarity)
   - Cache model instance in module scope (loading on first call)
3. Model download on first call — ensure `~/.cache` or `./node_modules` location is gitignored

**Acceptance criteria:**
- `embedText("software engineer javascript react")` returns a Float32Array of length 384
- Vector values are finite numbers (no NaN, no Infinity)
- Similar texts produce similar vectors (cosine similarity > 0.8)
- `embedBatch` processes 5 texts in < 2 seconds on Render

**QA:**
- Happy: embed a job description → returns 384-dim vector
- Failure: empty string → returns zero vector, logs warning
- Performance: first call loads model (~2-3s), subsequent calls are fast (~50ms per text)
- Model not re-downloaded on every server restart (cached)

**Commit:** `feat: add xenova transformer local embeddings (384-dim)`

---

#### Todo 1.5: Complete the Firecrawl crawler module

**References:**
- `utils/crawler.ts` (exists, partially implemented)
- Firecrawl API docs: POST `https://api.firecrawl.dev/v2/crawl`
- Already set up: API key, request body with `onlyMainContent: true`, `formats: ["markdown"]`

**Actions:**
1. Complete `utils/crawler.ts`:
   - `async function crawlUrl(url: string): Promise<string>` — crawl single URL, return markdown content
   - Firecrawl API call (already mostly done in `apiHandler`)
   - Poll Firecrawl job status for completion (crawls are async — you get a job ID then poll)
   - Handle Firecrawl errors (rate limit, invalid URL, blocked site)
   - Extract main content from response
   - Log crawl duration + content size
2. `async function crawlBatch(urls: string[], concurrency: number = 3): Promise<Map<string, string>>`
   - Crawl up to `concurrency` URLs in parallel
   - Redis cache check before crawling (skip if recently crawled)
   - Return Map<url, markdown>

**Acceptance criteria:**
- `crawlUrl("https://jobberman.com/jobs/...")` returns markdown content of the job page
- `crawlBatch` processes 5 URLs and returns results for all that succeeded
- Failed URLs are logged but don't stop the batch
- Already-crawled URLs (in Redis within TTL) are skipped

**QA:**
- Happy: accessible job URL → returns markdown with job content
- Failure: invalid URL → returns error string, logged, batch continues
- Failure: Firecrawl down → graceful timeout + retry message
- Cache hit: same URL crawled twice → second call returns cached, no API call

**Commit:** `feat: complete firecrawl crawler with single and batch modes`

---

#### Todo 1.6: Build and test the full core loop (1 URL end-to-end)

**References:**
- `controller/jobApplication.ts` (exists, empty class)
- All previous todos (crawler, LLM, embeddings, database)

**Actions:**
1. Implement `JobApplicationController.search()` in `controller/jobApplication.ts`:
   - Accept a URL string
   - `crawlUrl(url)` → markdown
   - `extractJobFromMarkdown(markdown)` → structured job or null
   - If null → log and return error
   - If structured job → `embedText(structured job as string)` → vector
   - Store in Supabase: INSERT into `jobs` + INSERT into `job_vectors`
   - Check Redis for URL dedup before storing
   - Return the stored job
2. Wire a test endpoint in `index.ts`: `POST /api/jobs/crawl` with body `{ url: string }`
3. Test with ONE real Nigerian job URL from Jobberman

**Acceptance criteria:**
- `POST /api/jobs/crawl` with a valid job URL returns `{ success: true, job: {...} }`
- A new row appears in `jobs` table in Supabase
- A new row with a 384-dim vector appears in `job_vectors` table
- Same URL posted twice → returns `{ success: false, message: "already exists" }` (dedup via Redis + DB unique constraint)

**QA:**
- Happy: valid Jobberman URL → job stored with vector
- Failure: non-job URL (e.g., google.com) → returns error, no DB insert
- Failure: invalid URL → returns 400
- Dedup: second request with same URL → 409 Conflict

**Commit:** `feat: complete end-to-end crawl->extract->embed->store loop`

---

### Wave 2 — Scale & match

---

#### Todo 2.1: Create seed URL list + discovery

**References:**
- `utils/searchPhrase.ts` (exists, comment stub "Probably use Tavily with Exa")

**Actions:**
1. Create `data/seed-urls.ts` with curated Nigerian job source URLs:
   - `https://www.jobberman.com/jobs`
   - `https://www.myjobmag.com`
   - `https://hotnigerianjobs.com`
   - `https://remote4africa.com`
   - `https://ng.indeed.com`
   - `https://www.linkedin.com/jobs/search?location=Nigeria` (public page, no auth needed for basic crawl)
   - (Add 5-10 more you know)
2. For each seed URL, define a selector hint or note about the page structure
3. Implement `utils/searchPhrase.ts`:
   - `getSeedUrls(): string[]` returns the curated list
   - Optionally `discoverJobUrls(sourceSiteUrl: string): Promise<string[]>` — crawl a job board's listing page and extract individual job links (Firecrawl + simple link extraction)

**Acceptance criteria:**
- `getSeedUrls()` returns 10+ URLs
- `discoverJobUrls` can extract job links from a Jobberman listing page

**QA:**
- Happy: `discoverJobUrls("https://www.jobberman.com/jobs")` returns array of job URLs
- Failure: site blocks → returns empty array, logs error

**Commit:** `feat: add curated seed URLs and job link discovery`

---

#### Todo 2.2: Batch crawl + extract pipeline

**References:**
- `controller/jobApplication.ts`
- `utils/crawler.ts` crawlBatch

**Actions:**
1. Implement in `JobApplicationController`:
   - `async crawlAndExtractAll(): Promise<{success: number, failed: number}>`
   - Get all seed URLs → run `discoverJobUrls` on each → flatten into job URL list
   - Filter already-crawled URLs via Redis
   - `crawlBatch(newUrls, concurrency=3)` → array of markdown results
   - Process each through `extractJobFromMarkdown` with concurrency=2 (Groq rate limit)
   - For each extracted job: embed + store in Supabase
   - Track success/failure counts
2. Add rate limiting: max 1 request per second to same domain
3. Add `POST /api/jobs/refresh` endpoint to trigger a full refresh

**Acceptance criteria:**
- Full refresh discovers 30+ new job URLs from seed sources
- At least 60% of URL crawls result in successful extraction (some pages will be non-job pages)
- Duplicate URLs (same job posted on multiple boards) are detected via URL + title similarity
- Pipeline completes without crashing

**QA:**
- Happy: run refresh → sees jobs appearing in Supabase
- Failure: Groq rate-limited → retries with exponential backoff, logs warning
- Failure: seed site down → skips that source, continues with others
- Idempotent: running refresh twice doesn't create duplicate jobs (URL dedup + DB constraint)

**Commit:** `feat: add batch crawl and extract pipeline`

---

#### Todo 2.3: Resume intake + embed pipeline

**References:**
- `model/LLM.ts` — `extractProfileFromResume`
- `model/embeddings.ts` — `embedText`
- `model/redis.ts` — cache

**Actions:**
1. Create `routes/resume.ts`:
   - `POST /api/resume/upload` — accepts `{ user_id: string, resume_text: string }`
   - Calls `extractProfileFromResume(resume_text)` → structured profile
   - Calls `embedText(JSON.stringify(structuredProfile))` → 384-dim vector
   - Upserts into `users` table: updates `resume_text`, `resume_embedding`, `skills`
   - Caches the embedding in Redis: `resume:embedding:{user_id}` → vector, TTL 1 hour
   - Returns the structured profile
2. `GET /api/resume/{user_id}` — returns cached profile + skills

**Acceptance criteria:**
- Uploading a resume text returns extracted skills array
- User row in Supabase has `resume_embedding` populated (384-dim)
- Same user uploading again updates the existing row (not duplicate)
- Redis cache hit on second request within 1 hour

**QA:**
- Happy: paste a software dev resume → returns ["JavaScript", "React", "Node.js", ...]
- Failure: empty text → returns 400 error
- Failure: Groq fails → returns 503, error logged
- Cache: second GET within TTL → returns cached data, no DB query

**Commit:** `feat: add resume intake with LLM extraction and embedding`

---

#### Todo 2.4: Match & rank service

**References:**
- pgvector cosine similarity: `SELECT * FROM job_vectors ORDER BY embedding <=> $1 LIMIT 20`
- Supabase JS SDK: `rpc()` for raw SQL

**Actions:**
1. Create SQL function in Supabase (run via dashboard):
   ```sql
   CREATE OR REPLACE FUNCTION match_jobs(
     query_embedding vector(384),
     match_threshold float,
     match_count int
   )
   RETURNS TABLE (
     job_id UUID,
     title TEXT,
     company TEXT,
     location TEXT,
     description TEXT,
     skills TEXT[],
     remote_status TEXT,
     salary_range TEXT,
     apply_url TEXT,
     source_site TEXT,
     posted_date TIMESTAMP,
     similarity float
   )
   LANGUAGE plpgsql
   AS $$
   BEGIN
     RETURN QUERY
     SELECT
       j.id, j.title, j.company, j.location, j.description,
       j.skills, j.remote_status, j.salary_range, j.apply_url,
       j.source_site, j.posted_date,
       1 - (jv.embedding <=> query_embedding) AS similarity
     FROM job_vectors jv
     JOIN jobs j ON j.id = jv.job_id
     WHERE 1 - (jv.embedding <=> query_embedding) > match_threshold
     ORDER BY jv.embedding <=> query_embedding
     LIMIT match_count;
   END;
   $$;
   ```
2. Implement `JobApplicationController.matchJobs(userId: string)`:
   - Get user's resume embedding from Redis (or Supabase)
   - Call `match_jobs(embedding, 0.5, 20)` via Supabase rpc
   - For each result, compute missing skills: user_skills - job_skills
   - Return ranked results with: match_score, missing_skills, job details
3. `GET /api/jobs/match/{userId}` endpoint
4. Add caching: match results cached in Redis for 5 minutes

**Acceptance criteria:**
- With a resume uploaded, `/api/jobs/match/{userId}` returns 20 ranked jobs
- Each result has `match_score` (0-1), `missing_skills: string[]`, and full job details
- Jobs with similarity < 0.5 are excluded
- Results are sorted by match_score descending

**QA:**
- Happy: user with resume + 50 jobs in DB → returns ranked list with scores
- Failure: user has no resume → 400 "upload resume first"
- Failure: no jobs in DB → empty array, not an error
- Consistency: same user, same data → same scores (deterministic)

**Commit:** `feat: add resume-to-job matching with pgvector cosine similarity`

---

### Wave 3 — Delivery & UX

---

#### Todo 3.1: WebSocket for real-time job suggestions

**References:**
- `ws` package (or `bun` has built-in WebSocket)
- `utils/subagent.ts` (comment about WebSocket)

**Actions:**
1. `bun add ws` (if using ws package; Bun has built-in WebSocket support via `Bun.serve`)
2. Create `ws/handler.ts`:
   - WebSocket server attached to Express on a separate path or port
   - Connection event: client sends `{ type: "subscribe", user_id: "..." }`
   - On subscribe: load resume from Redis, run match, send top 5 as initial payload
   - Messages look like: `{ type: "jobs:update", jobs: [...], timestamp: "..." }`
   - Handle disconnect: cleanup subscriptions
3. Create `ws/match-pusher.ts`:
   - `async function pushNewMatches(userId: string, socket: WebSocket)`
   - Run match query, serialize, send
   - Error handling: if match fails, send error message to socket (don't crash)
4. Wire into `index.ts`: Express + WebSocket server start

**Acceptance criteria:**
- Client connects via WebSocket → receives initial job suggestions
- Client sends `{ type: "subscribe", user_id: "abc" }` → receives top 5 matches
- Socket disconnects → no memory leak (subscription cleaned up)
- Match failure → client receives error message, socket stays open

**QA:**
- Happy: connect → subscribe → receives jobs
- Failure: subscribe with nonexistent user_id → receives empty results, not crash
- Failure: invalid message → ignored, socket remains open
- Multiple clients: 3 users connected → each gets their own matches

**Commit:** `feat: add websocket for real-time job push`

---

#### Todo 3.2: Application tracking state machine

**References:**
- `controller/jobApplication.ts`
- Supabase `applications` table schema (from 1.1)

**Actions:**
1. Implement in `JobApplicationController`:
   - `async saveJob(userId, jobId)` → INSERT into applications with status='saved'
   - `async updateStatus(userId, applicationId, newStatus)` → UPDATE applications
   - `async getApplications(userId, status?)` → SELECT from applications JOIN jobs
   - `async addNote(userId, applicationId, note)` → UPDATE notes
   - `async deleteApplication(userId, applicationId)` → DELETE
2. Create `routes/applications.ts`:
   - `POST /api/applications` — save a job (body: { user_id, job_id })
   - `PATCH /api/applications/:id/status` — update status (body: { status, user_id })
   - `GET /api/applications/{userId}` — list all, optional ?status=applied filter
   - `PATCH /api/applications/:id/notes` — add notes (body: { notes, user_id })
   - `DELETE /api/applications/:id` — remove

**Acceptance criteria:**
- Save a job → row in applications with status='saved'
- Update status → status changes in DB
- List applications → returns jobs with their application status
- Delete → row removed
- Same user+job pair → second save returns 409 (unique constraint)

**QA:**
- Happy: save → list → update status → list again → delete → list empty
- Failure: save nonexistent job_id → 404
- Failure: invalid status transition → 400
- Authorization: user A cannot update user B's application
- Note: 500+ char notes handled correctly

**Commit:** `feat: add application tracking with status state machine`

---

#### Todo 3.3: Periodic job suggestion scheduler

**References:**
- `controller/jobApplication.ts` — matchJobs
- `ws/handler.ts` — push to sockets

**Actions:**
1. Create `utils/scheduler.ts`:
   - `startScheduler(intervalMs: number)` — starts a `setInterval`
   - On each tick:
     - Run `crawlAndExtractAll()` to fetch new jobs
     - For each user with a resume in Redis:
       - Run `matchJobs(userId)` with new jobs only
       - If new matches found (matches > threshold), push via WebSocket
   - Track tick execution time, log summary
   - Default interval: 6 hours (21600000 ms)
2. Wire into `index.ts` — call `startScheduler` after server starts

**Acceptance criteria:**
- Scheduler starts on server boot
- First tick runs crawl + match for all active users
- New matching jobs are pushed to subscribed WebSocket clients
- Scheduler logs: `[Scheduler] Tick #1: crawled 45 URLs, 32 new jobs, 3 users notified`

**QA:**
- Happy: server running → scheduler ticks → new jobs appear → users notified
- Failure: crawl fails on tick → logs error, next tick continues
- Idempotent: running scheduler twice does not duplicate job notifications (track sent job_ids per user in Redis)

**Commit:** `feat: add periodic job suggestion scheduler`

---

#### Todo 3.4: Rate limiting, cleanup & production hardening

**References:**
- `utils/limiter.ts` (exists, comment stub)
- `utils/crawler.ts`

**Actions:**
1. Implement `utils/limiter.ts`:
   - Rate limiter per IP for API endpoints (Express middleware)
   - Per-domain rate limiting for crawler (max 1 req/2s per domain)
   - Token bucket or sliding window via Redis
2. Implement cleanup:
   - `async function cleanupStaleJobs(daysOld: number)` — remove jobs older than 60 days (or configurable)
   - `async function cleanupOrphanedVectors()` — remove job_vectors with no corresponding job
   - Run cleanup on scheduler tick (once per day)
3. Add error tracking:
   - Wrap all async routes in try/catch
   - Log errors with context (route, body, error message)
   - Return consistent error shape: `{ success: false, error: string }`
4. Update `index.ts` — start Express + WebSocket, load middleware, graceful shutdown

**Acceptance criteria:**
- Rate limit: 10 requests in 1 second from same IP → 429 response
- Crawler rate limit: same domain requested faster than 2s → queued
- Stale jobs older than 60 days are deleted
- Error responses are always `{ success: false, error: "..." }`
- Server exits cleanly on SIGTERM (closes DB, Redis, WS connections)

**QA:**
- Happy: rapid requests → 429 after limit exceeded
- Happy: cleanup runs → old jobs removed from DB + vectors
- Failure: cleanup with no old jobs → no-op, logs "0 stale jobs removed"
- Graceful shutdown: SIGTERM → server closes within 5s

**Commit:** `feat: add rate limiting, cleanup, and production hardening`

---

## Final verification wave

Run ALL of these in parallel after every todo is done. Each must pass.

**F1 — Plan compliance audit:**
- Every file mentioned in todos exists and has the expected exports
- `bun run index.ts` starts without import errors
- `bun check` (or `tsc --noEmit`) passes with zero errors

**F2 — Core loop smoke test:**
1. Start server
2. `POST /api/resume/upload` with a sample resume text → 200 with skills
3. `POST /api/jobs/crawl` with a real Jobberman URL → 200 with job
4. `GET /api/jobs/match/{userId}` → 200 with ranked results (score > 0)
5. `POST /api/applications` with {user_id, job_id} → 201
6. WebSocket connect → subscribe → receive jobs

**F3 — Failure mode test:**
1. `POST /api/jobs/crawl` with empty body → 400
2. `POST /api/jobs/crawl` with `{url: "not-a-url"}` → 400 or graceful error
3. `POST /api/resume/upload` without text → 400
4. `GET /api/jobs/match/nonexistent-user` → 200 with empty results
5. `PATCH /api/applications/nonexistent` → 404

**F4 — Scope fidelity:**
- No auto-apply logic exists anywhere
- No auth provider integration
- No PDF parsing (resume is text-only)
- No frontend code in the repo

## Commit strategy

```
feat: add supabase client and pgvector schema
feat: add redis client with cache helpers
feat: add groq LLM client with job and resume extraction
feat: add xenova transformer local embeddings (384-dim)
feat: complete firecrawl crawler with single and batch modes
feat: complete end-to-end crawl->extract->embed->store loop
feat: add curated seed URLs and job link discovery
feat: add batch crawl and extract pipeline
feat: add resume intake with LLM extraction and embedding
feat: add resume-to-job matching with pgvector cosine similarity
feat: add websocket for real-time job push
feat: add application tracking with status state machine
feat: add periodic job suggestion scheduler
feat: add rate limiting, cleanup, and production hardening
```

Each commit corresponds to exactly one todo. Commits are ordered — Wave 1 before Wave 2 before Wave 3. No squashing; preserve the progression.

## Success criteria

The plan is complete when:

1. A user can upload their resume text → get their skills extracted → have jobs matched against their profile
2. The system crawls 10+ Nigerian job sources, extracts jobs, and stores them as vectors
3. A user receives ranked job suggestions via WebSocket when they connect
4. A user can save jobs, update application status, and add notes
5. The system runs without crashing, handles rate limits, and cleans up stale data
6. No code for auto-apply, auth providers, or PDF parsing exists anywhere in the codebase
