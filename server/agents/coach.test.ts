/**
 * Coach agent.
 *
 * The implementation this replaced held the conversation in a useState array
 * that was never read from the database, and on any model failure returned one
 * hardcoded sentence with HTTP 200 — so the user could not tell a real answer
 * from a stub. Provenance is the thing under test here.
 */

import { describe, expect, it, vi } from "vitest";
import { coach, coachStream, coachSystemPrompt, deterministicCoach, extractCitedFacts } from "./coach";
import { buildFactPack, type WorkspaceRows } from "./factpack";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function factPack(): ReturnType<typeof buildFactPack> {
  const rows: WorkspaceRows = {
    profile: { values: "Craft", context: "Full-time job", horizonYears: 5 },
    goals: [
      {
        id: 1,
        domain: "career",
        title: "Get a backend engineering role",
        baseline: 30,
        target: 90,
        weeklyHours: 6,
        targetDate: new Date("2027-06-01"),
        details: { outcome: "Three final-round interviews" },
        notes: null,
        createdAt: daysAgo(200),
      },
    ],
    habits: [
      {
        id: 11,
        goalId: 1,
        domain: "career",
        title: "Ship one endpoint",
        weeklyFrequency: 3,
        minutesPerSession: 90,
        adherencePrior: 0.5,
        betaAlpha: 7,
        betaBeta: 3,
        currentStreak: 2,
        longestStreak: 6,
        sortOrder: 0,
        lastCompletedAt: daysAgo(2),
        createdAt: daysAgo(120),
      },
    ],
    checkins: [
      { id: 1, habitId: 11, checkinDate: daysAgo(1), completed: true, note: "Shipped the auth endpoint" },
      { id: 2, habitId: 11, checkinDate: daysAgo(5), completed: false, note: "Kid was sick" },
    ],
    journal: [],
  };
  return buildFactPack(rows, { composite: 62, confidence: 0.44, horizonYears: 5, realistic: [] }, NOW);
}

const messages = [{ role: "user" as const, content: "Am I on track?" }];

function modelReply(text: string, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status, headers: { "Content-Type": "application/json" } });
}

describe("coachSystemPrompt", () => {
  it("includes the fact pack so the model has numbers to cite", () => {
    const prompt = coachSystemPrompt(factPack(), "coach");
    expect(prompt).toContain("GROUNDING CONTRACT");
    expect(prompt).toContain("Get a backend engineering role");
    expect(prompt).toContain("[G1.5]");
  });

  it("changes the directive per mode", () => {
    const pack = factPack();
    expect(coachSystemPrompt(pack, "coach")).not.toEqual(coachSystemPrompt(pack, "critic"));
    expect(coachSystemPrompt(pack, "critic")).not.toEqual(coachSystemPrompt(pack, "celebrate"));
  });
});

describe("coach — model path", () => {
  it("returns the model's reply with provenance", async () => {
    const fetchImpl = vi.fn(async () => modelReply("You are at 69% consistency [G1.5]. Ship the endpoint Thursday."));
    const reply = await coach({ factPack: factPack(), messages }, { client: { fetchImpl, maxAttempts: 1 } });
    expect(reply.source).toBe("model");
    expect(reply.model).toBeDefined();
    expect(reply.degradedReason).toBeUndefined();
  });

  it("extracts the fact ids the reply cites", async () => {
    const fetchImpl = vi.fn(async () => modelReply("Consistency is 69% [G1.5] and delivery 2/12 [G1.6]."));
    const reply = await coach({ factPack: factPack(), messages }, { client: { fetchImpl, maxAttempts: 1 } });
    expect(reply.groundedOn).toContain("G1.5");
    expect(reply.groundedOn).toContain("G1.6");
  });

  it("sends the conversation history, most recent last", async () => {
    const fetchImpl = vi.fn(async () => modelReply("ok"));
    await coach(
      {
        factPack: factPack(),
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "reply" },
          { role: "user", content: "second" },
        ],
      },
      { client: { fetchImpl, maxAttempts: 1 } },
    );
    const sent = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages.slice(1).map((m: any) => m.content)).toEqual(["first", "reply", "second"]);
  });

  it("caps the history sent to the model", async () => {
    const fetchImpl = vi.fn(async () => modelReply("ok"));
    await coach(
      { factPack: factPack(), messages: Array.from({ length: 40 }, (_, i) => ({ role: "user" as const, content: `m${i}` })) },
      { client: { fetchImpl, maxAttempts: 1 } },
    );
    const sent = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(sent.messages.length).toBeLessThanOrEqual(13); // system + 12 history
  });

  it("falls back to a real answer when the model is down, and says so", async () => {
    const reply = await coach({ factPack: factPack(), messages }, { client: { fetchImpl: vi.fn(async () => new Response("no", { status: 503 })), maxAttempts: 1 } });
    expect(reply.source).toBe("deterministic");
    expect(reply.degradedReason).toBeTruthy();
    expect(reply.content.length).toBeGreaterThan(40);
  });

  it("never returns an empty reply", async () => {
    const reply = await coach({ factPack: factPack(), messages }, { client: { fetchImpl: vi.fn(async () => modelReply("")), maxAttempts: 1 } });
    expect(reply.content.trim().length).toBeGreaterThan(0);
  });

  it("propagates an abort instead of falling back", async () => {
    await expect(
      coach({ factPack: factPack(), messages, signal: AbortSignal.abort() }, { client: { fetchImpl: vi.fn(async () => modelReply("ok")) } }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });
});

