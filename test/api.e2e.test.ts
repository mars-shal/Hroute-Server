import { expect, test } from "bun:test";
import { AuthController } from "../controller/authController.js";
import { JobApplicationController } from "../controller/jobApplication.js";
import { createFakeDatabase, createFakeMatcher } from "./helpers/fakes.js";

test("auth controller supports register, login, and profile lookup", async () => {
  const fakeDb = createFakeDatabase();
  const auth = new AuthController(fakeDb);

  const register = await auth.Register({
    email: fakeDb.state.email,
    password: fakeDb.state.password,
  });
  expect(register.status).toBe(200);
  expect(register.access_token).toBe(fakeDb.state.accessToken);

  const login = await auth.Login({
    email: fakeDb.state.email,
    password: fakeDb.state.password,
  });
  expect(login.status).toBe(200);
  expect(login.refresh_token).toBe(fakeDb.state.refreshToken);

  const profile = await auth.GetProfile(fakeDb.state.accessToken);
  expect(profile.status).toBe(200);
  expect(profile.user.email).toBe(fakeDb.state.email);
});

test("job search controller passes through ranked matches", async () => {
  const fakeDb = createFakeDatabase();
  const fakeMatcher = createFakeMatcher({
    status: 200,
    source: "computed",
    generated_at: "2026-07-10T10:00:00.000Z",
    cache_key: "match:key",
    jobs: [
      {
        job_id: "job-1",
        title: "Frontend Engineer",
        company: "Paystack",
        similarity: 0.9,
        score: 0.87,
        matched_skills: ["typescript", "react"],
        missing_skills: ["playwright"],
        rank_reasons: ["skill match", "work style match"],
      },
    ],
  });
  const jobs = new JobApplicationController(fakeDb, fakeMatcher);
  const progress: string[] = [];

  const result = await jobs.Search(fakeDb.state.accessToken, { limit: 1, location: "Lagos", remote: true }, (step) => {
    progress.push(step.stage);
  });

  expect(result.status).toBe(200);
  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0].job_id).toBe("job-1");
  expect(result.source).toBe("computed");
  expect(progress).toContain("cache");
});
