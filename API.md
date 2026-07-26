z# hrout API — Frontend TL;DR

**Base URL**: `https://hroute-server.vercel.app/api`  
**Auth**: `Authorization: Bearer <access_token>` (required on protected routes)

## Quick Start (5 endpoints)

| Step | Endpoint | What you send | What you get |
|------|----------|---------------|--------------|
| 1 | `POST /auth/login` | `{ email, password }` | `access_token` |
| 2 | `POST /resume/upload` | `{ resume_text }` + Bearer | Enables job matching |
| 3 | `GET /jobs/recent` | — | Random active jobs (no auth) |
| 4 | `POST /jobs/match` | `{ limit, location, remote }` + Bearer | Ranked jobs with `score`, `matched_skills` |
| 5 | `POST /chat` | `{ message }` + Bearer | `{ reply: string }` |

> **WebSocket removed** — `wss://.../api/ws/jobs` is gone. Use `POST /api/jobs/match` for personalised ranking or `POST /api/jobs/search` for public query search instead. Sync HTTP, same filters, faster integration.

### Match result shape you care about

```typescript
interface MatchResult {
  job_id: string;
  title: string;
  company: string;
  score: number;           // 0–1 relevance
  similarity: number;      // cosine similarity to your resume
  matched_skills: string[]; // skills you have they want
  missing_skills: string[]; // skills they want you don't have
  rank_reasons: string[];  // why it was recommended
  apply_url?: string;
  logo_url?: string | null;
}
```

---

## Health

```
GET /ping
```

Response:
```json
{ "status": "ok", "timestamp": "2026-07-09T12:00:00.000Z" }
```

No auth required.

---

## Auth — `/api/auth/`

| Method | Path           | Auth    | Request Body                                    | Response (success)                                                       |
|--------|----------------|---------|------------------------------------------------|--------------------------------------------------------------------------|
| POST   | `/auth/register` | No    | `{ "email": string, "password": string }`      | `{ "status": 200, "access_token": string, "refresh_token": string }`    |
| POST   | `/auth/login`    | No    | `{ "email": string, "password": string }`      | `{ "status": 200, "access_token": string, "refresh_token": string }`    |
| POST   | `/auth/refresh`  | No    | `{ "refresh_token": string }`                  | `{ "status": 200, "access_token": string, "expires_in": number }`       |
| POST   | `/auth/logout`   | Bearer | —                                               | `{ "status": 200, "message": "Logged out" }`                            |
| GET    | `/auth/me`       | Bearer | —                                               | `{ "status": 200, "user": UserProfile }`                                |
| GET    | `/auth/isme`     | Bearer + `X-Refresh-Token` | —                        | `{ "status": 200, "user": UserProfile }` or `{ "status": 200, "user": UserProfile, "access_token": string, "expires_in": number }` — 404 if nothing works |
| PUT    | `/auth/profile`  | Bearer | `{ "display_name"?: string, "skills"?: string[], … }` | `{ "status": 200, "message": "Profile updated" }`                 |
| PUT    | `/auth/password` | Bearer | `{ "current_password": string, "new_password": string }` | `{ "status": 200, "message": "Password updated" }`               |
| DELETE | `/auth/account`  | Bearer | —                                               | `{ "status": 200, "message": "Account deleted" }`                       |

**Error shape** (all routes): `{ "status": 4xx|5xx, "error": string }`

**register / login**  
- Password minimum 6 characters.  
- Register returns 409 if email already exists.  
- Login returns 401 on invalid credentials.

**refresh**  
- The `refresh_token` originally returned by register/login.  
- Returns a new `access_token` (no new refresh token).  
- The frontend should call this when a request returns 401 to silently rotate the token before showing a login screen.

**me**  
- Returns the full `UserProfile` for the authenticated user.

**isme**  
- Silent session check. Returns the user profile or 404 — no error UI needed on failure.  
- **Two-header auth**: send `Authorization: Bearer <accessToken>` and optionally `X-Refresh-Token: <refreshToken>`.  
  - If the access token is valid → returns `{ status: 200, user }`.  
  - If the access token is expired but `X-Refresh-Token` is valid → rotates the token server-side and returns `{ status: 200, user, access_token, expires_in }`.  
  - If neither works → `{ status: 404, error: "User not found" }`.  
- The frontend should call this on app start with both headers and store the new `access_token` if one is returned. No separate `/auth/refresh` call needed.

**profile**  
- PATCH-like `PUT` — send only the fields you want to change.  
- Acceptable keys: `display_name`, `avatar_url`, `timezone`, `skills`, `resume_text`, etc.

