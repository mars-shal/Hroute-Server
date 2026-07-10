type Json = Record<string, unknown> | Array<unknown> | string | number | boolean | null;

const baseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8080";
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
const resumeText =
  process.env.E2E_RESUME_TEXT ??
  [
    "I am a frontend engineer with 5 years of experience.",
    "Skills: TypeScript, React, Next.js, Node.js, testing, accessibility.",
    "I have built and shipped production web apps and job-matching dashboards.",
  ].join(" ");

if (!email || !password) {
  throw new Error("Set E2E_EMAIL and E2E_PASSWORD before running the live smoke test.");
}

async function request(path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  let body: Json | string = text;
  try {
    body = JSON.parse(text) as Json;
  } catch {
    // Keep raw text for non-JSON responses.
  }

  return { res, body };
}

async function main() {
  console.log(`[E2E] Base URL: ${baseUrl}`);
  console.log(`[E2E] Email: ${email}`);

  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (login.res.status !== 200) {
    throw new Error(`Login failed (${login.res.status}): ${JSON.stringify(login.body)}`);
  }

  const token = (login.body as Record<string, unknown>).access_token as string | undefined;
  if (!token) {
    throw new Error(`Login did not return an access token: ${JSON.stringify(login.body)}`);
  }
  console.log("[E2E] Login OK");

  const me = await request("/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (me.res.status !== 200) {
    throw new Error(`GET /auth/me failed (${me.res.status}): ${JSON.stringify(me.body)}`);
  }
  console.log("[E2E] Profile OK");

  const upload = await request("/api/resume/upload", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ resume_text: resumeText }),
  });

  if (upload.res.status !== 200) {
    throw new Error(`Resume upload failed (${upload.res.status}): ${JSON.stringify(upload.body)}`);
  }
  console.log("[E2E] Resume upload OK");

  const search = await request("/api/jobs/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ limit: 5, location: "Lagos", remote: true }),
  });
  console.log(`[E2E] Search status: ${search.res.status}`);
  console.log(`[E2E] Search body: ${JSON.stringify(search.body)}`);

  const match = await request("/api/jobs/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ limit: 5, location: "Lagos", remote: true }),
  });
  console.log(`[E2E] Match status: ${match.res.status}`);
  console.log(`[E2E] Match body: ${JSON.stringify(match.body)}`);
}

main().catch((error) => {
  console.error(`[E2E] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
