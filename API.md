# hrout API — Frontend TL;DR

**Base URL**: `https://hroute-server.onrender.com/api`  
**Auth**: `Authorization: Bearer <access_token>` (required on protected routes)

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
| GET    | `/auth/me`       | Bearer | —                                               | `{ "status": 200, "user": UserProfile }`                                |
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

**me**  
- Returns the full `UserProfile` for the authenticated user.

**profile**  
- PATCH-like `PUT` — send only the fields you want to change.  
- Acceptable keys: `display_name`, `avatar_url`, `timezone`, `skills`, `resume_text`, etc.

**password**  
- `current_password` must match the existing password.  
- `new_password` minimum 6 characters.

**account**  
- Irreversible — deletes the user and all associated data.

---

## Jobs — `/api/jobs/`

| Method | Path             | Auth    | Request Body                        | Response (success)                  |
|--------|------------------|---------|-------------------------------------|-------------------------------------|
| POST   | `/jobs/discover` | No      | `{ "seedUrls"?: string[] }`         | `DiscoverResult`                    |
| POST   | `/jobs/search`   | Bearer  | —                                   | `{ "status": 200, "jobs": MatchResult[] }` |
| GET    | `/jobs/recent`   | No      | —                                   | `JobRecord[]` (array, not wrapped)  |

**discover**  
- Crawls job listing pages, extracts structured job data via LLM, stores in DB.  
- Default seed URLs from `SEARCHURLS` (35 sources) when `seedUrls` is omitted.  
- Run this first to populate the jobs table. Takes a while (rate-limited 5s between seeds).  
- Returns immediately after completion (not streaming).

```json
{
  "status": 200,
  "message": "Discovery complete. Found 42 jobs.",
  "total_jobs": 42,
  "errors": []
}
```

**search** (semantic)  
- Uses the authenticated user's `resume_embedding` to find similar jobs via cosine similarity (threshold 0.5).  
- Returns up to 20 ranked matches.  
- Returns 400 if no resume embedding exists ("No resume embedding found").

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
      "similarity": 0.87,
      "missing_skills": ["Playwright"]
    }
  ]
}
```

**recent**  
- Returns the last 50 jobs ordered by `crawled_at DESC`.  
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
  created_at?: string;
  skills?: string[];
  resume_text?: string;
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
  /** ⚠️ Present in the DB schema and returned by match_jobs() / GET /jobs/recent,
   *  but absent from the TS StructuredJob/JobRecord interfaces. */
  logo_url?: string | null;
}

interface MatchResult {
  job_id: string;
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
  similarity: number;
  missing_skills: string[];
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
const BASE = "https://hroute-server.onrender.com/api";
let token = null;

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
    console.log("Logged in as", email);
  } else {
    throw new Error(data.error);
  }
}

// 2. Fetch recent jobs (no auth needed)
async function getRecentJobs() {
  const res = await fetch(`${BASE}/jobs/recent`);
  return res.json(); // bare array
}

// 3. Semantic search (auth required — uses your resume embedding)
async function searchJobs() {
  const res = await fetch(`${BASE}/jobs/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  return res.json(); // { status, jobs: [...], error? }
}

// Example usage
async function main() {
  await login("user@example.com", "password123");
  const recent = await getRecentJobs();
  console.log(`${recent.length} recent jobs`);
  const matches = await searchJobs();
  console.log(`${matches.jobs.length} matching jobs`);
}

main().catch(console.error);
```

---

## Notes

- All routes are prefixed with `/api` (so full path is e.g. `POST /api/auth/login`).  
- Use `import type { UserProfile, StructuredJob, JobRecord, MatchResult, Application }` from `model/model.ts` for the canonical TS types.  
- The `logo_url` column exists in the `jobs` SQL table and is returned by `match_jobs()` and `GET /jobs/recent`, but it's **not** in the TS `StructuredJob` or `JobRecord` interfaces. Handle it as `string | null` when reading from the API.  
- To populate the jobs table for the first time, call `POST /api/jobs/discover` once. It crawls 35 seed URLs and can take several minutes.
