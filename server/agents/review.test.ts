/**
 * Review agent.
 *
 * The weekly review is the one place the product judges the user's execution
 * against their own plan. The failure mode to prevent is a flattering narrative
 * that does not match the numbers, so the metrics are computed separately from
 * the prose and asserted independently.
 */

import { describe, expect, it, vi } from "vitest";
import { computeMetrics, deterministicReview, generateReview } from "./review";
import { buildFactPack, type WorkspaceRows } from "./factpack";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function pack(options: { completed: number[]; missed: number[]; frequency?: number; lastCompleted?: number } = { completed: [1, 3, 6], missed: [4] }) {
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
        weeklyFrequency: options.frequency ?? 3,
        minutesPerSession: 90,
        adherencePrior: 0.5,
        betaAlpha: 7,
        betaBeta: 3,
        currentStreak: 1,
        longestStreak: 3,
        sortOrder: 0,
        lastCompletedAt: daysAgo(options.lastCompleted ?? Math.min(...options.completed)),
        createdAt: daysAgo(120),
      },
    ],
    checkins: [
      ...options.completed.map((day, index) => ({ id: index + 1, habitId: 11, checkinDate: daysAgo(day), completed: true, note: `session ${index + 1}` })),
      ...options.missed.map((day, index) => ({ id: 100 + index, habitId: 11, checkinDate: daysAgo(day), completed: false, note: null })),
    ],
    journal: [],
  };
  return buildFactPack(rows, { composite: 62, confidence: 0.44, horizonYears: 5, realistic: [] }, NOW);
}

