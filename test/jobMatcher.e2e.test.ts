import { test, expect } from "bun:test";
import { JobMatcher } from "../controller/jobMatcher.js";
import { createFakeDatabase, createFakeRedis } from "./helpers/fakes.js";

test("job similarity ranks the strongest match first and writes cache", async () => {
  const fakeDb = createFakeDatabase({
    jobs: [
      {
        id: "job-1",
        title: "Frontend Engineer",
        company: "Paystack",
        location: "Lagos",
        remote_status: "remote",
        skills: ["typescript", "react"],
        similarity: 0.92,
        crawled_at: "2026-07-09T12:00:00.000Z",
      },
      {
        id: "job-2",
        title: "Backend Engineer",
        company: "Acme",
        location: "Abuja",
        remote_status: "onsite",
        skills: ["python", "django"],
        similarity: 0.31,
        crawled_at: "2026-07-05T12:00:00.000Z",
      },
    ],
  });
  const fakeRedis = createFakeRedis();
  const matcher = new JobMatcher(fakeDb, fakeRedis);
  const progress: string[] = [];

  const result = await matcher.match(
    "access-token",
    { location: "Lagos", remote: true, limit: 5 },
    (step) => {
    progress.push(step.stage);
  },
  );

  expect(result.status).toBe(200);
  expect(result.source).toBe("computed");
  expect(result.jobs).toHaveLength(2);
  expect(result.jobs[0]?.job_id).toBe("job-1");
  expect(result.jobs[0]?.matched_skills).toContain("typescript");
  expect(result.jobs[1]?.job_id).toBe("job-2");
  expect(progress).toEqual(["cache", "vector_search", "rerank", "cache_write"]);
  expect(fakeRedis.state.size).toBeGreaterThan(0);
});