**password**  
- `current_password` must match the existing password.  
- `new_password` minimum 6 characters.

**account**  
- Irreversible — deletes the user and all associated data.

---

## Chat — `/api/chat`

| Method | Path | Auth | Request Body | Response |
|--------|------|------|--------------|----------|
| POST | `/chat` | Bearer | `{ "message": string, "system"?: string }` | `{ "status": 200, "reply": string }` |

Use this for the in-app assistant. It reuses the backend Groq/LLM wrapper and requires a valid access token.

Request:
```json
{
  "message": "Help me improve my resume for frontend roles"
}
```

Optional `system` can override the default assistant behavior for a specific frontend flow.

Success:
```json
{
  "status": 200,
  "reply": "..."
}
```

Errors:
- `401` if `Authorization` is missing or invalid
- `400` if `message` is missing
- `500` if the LLM call fails or is rate-limited

Limits:
- `message` is trimmed and capped server-side at **4,000 characters**.
- The response is capped by the backend at roughly **700 tokens**.

---

## Jobs — `/api/jobs/`

| Method | Path             | Auth    | Request Body                        | Response (success)                  |
|--------|------------------|---------|-------------------------------------|-------------------------------------|
| POST   | `/jobs/discover` | Bearer (if `DISCOVER_API_KEY` set) | `{ "seedUrls"?: string[] }`         | `DiscoverResult`                    |
| GET    | `/jobs/recent`   | No      | —                                   | `JobRecord[]` (array, random active browse) |
| POST   | `/jobs/search`   | No      | `{ "query"?, "location"?, "remote"?, "skills"?, "limit"? }` | `JobRecord[]` (array, not wrapped)  |
| POST   | `/jobs/match`    | Bearer  | `{ "limit"?, "location"?, "remote"?, "role"?, "salary_target"? }` | `{ "status": 200, "jobs": MatchResult[], "source"?, "generated_at"?, "cache_key"? }` |

**discover**  
- Crawls job listing pages, extracts structured job data via LLM, stores in DB.  
- Default seed URLs from `SEARCHURLS` (35 sources) when `seedUrls` is omitted.  
- Run this first to populate the jobs table. Takes a while (rate-limited 5s between seeds).  
- Returns immediately after completion (not streaming).  
- **Auth**: If `DISCOVER_API_KEY` env var is set, requests must include `Authorization: Bearer <key>`.  
- **Fallback tiers**: Firecrawl API → Crawlee (CheerioCrawler `<a>` scraping) → Apify Sitemap URL Finder (requires `APIFY_API_TOKEN`). Page scraping (Firecrawl → Crawlee) and link discovery use separate fallback chains.  
- **Render deployment**: Discovery can exceed Vercel's 30s timeout. Deploy this same codebase on Render with `DISCOVER_API_KEY` set and no `VERCEL` env var to run discovery jobs without timeouts.

```json
{
  "status": 200,
  "message": "Discovery complete. Found 42 jobs.",
  "total_jobs": 42,
  "errors": []
}
```

**search** (public, query-based)  
- No auth required. Searches the `jobs` table by text match on `title`, `company`, and `description`.  
- Filters: `location` (partial match), `remote` (boolean, filters to remote-only jobs), `skills` (array overlap), `limit` (default 50, max 50).  
- Results are scoped to jobs crawled within the last 60 days.  
- Response is a **bare JSON array**, not wrapped in an object.

Optional request body:

```json
{
  "query": "react developer",
  "location": "Lagos",
  "remote": true,
  "skills": ["TypeScript", "React"],
  "limit": 20
}
```

```json
[
  {
    "id": "uuid",
    "title": "Junior React Engineer",
    "company": "Flutterwave",
    "location": "Lagos, Nigeria",
    "description": "…",
    "skills": ["React", "TypeScript"],
    "remote_status": "hybrid",
    "salary_range": null,
    "apply_url": "https://…",
    "source_site": "linkedin.com",
    "posted_date": "2026-07-01",
    "logo_url": "https://…",
    "crawled_at": "2026-07-09T10:00:00.000Z"
  }
]
```

Errors:
- `400` if `skills` is not an array or `remote` is not a boolean.