describe("deterministicCoach — the offline answer must be specific", () => {
  it("cites the user's real numbers", () => {
    const reply = deterministicCoach(factPack(), "coach");
    expect(reply.content).toMatch(/\d/);
    expect(reply.content).toContain("Get a backend engineering role");
    expect(reply.source).toBe("deterministic");
  });

  it("is not the same sentence for a different workspace", () => {
    const healthy = deterministicCoach(factPack(), "coach");
    const pack = buildFactPack(
      {
        profile: null,
        goals: [
          {
            id: 2,
            domain: "health",
            title: "Run a 10k",
            baseline: 5,
            target: 10,
            weeklyHours: 3,
            targetDate: null,
            details: { outcome: "Finish under 60 minutes" },
            notes: null,
            createdAt: daysAgo(30),
          },
        ],
        habits: [],
        checkins: [],
        journal: [],
      },
      { composite: 40, confidence: 0.2, horizonYears: 5, realistic: [] },
      NOW,
    );
    expect(deterministicCoach(pack, "coach").content).not.toEqual(healthy.content);
  });

  it("changes tone per mode without becoming generic", () => {
    const pack = factPack();
    const coachReply = deterministicCoach(pack, "coach");
    const criticReply = deterministicCoach(pack, "critic");
    expect(coachReply.content).not.toEqual(criticReply.content);
    expect(criticReply.content.length).toBeGreaterThan(40);
  });

  it("handles an empty workspace without throwing", () => {
    const pack = buildFactPack({ profile: null, goals: [], habits: [], checkins: [], journal: [] }, { composite: 50, confidence: 0.3, horizonYears: 5, realistic: [] }, NOW);
    const reply = deterministicCoach(pack, "coach");
    expect(reply.content.length).toBeGreaterThan(20);
    expect(reply.content.toLowerCase()).not.toContain("undefined");
  });

  it("never uses the canned apology the old fallback returned", () => {
    const reply = deterministicCoach(factPack(), "coach");
    expect(reply.content.toLowerCase()).not.toContain("i'm unable to");
    expect(reply.content.toLowerCase()).not.toContain("please try again later");
  });
});

describe("extractCitedFacts", () => {
  it("pulls bracketed ids out of prose", () => {
    expect(extractCitedFacts("Consistency is 69% [G1.5] and 2/12 delivered [G1.6].")).toEqual(["G1.5", "G1.6"]);
  });

  it("de-duplicates repeated citations", () => {
    expect(extractCitedFacts("[F4] and again [F4]")).toEqual(["F4"]);
  });

  it("returns an empty list when nothing is cited", () => {
    expect(extractCitedFacts("No citations here.")).toEqual([]);
  });
});

describe("coachStream", () => {
  function sse(frames: string[]) {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }

  it("streams deltas and terminates with a done frame", async () => {
    const fetchImpl = vi.fn(async () => sse(['data: {"choices":[{"delta":{"content":"You are "}}]}\n\n', 'data: {"choices":[{"delta":{"content":"on track"}}]}\n\ndata: [DONE]\n\n']));
    const frames: string[] = [];
    let last: any;
    for await (const frame of coachStream({ factPack: factPack(), messages }, { client: { fetchImpl } })) {
      if (frame.done) last = frame;
      else frames.push(frame.delta);
    }
    expect(frames.join("")).toBe("You are on track");
    expect(last.done).toBe(true);
    expect(last.source).toBe("model");
  });

  it("yields the deterministic answer rather than an error when the model fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 503 }));
    const frames: string[] = [];
    let degraded: string | undefined;
    for await (const frame of coachStream({ factPack: factPack(), messages }, { client: { fetchImpl, maxAttempts: 1 } })) {
      if (!frame.done) frames.push(frame.delta);
      if (frame.degradedReason) degraded = frame.degradedReason;
    }
    expect(frames.join("").length).toBeGreaterThan(20);
    expect(degraded).toBeTruthy();
  });

  it("falls back when the stream opens but emits nothing", async () => {
    const fetchImpl = vi.fn(async () => sse(["data: [DONE]\n\n"]));
    const frames: string[] = [];
    let source: string | undefined;
    for await (const frame of coachStream({ factPack: factPack(), messages }, { client: { fetchImpl } })) {
      if (!frame.done) {
        frames.push(frame.delta);
        source = frame.source;
      }
    }
    expect(frames.join("").length).toBeGreaterThan(20);
    expect(source).toBe("deterministic");
  });
});
