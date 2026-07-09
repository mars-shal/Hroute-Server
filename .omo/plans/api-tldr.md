# Plan: Write API TL;DR for Frontend

**Trigger**: User asked "can you write a tldr for my front end for api intergration"

**Goal**: Create `API.md` at project root — a concise reference document for frontend developers covering all server endpoints, request/response shapes, and auth pattern.

---

## Implementation (single file, one task)

**File**: `/home/marshall/Documents/projects/hrout_server/API.md`

**Content** (write verbatim):

- Server base URL, auth header pattern
- Auth endpoints table: register, login, refresh, me, profile, password, delete-account
- Job endpoints table: discover, search, recent
- Applications note (DB methods exist, routes not yet wired)
- `Job` TypeScript interface (including `logo_url: string | null`)
- Health check (`GET /ping`)
- Vanilla JS quick-start snippet (login → recent jobs → semantic search)

**Source data**: already gathered in this session — types from `model/model.ts`, route shapes from `controller/apiController.ts`, controller logic from `controller/authController.ts` and `controller/jobApplication.ts`.

---

## Execution

1. Delegate to a single `task(category="writing")` with the content above
2. Target file: `/home/marshall/Documents/projects/hrout_server/API.md`