**match** (authenticated, semantic, cached + reranked)  
- Uses the authenticated user's `resume_embedding` to find similar jobs via cosine similarity (threshold 0.5).  
- Requires a Bearer token. The user must have uploaded a resume (have a `resume_embedding`).  
- Pulls 50–100 vector candidates, reranks them with profile/business signals, caches the final payload for 10 minutes, and returns up to `limit` matches.  
- Cache key includes user id, `resume_version`, `jobs:index_version`, and a stable filter hash.  
- Returns 400 if no resume embedding exists ("No resume embedding found").

Optional request body:

```json
{
  "limit": 20,
  "location": "Lagos",
  "remote": true,
  "role": "Frontend Developer",
  "salary_target": "₦400k"
}
```

```json
{
  "status": 200,
  "jobs": [
    {
      "job_id": "uuid",
      "title": "Junior React Engineer",
      "company": "Flutterwave",
      "location": "Lagos, Nigeria",
      "description": "…",
      "skills": ["React", "TypeScript"],
      "remote_status": "hybrid",
      "salary_range": null,
      "apply_url": "https://…",
      "source_site": "linkedin.com",
      "posted_date": "2026-07-01",
      "logo_url": "https://...",
      "score": 0.89,
      "similarity": 0.87,
      "matched_skills": ["React", "TypeScript"],
      "missing_skills": ["Playwright"],
      "rank_reasons": ["skill match", "work style match", "recent posting"]
    }
  ],
  "source": "cache",
  "generated_at": "2026-07-10T12:00:00.000Z"
}
```

**recent** (random active browse)  
- Returns up to 50 random active jobs, scoped to those crawled within the last 60 days.  
- Results are shuffled server-side — each call may return a different ordering and composition.  
- No auth required.  
- Response is a **bare JSON array**, not wrapped in an object:

```json
[
  {
    "id": "uuid",
    "title": "Senior Backend Engineer",
    "company": "Paystack",
    "location": "Remote",
    "description": "…",
    "skills": ["Go", "PostgreSQL"],
    "remote_status": "remote",
    "salary_range": null,
    "apply_url": "https://…",
    "source_site": "linkedin.com",
    "source_url": "https://…",
    "posted_date": "2026-07-05",
    "logo_url": "https://…",
    "crawled_at": "2026-07-09T10:00:00.000Z"
  }
]
```

---

## Resume — `/api/resume/`

| Method | Path | Auth | Body | Returns |
|--------|------|------|------|---------|
| POST | `/resume/upload` | Bearer | `{ resume_text }` or `{ file_data, file_type }` | `{ profile, assessment? }` |
| GET | `/resume/file` | Bearer | — | `{ status: 200, url: string }` |
| POST | `/resume/improve` | Bearer | `{ message }` | `{ resume_text, score, changes, issues, suggestions }` |
| POST | `/resume/export` | Bearer | — | `{ status: 200, url: string }` |

**`resume_text`**: raw text extracted by the frontend (easiest).  
**`file_data` + `file_type`**: base64-encoded file content + `"pdf"` or `"txt"`. Server extracts text server-side.
Upload cap: **2 MB raw file size**. Larger uploads return `413 Payload Too Large`.

The backend keeps base64 as a temporary transport format only. For file uploads, it decodes the base64, uploads the raw file to Supabase Storage, then extracts bounded text for profile/embedding work.

Pipeline on upload:
1. Reject files above 2 MB before processing
2. Upload the raw file to Supabase Storage when `file_data` is provided
3. Extract bounded text (PDF via server parser or plain text)
4. Truncate resume text before LLM/profile processing
5. LLM extracts structured profile data
6. Saves profile fields and `resume_file_type`
7. Generates a resume embedding (384-dim) for semantic job search
8. Bumps `resume_version`
9. Runs ATS assessment via LLM (`resumeScore`) — score + issues + suggestions
10. Returns the structured profile + assessment

```json
{
  "status": 200,
  "profile": {
    "resume_text": "…",
    "role": "Frontend Developer",
    "location": "Lagos, Nigeria",
    "work_style": "Remote",
    "work_style_hint": "open to relocate",
    "experience": "1 year",
    "experience_hint": "incl. 2 internships",
    "salary_target": "₦400k – ₦700k / mo",
    "skills": ["TypeScript", "React", "Go"],
    "resume_file_type": "pdf",
    "resume_score": 72
  },
  "assessment": {
    "score": 72,
    "summary": "Solid foundation but needs more quantifiable achievements.",
    "issues": [
      "Weak action verbs — 60% of bullets start with 'Responsible for' or 'Helped'",
      "No numerical impact metrics in 4 of 6 role entries",
      "Missing keywords for ATS: 'TypeScript', 'CI/CD', 'agile'"
    ],
    "suggestions": [
      "Replace 'Responsible for' with past-tense action verbs (delivered, built, optimized)",
      "Add 1–2 quantifiable outcomes per role (% improvements, $ amounts, time saved)",
      "Add a Technical Skills section with proficiency levels"
    ]
  }
}
```

