import { test, expect } from "bun:test";
import { JobApplicationController } from "../controller/jobApplication.js";
import { createFakeDatabase, createFakeMatcher } from "./helpers/fakes.js";

test("job match HTTP returns ranked results with score, matched_skills, rank_reasons", async () => {
  const fakeDb = createFakeDatabase();
  const fakeSearch = createFakeMatcher({
    status: 200,
    source: "computed",
    generated_at: "2026-07-10T10:00:00.000Z",
    cache_key: "match:v1:key",
    jobs: [
      {
        job_id: "job-1",
        title: "Frontend Engineer",
        company: "Paystack",
        score: 0.87,
        similarity: 0.9,
        matched_skills: ["typescript", "react"],
        missing_skills: ["playwright"],
        rank_reasons: ["skill match", "work style match"],
      },
    ],
  });

  const controller = new JobApplicationController(fakeDb, fakeSearch);
  const progress: string[] = [];

  const result = await controller.Search(
    fakeDb.state.accessToken,
    { limit: 1, location: "Lagos", remote: true },
    (step) => {
    progress.push(step.stage);
  },
  );

  expect(result.status).toBe(200);
  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0]!.job_id).toBe("job-1");
  expect(result.jobs[0]!.score).toBe(0.87);
  expect(result.jobs[0]!.matched_skills).toEqual(["typescript", "react"]);
  expect(result.jobs[0]!.rank_reasons).toContain("skill match");
  expect(result.source).toBe("computed");
  expect(progress).toContain("cache");
});