function modelReview(body: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const validReview = {
  summary: "Three sessions delivered against nine asked for. The cadence is the problem, not the work.",
  wins: ["Shipped three endpoints [G1.P1]"],
  stalls: ["Ship one endpoint is at 33% of its cadence [G1.6]"],
  changes: ["Cut the cadence to 2x/week so the commitment is credible."],
  nextActions: [{ title: "Ship one endpoint", weeklyFrequency: 2, minutesPerSession: 90, replacesStepId: 11 }],
};

describe("computeMetrics", () => {
  it("counts what was delivered against what was asked", () => {
    const metrics = computeMetrics(pack(), 14, NOW);
    expect(metrics.deliveredActions).toBe(3);
    expect(metrics.expectedActions).toBeGreaterThan(3);
  });

  it("reports a delivery rate consistent with its own inputs", () => {
    const metrics = computeMetrics(pack(), 14, NOW);
    const expected = Number(metrics.expectedActions);
    const rate = Number(metrics.deliveryRate);
    expect(rate).toBeCloseTo(Number(metrics.deliveredActions) / expected, 2);
  });

  it("never exceeds 1", () => {
    const metrics = computeMetrics(pack({ completed: [0, 1, 2, 3, 4, 5], missed: [] }), 14);
    expect(Number(metrics.deliveryRate)).toBeLessThanOrEqual(1);
  });

  it("is zero when nothing happened in the window", () => {
    const metrics = computeMetrics(pack({ completed: [80], missed: [], lastCompleted: 80 }), 14);
    expect(Number(metrics.deliveredActions)).toBe(0);
  });

  it("excludes evidence outside the window", () => {
    const wide = computeMetrics(pack({ completed: [1, 40], missed: [] }), 60);
    const narrow = computeMetrics(pack({ completed: [1, 40], missed: [] }), 14);
    expect(Number(wide.deliveredActions)).toBeGreaterThan(Number(narrow.deliveredActions));
  });

  it("counts missed check-ins as evidence rather than ignoring them", () => {
    const withMisses = computeMetrics(pack({ completed: [1], missed: [2, 3, 4, 5] }), 14);
    const withoutMisses = computeMetrics(pack({ completed: [1], missed: [] }), 14);
    expect(Number(withMisses.missedActions)).toBe(4);
    expect(Number(withoutMisses.missedActions)).toBe(0);
  });

  it("handles a workspace with no steps", () => {
    const empty = buildFactPack({ profile: null, goals: [], habits: [], checkins: [], journal: [] }, { composite: 50, confidence: 0.3, horizonYears: 5, realistic: [] }, NOW);
    const metrics = computeMetrics(empty, 14, NOW);
    expect(Number.isFinite(Number(metrics.deliveryRate))).toBe(true);
  });
});

describe("generateReview — model path", () => {
  it("returns the model's review alongside the computed metrics", async () => {
    const fetchImpl = vi.fn(async () => modelReview(validReview));
    const result = await generateReview(pack(), { client: { fetchImpl, maxAttempts: 1 } });
    expect(result.source).toBe("model");
    expect(result.review.nextActions).toHaveLength(1);
    expect(result.metrics.deliveredActions).toBe(3);
  });

  it("shows the model the metrics so its prose can be audited against them", async () => {
    const fetchImpl = vi.fn(async () => modelReview(validReview));
    await generateReview(pack(), { client: { fetchImpl, maxAttempts: 1 } });
    const sent = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    const text = sent.messages.map((m: any) => m.content).join("\n");
    expect(text).toContain("Computed metrics for that window");
    expect(text).toContain("deliveredActions");
  });

  it("falls back and says so when the model is down", async () => {
    const result = await generateReview(pack(), { client: { fetchImpl: vi.fn(async () => new Response("no", { status: 503 })), maxAttempts: 1 } });
    expect(result.source).toBe("deterministic");
    expect(result.degradedReason).toMatch(/unavailable/i);
    expect(result.review.summary.length).toBeGreaterThan(30);
  });

  it("falls back when the review fails validation", async () => {
    const fetchImpl = vi.fn(async () => modelReview({ summary: "too short", wins: [] }));
    const result = await generateReview(pack(), { client: { fetchImpl, maxAttempts: 1 } });
    expect(result.source).toBe("deterministic");
    expect(result.degradedReason).toMatch(/validation|JSON/i);
  });

  it("propagates an abort rather than falling back", async () => {
    await expect(
      generateReview(pack(), { signal: AbortSignal.abort(), client: { fetchImpl: vi.fn(async () => modelReview(validReview)) } }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });
});

describe("deterministicReview", () => {
  it("states the real delivery numbers", () => {
    const target = pack();
    const metrics = computeMetrics(target, 14, NOW);
    const review = deterministicReview(target, metrics);
    expect(review.summary).toMatch(/\d/);
    expect(review.nextActions.length).toBeGreaterThan(0);
  });

  it("calls a stall a stall instead of praising an empty week", () => {
    const stalled = pack({ completed: [40], missed: [], lastCompleted: 40 });
    const metrics = computeMetrics(stalled, 14, NOW);
    const review = deterministicReview(stalled, metrics);
    expect(Number(metrics.deliveredActions)).toBe(0);
    expect(review.stalls.length).toBeGreaterThan(0);
    expect(review.wins).toHaveLength(0);
  });

  it("does not invent a win when nothing was delivered", () => {
    const stalled = pack({ completed: [40], missed: [], lastCompleted: 40 });
    const review = deterministicReview(stalled, computeMetrics(stalled, 14, NOW));
    expect(review.wins).toHaveLength(0);
  });

  it("prefers shrinking a step over adding one", () => {
    const target = pack();
    const review = deterministicReview(target, computeMetrics(target, 14, NOW));
    const originalSteps = target.goals[0].steps.length;
    expect(review.nextActions.length).toBeLessThanOrEqual(Math.max(1, originalSteps));
  });

  it("always gives at least one change and one next action", () => {
    for (const scenario of [
      { completed: [1, 3, 6], missed: [4] },
      { completed: [40], missed: [], lastCompleted: 40 },
      { completed: [0, 1, 2], missed: [] },
    ]) {
      const target = pack(scenario as any);
      const review = deterministicReview(target, computeMetrics(target, 14, NOW));
      expect(review.changes.length).toBeGreaterThan(0);
      expect(review.nextActions.length).toBeGreaterThan(0);
      expect(review.summary.length).toBeGreaterThan(30);
    }
  });

  it("handles an empty workspace without throwing", () => {
    const empty = buildFactPack({ profile: null, goals: [], habits: [], checkins: [], journal: [] }, { composite: 50, confidence: 0.3, horizonYears: 5, realistic: [] }, NOW);
    const review = deterministicReview(empty, computeMetrics(empty, 14, NOW));
    expect(review.summary.length).toBeGreaterThan(10);
    expect(review.summary.toLowerCase()).not.toContain("undefined");
  });
});