**Get uploaded resume file**

`GET /api/resume/file` returns a signed URL for the authenticated user's uploaded resume file. Do not store this URL permanently on the frontend; request a fresh one when the user needs to view/download the file.

```json
{
  "status": 200,
  "url": "https://...signed-url..."
}
```

Errors:
- `401` if auth is missing/invalid
- `404` if the user has no uploaded resume file

---

### Improve resume

`POST /api/resume/improve`

Sends a natural language instruction to rewrite the stored resume with Google XYZ format ("Accomplished X by doing Y resulting in Z"), one page, ATS-friendly. Returns the rewritten text, a re-score, and a list of changes made.

Request (auth required):
```json
{
  "message": "Make my summary stronger and add more quantifiable metrics"
}
```

Response:
```json
{
  "status": 200,
  "resume_text": "…rewritten full resume…",
  "score": 88,
  "changes": [
    "Rewrote summary to highlight 3 years of full-stack experience with customer impact",
    "Added quantifiable metrics to frontend role: 'Reduced load times by 40%'",
    "Replaced weak action verbs with past-tense achievements"
  ],
  "issues": [{"category": "keywords", "severity": "medium", "description": "Missing 'TypeScript' keyword in skills section"}],
  "suggestions": ["Add a Certifications section"]
}
```

**Pipeline behavior**:
1. LLM improves content in Google XYZ format
2. Reasoning step validates compliance
3. Code fixes structural issues (headers, formatting)
4. Targeted LLM rewrites for non-compliant sections
5. Re-score final output

**Response notes**:
- `changes` includes both content improvements and structural fixes
- `issues` includes any problems that couldn't be auto-fixed (display as warnings)
- Score reflects the final re-scored output, not the initial improvement

Errors:
- `401` if auth is missing/invalid
- `400` if `message` is missing or empty
- `500` if the LLM call fails

---

### Export resume as PDF

`POST /api/resume/export`

Generates a PDF of the stored resume in Google XYZ format, uploads it to Supabase Storage (`{userId}/generated/resume.pdf`), and returns a signed download URL.

Request (auth required): no body needed.

Response:
```json
{
  "status": 200,
  "url": "https://...signed-pdf-url..."
}
```

Errors:
- `401` if auth is missing/invalid
- `404` if the user has no stored resume text
- `500` if PDF generation or storage upload fails

**Caching**: The PDF is generated on each request. The signed URL is temporary — request a fresh one each time the user wants to download.

---

After upload, the user's profile is fully populated. `GET /auth/me` will include all these fields, and `POST /jobs/match` will work (it needs the resume embedding). The public `POST /jobs/search` endpoint does not require a resume. Mapped to UI:

```jsx
<ProfileRow label="Role"     value={profile.role}           hint={profile.role ? undefined : undefined} />
<ProfileRow label="Location" value={profile.location} />
<ProfileRow label="Work style" value={profile.work_style}   hint={profile.work_style_hint} />
<ProfileRow label="Experience" value={profile.experience}   hint={profile.experience_hint} />
<ProfileRow label="Salary target" value={profile.salary_target} />
```

---

## Applications — `/api/applications/`

**Not yet wired.** The DB schema exists:

```sql
applications (id, user_id, job_id, status, notes, deadline, created_at, updated_at)
```

Status enum: `saved | applied | interviewing | offer | accepted | rejected`

Routes planned but not implemented. The frontend tracker screen currently uses mock data.

---

## TypeScript Interfaces

