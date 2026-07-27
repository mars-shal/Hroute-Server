import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ResumeBuilderController } from "./controller/resumeBuilder.js";
import type { DatabaseLike } from "./model/database.js";

const TIMEOUT = 30_000;

const mockDb = {
  getUser: async () => ({ status: 200, resume_text: "", display_name: "", email: "", location: "", skills: [], experience: null }),
  uploadFile: async () => ({ status: 200 }),
  getGeneratedResumeUrl: async () => ({ status: 200, url: undefined }),
  updateUser: async () => ({ status: 200 }),
  authenticateToken: async () => ({ status: 200, userId: "test-user-1" }),
} as unknown as DatabaseLike;

let controller: ResumeBuilderController;
let sessionId: string;

beforeAll(async () => {
  controller = new ResumeBuilderController(mockDb);
  const session = await controller.createSession("test-user-1");
  sessionId = session.id;
}, TIMEOUT);

afterAll(async () => {
  if (sessionId) {
    await controller.deleteSession(sessionId);
  }
});

describe("ResumeBuilder chat flow", () => {
  it("creates session with empty fields", async () => {
    const session = await controller.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.full_name).toBe("");
    expect(session!.chat_history).toEqual([]);
  });

  it("accepts name → moves to email", async () => {
    const res = await controller.processMessage(sessionId, "My name is Ada Lovelace");

    expect(res.missing_fields).not.toContain("full_name");
    expect(res.missing_fields[0]).toBe("email");
    expect(res.ats_score.score).toBeNumber();
    expect(res.message.toLowerCase()).not.toContain("ats score");
  }, TIMEOUT);

  it("accepts email → moves to phone", async () => {
    const res = await controller.processMessage(sessionId, "ada@example.com");

    expect(res.missing_fields).not.toContain("email");
    expect(res.missing_fields[0]).toBe("phone");
  }, TIMEOUT);

  it("accepts phone → moves to location", async () => {
    const res = await controller.processMessage(sessionId, "+1234567890");

    expect(res.missing_fields).not.toContain("phone");
    expect(res.missing_fields[0]).toBe("location");
  }, TIMEOUT);

  it("accepts location → moves to summary", async () => {
    const res = await controller.processMessage(sessionId, "Lagos, Nigeria");

    expect(res.missing_fields).not.toContain("location");
    expect(res.missing_fields[0]).toBe("summary");
  }, TIMEOUT);

  it("accepts ANY summary without re-asking → moves to skills", async () => {
    const res = await controller.processMessage(sessionId, "I love building stuff");

    expect(res.missing_fields).not.toContain("summary");
    expect(res.missing_fields[0]).toBe("skills");
  }, TIMEOUT);

  it("chat_history grows with each turn", async () => {
    const session = await controller.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.chat_history.length).toBeGreaterThanOrEqual(10);
  });

  it("message has no corporate speak", async () => {
    const res = await controller.processMessage(sessionId, "React, TypeScript, Node.js");

    const msg = res.message.toLowerCase();
    expect(msg).not.toContain("please provide");
    expect(msg).not.toContain("this information is crucial");
    expect(msg).not.toContain("to continue");
    expect(msg).not.toContain("as measured by");
  }, TIMEOUT);
});
