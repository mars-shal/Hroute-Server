# Backend E2E: Job Matching and WebSocket

## Status
`done`

## What changed
- Fixed Node ESM import specifiers by adding `.js` to local imports.
- Fixed filesystem logging so serverless runs do not fail on `./logs`.
- Fixed WebSocket send checks to use `WebSocket.OPEN`.
- Added dependency injection for:
  - `DatabaseLike`
  - `RedisLike`
  - job search services
- Added a reusable server factory in `app.ts`.
- Added controller-level E2E coverage for:
  - auth register/login/profile
  - job similarity ranking
  - job search passthrough
  - WebSocket job-match flow
- Added a live smoke runner: `bun run e2e:live`

## Verified locally
- `bun test`
- Result: 4 passing tests, 0 failures

## Test coverage notes
- Job similarity is verified through the real `JobMatcher` ranking path with fake backend data.
- WebSocket behavior is verified through the real `JobsWsController.handleConnection()` path with a fake socket.
- Auth and search wrapper behavior are verified through the real controller classes.

## Live smoke test
Use environment variables, not committed secrets:

- `E2E_BASE_URL`
- `E2E_EMAIL`
- `E2E_PASSWORD`
- optional `E2E_RESUME_TEXT`

Example:

```bash
E2E_BASE_URL=https://your-deployment.example \
E2E_EMAIL=you@example.com \
E2E_PASSWORD='your-password' \
bun run e2e:live
```

## Notes
- The live smoke runner uploads resume text before job search so semantic matching can be exercised end to end.
- If job search returns no matches in the live environment, check whether the jobs table is populated and whether the resume embedding was generated successfully.