```typescript
// ── Auth ──

interface UserProfile {
  id: string;
  email?: string;
  display_name?: string;
  avatar_url?: string;
  timezone?: string;
  headline?: string;
  location?: string;
  role?: string;
  work_style?: string;
  work_style_hint?: string;
  experience?: string;
  experience_hint?: string;
  salary_target?: string;
  created_at?: string;
  skills?: string[];
  resume_text?: string;
  resume_file_type?: "pdf" | "txt";
  resume_version?: string;
  resume_score?: number;
}

interface ChatResponse {
  status: number;
  reply?: string;
  error?: string;
}

// ── Jobs ──

interface StructuredJob {
  title: string;
  company: string;
  location?: string;
  description: string;
  skills?: string[];
  remote_status?: "remote" | "hybrid" | "onsite" | "unknown";
  salary_range?: string | null;
  apply_url?: string | null;
  posted_date?: string | null;
  source_site?: string;
}

interface JobRecord extends StructuredJob {
  id: string;
  source_url: string;
  crawled_at: string;
  logo_url?: string | null;
}

interface MatchResult {
  id?: string;
  job_id?: string;
  title: string;
  company: string;
  location?: string;
  description?: string;
  skills?: string[];
  remote_status?: string;
  salary_range?: string | null;
  apply_url?: string | null;
  source_site?: string;
  posted_date?: string | null;
  logo_url?: string | null;
  crawled_at?: string;
  score?: number;
  similarity: number;
  matched_skills?: string[];
  missing_skills: string[];
  rank_reasons?: string[];
}

// ── Applications ──

interface Application {
  id?: string;
  user_id: string;
  job_id: string;
  status?: "saved" | "applied" | "interviewing" | "offer" | "accepted" | "rejected";
  notes?: string;
  deadline?: string | null;
  created_at?: string;
  updated_at?: string;
}
```

---

## Vanilla JS Quick-Start

```javascript
const BASE = "https://hroute-server.vercel.app/api";
let token = null;
let refreshToken = null;

// 1. Log in (or register)
async function login(email, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (data.access_token) {
    token = data.access_token;
    refreshToken = data.refresh_token;
    console.log("Logged in as", email);
  } else {
    throw new Error(data.error);
  }
}

// 2. Silent session check — returns profile or 404, optionally refreshes the token
async function checkSession() {
  if (!token && !refreshToken) return null;
  const headers = {} as Record<string, string>;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (refreshToken) headers["X-Refresh-Token"] = refreshToken;
  const res = await fetch(`${BASE}/auth/isme`, { headers });
  if (res.status === 404) { token = null; refreshToken = null; return null; }
  const data = await res.json();
  if (data.access_token) token = data.access_token; // rotated token
  return data; // { status: 200, user, access_token?, expires_in? }
}

// 3. Fetch recent jobs (no auth needed — random active browse)
async function getRecentJobs() {
  const res = await fetch(`${BASE}/jobs/recent`);
  return res.json(); // bare array
}

// 4. Public query search (no auth needed)
async function searchJobs(query = "react") {
  const res = await fetch(`${BASE}/jobs/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit: 20 }),
  });
  return res.json(); // bare array
}

// 5. Semantic match (auth required — uses your resume embedding)
async function matchJobs() {
  const res = await fetch(`${BASE}/jobs/match`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  return res.json(); // { status, jobs: [...], source?, error? }
}

// 6. Chat assistant (auth required)
async function chat(message) {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message }),
  });
  return res.json(); // { status, reply?, error? }
}

// 7. Resume signed URL (auth required)
async function getResumeFileUrl() {
  const res = await fetch(`${BASE}/resume/file`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json(); // { status, url?, error? }
}

// 8. Resume improve — rewrite with instruction (auth required)
async function improveResume(message) {
  const res = await fetch(`${BASE}/resume/improve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message }),
  });
  return res.json(); // { status, resume_text, score, changes, issues, suggestions }
}

// 9. Resume export — generate PDF (auth required)
async function exportResumePdf() {
  const res = await fetch(`${BASE}/resume/export`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json(); // { status, url }
}

// Example usage
async function main() {
  await login("user@example.com", "password123");
  const session = await checkSession();
  console.log(session ? "Session valid" : "Session expired");
  const recent = await getRecentJobs();
  console.log(`${recent.length} recent jobs`);
  const results = await searchJobs("react developer");
  console.log(`${results.length} search results`);
  const matches = await matchJobs();
  console.log(`${matches.jobs?.length ?? 0} matching jobs`);
  const assistant = await chat("How can I improve my profile?");
  console.log(assistant.reply);
}

main().catch(console.error);
```

---

## Notes

- All routes are prefixed with `/api` (so full path is e.g. `POST /api/auth/login`).  
- Use `import type { UserProfile, StructuredJob, JobRecord, MatchResult, Application }` from `model/model.ts` for the canonical TS types.  
- `logo_url` is returned by `GET /jobs/recent`, `POST /jobs/search`, and `POST /jobs/match`; handle it as `string | null`.  
- Uploaded resume files are private. Use `GET /api/resume/file` to request a temporary signed URL instead of storing a permanent URL.  
- To populate the jobs table for the first time, call `POST /api/jobs/discover` once. It crawls 35 seed URLs and can take several minutes.
