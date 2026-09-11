/**
 * Planner agent.
 *
 * The agent this replaced selected one of four hardcoded five-item arrays keyed
 * by domain and never called a model, so every career goal got the same five
 * sentences. What matters is that a model call is actually attempted with the
 * user's own numbers, and that the offline path is still specific to them.
 */

import { describe, expect, it, vi } from "vitest";
import {
  deterministicPlan,
  fitsTimeBudget,
  generatePlan,
  PLANNER_SYSTEM,
  requestBrief,
  rescaleToBudget,
  weeklyMinutes,
  type PlanRequest,
} from "./planner";
import { groundingRules } from "./factpack";
import type { PlanDraft } from "./schemas";

function planRequest(overrides: Partial<PlanRequest> = {}): PlanRequest {
  return {
    title: "Get a backend engineering role",
    outcome: "Three final-round interviews",
    currentState: "Self-taught, no professional experience",
    deadline: "June 2027",
    domain: "career",
    weeklyHours: 6,
    baseline: 30,
    target: 90,
    targetYears: 1,
    bottleneck: "consistency",
    probabilityOfTarget: 0.06,
    probabilityAtFullAdherence: 0.48,
    requiredAdherence: 0.88,
    feasible: true,
    ...overrides,
  };
}

function modelResponse(plan: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const validPlan: PlanDraft = {
  reframedGoal: "Land three final-round interviews by June 2027",
  successMetric: { description: "Final-round interviews", target: "3", unit: "interviews", reviewBy: "2027-06-01" },
  feasibility: { verdict: "stretch", reasoning: "One year of runway at six hours a week." },
  steps: [
    { title: "Ship one portfolio endpoint", why: "Evidence beats theory.", weeklyFrequency: 2, minutesPerSession: 90, firstAction: "Pick the endpoint." },
    { title: "Send two tailored applications", why: "Interviews come from applications.", weeklyFrequency: 1, minutesPerSession: 60, firstAction: "List ten companies." },
    { title: "Record what actually happened", why: "The estimate is only as good as the evidence.", weeklyFrequency: 1, minutesPerSession: 15, firstAction: "Write one sentence." },
  ],
  risks: ["Applying before the portfolio can carry the conversation."],
  firstWeekAction: "Pick the endpoint tonight.",
};

describe("requestBrief — what the model is actually told", () => {
  it("carries the user's own numbers and words", () => {
    const brief = requestBrief(planRequest());
    expect(brief).toContain("Get a backend engineering role");
    expect(brief).toContain("Three final-round interviews");
    expect(brief).toContain("Self-taught, no professional experience");
    expect(brief).toContain("6h per week");
    expect(brief).toContain("Baseline 30 → target 90");
    expect(brief).toContain("6%");
  });

  it("names the binding constraint the engine found", () => {
    expect(requestBrief(planRequest({ bottleneck: "consistency" }))).toMatch(/consistency/i);
    expect(requestBrief(planRequest({ bottleneck: "effort" }))).not.toMatch(/Binding constraint: consistency/i);
  });

  it("switches to contribution arithmetic for finance goals", () => {
    const brief = requestBrief(
      planRequest({ domain: "finance", baseline: 2000, target: 50000, monthlyContribution: 300, weeklyHours: 1 }),
    );
    expect(brief).toMatch(/required to fund the target/);
    expect(brief).not.toMatch(/Consistency needed for even odds/);
  });
});

describe("grounding contract", () => {
  it("forbids inventing numbers", () => {
    expect(groundingRules()).toMatch(/do not state it/);
  });

  it("teaches the citation format the fact pack uses", () => {
    expect(groundingRules()).toContain("[G1.5]");
  });

  it("is part of the planner system prompt", () => {
    expect(PLANNER_SYSTEM).toContain("GROUNDING CONTRACT");
    expect(PLANNER_SYSTEM).toMatch(/not states of mind/);
  });
});

describe("generatePlan — model path", () => {
  it("calls the model and returns its plan", async () => {
    const fetchImpl = vi.fn(async () => modelResponse(validPlan));
    const result = await generatePlan(planRequest(), { client: { fetchImpl, maxAttempts: 1 } });
    expect(result.source).toBe("model");
    expect(result.plan.steps).toHaveLength(3);
    expect(result.model).toBeDefined();
    expect(result.degradedReason).toBeUndefined();
  });

  it("asks for JSON mode", async () => {
    const fetchImpl = vi.fn(async () => modelResponse(validPlan));
    await generatePlan(planRequest(), { client: { fetchImpl, maxAttempts: 1 } });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body)).response_format).toEqual({ type: "json_object" });
  });

  it("falls back and says so when the model is unreachable", async () => {
    const result = await generatePlan(planRequest(), {
      client: { fetchImpl: vi.fn(async () => new Response("no", { status: 503 })), maxAttempts: 1 },
    });
    expect(result.source).toBe("deterministic");
    expect(result.degradedReason).toMatch(/unavailable/i);
    expect(result.plan.steps.length).toBeGreaterThan(0);
  });

  it("falls back when the model returns prose instead of JSON", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "Great question! Here is some career advice." } }] }), { status: 200 }),
    );
    const result = await generatePlan(planRequest(), { client: { fetchImpl, maxAttempts: 1 } });
    expect(result.source).toBe("deterministic");
    expect(result.degradedReason).toMatch(/prose instead of JSON/);
  });

  it("falls back when the model's plan fails validation", async () => {
    const fetchImpl = vi.fn(async () => modelResponse({ reframedGoal: "x", successMetric: {}, steps: [] }));
    const result = await generatePlan(planRequest(), { client: { fetchImpl, maxAttempts: 1 } });
    expect(result.source).toBe("deterministic");
    expect(result.degradedReason).toMatch(/failed validation/);
  });

  it("rescales an over-budget plan instead of handing back something unrunnable", async () => {
    const bloated: PlanDraft = {
      ...validPlan,
      steps: [
        { title: "Grind leetcode daily", why: "Interviews.", weeklyFrequency: 7, minutesPerSession: 120, firstAction: "One problem." },
        { title: "Write a blog post", why: "Visibility.", weeklyFrequency: 2, minutesPerSession: 180, firstAction: "Outline it." },
        { title: "Attend a meetup every week", why: "Referrals.", weeklyFrequency: 1, minutesPerSession: 180, firstAction: "Find one." },
      ],
    };
    // 7*120 + 2*180 + 1*180 = 1380 minutes = 23h against a 6h budget.
    expect(fitsTimeBudget(bloated, 6)).toBe(false);
    const fetchImpl = vi.fn(async () => modelResponse(bloated));
    const result = await generatePlan(planRequest({ weeklyHours: 6 }), { client: { fetchImpl, maxAttempts: 1 } });
    expect(result.source).toBe("model");
    expect(result.degradedReason).toMatch(/rescaled/i);
    expect(weeklyMinutes(result.plan)).toBeLessThanOrEqual(6 * 60);
    expect(result.plan.steps).toHaveLength(3); // kept, not dropped
  });

  it("leaves a plan that fits alone", async () => {
    expect(fitsTimeBudget(validPlan, 6)).toBe(true);
    const fetchImpl = vi.fn(async () => modelResponse(validPlan));
    const result = await generatePlan(planRequest({ weeklyHours: 6 }), { client: { fetchImpl, maxAttempts: 1 } });
    expect(result.degradedReason).toBeUndefined();
  });

  it("propagates an abort rather than silently falling back", async () => {
    const signal = AbortSignal.abort();
    await expect(
      generatePlan(planRequest(), { signal, client: { fetchImpl: vi.fn(async () => modelResponse(validPlan)) } }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });
});

describe("rescaleToBudget", () => {
  it("still fits when frequency alone cannot get there", () => {
    // 7 steps of 8h each: scaling cadence to its fortnightly floor leaves this
    // far over a 4h budget, so session length has to come down too.
    const impossible: PlanDraft = {
      ...validPlan,
      steps: Array.from({ length: 7 }, (_, index) => ({
        title: `Long block ${index + 1}`,
        why: "Needs real time.",
        weeklyFrequency: 7,
        minutesPerSession: 480,
        firstAction: "Start.",
      })),
    };
    const scaled = rescaleToBudget(impossible, 4);
    expect(weeklyMinutes(scaled)).toBeLessThanOrEqual(4 * 60);
    expect(scaled.steps.length).toBeGreaterThan(0);
  });

  it("keeps every step and shrinks them proportionally", () => {
    const bloated: PlanDraft = {
      ...validPlan,
      steps: [
        { ...validPlan.steps[0], weeklyFrequency: 4, minutesPerSession: 120 },
        { ...validPlan.steps[1], weeklyFrequency: 4, minutesPerSession: 120 },
      ],
    };
    const scaled = rescaleToBudget(bloated, 4);
    expect(scaled.steps).toHaveLength(2);
    expect(weeklyMinutes(scaled)).toBeLessThanOrEqual(4 * 60);
    // No step may be silently zeroed out.
    for (const step of scaled.steps) {
      // Half a session a week (fortnightly) is a legitimate cadence; below that
      // the step is decoration.
      expect(step.weeklyFrequency).toBeGreaterThanOrEqual(0.5);
      expect(step.minutesPerSession).toBeGreaterThanOrEqual(10);
    }
  });
});

describe("deterministicPlan — the offline path must still be useful", () => {
  it("produces steps with a first action each", () => {
    const { plan } = deterministicPlan(planRequest());
    expect(plan.steps.length).toBeGreaterThanOrEqual(3);
    for (const step of plan.steps) {
      expect(step.title.length).toBeGreaterThan(8);
      expect(step.firstAction.length).toBeGreaterThan(3);
      // Half a session a week (fortnightly) is a legitimate cadence; below that
      // the step is decoration.
      expect(step.weeklyFrequency).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("fits the committed time budget at every commitment level", () => {
    // Regression: the offline plan asked for 599 minutes against a 360-minute
    // commitment — 66% more time than the user said they had — while the model
    // path was rescaled to fit. Both paths now go through the same rule.
    for (const weeklyHours of [1, 2, 3, 6, 10, 20]) {
      const { plan } = deterministicPlan(planRequest({ weeklyHours }));
      expect(weeklyMinutes(plan)).toBeLessThanOrEqual(weeklyHours * 60);
    }
  });

  it("still leaves headroom rather than consuming all stated capacity", () => {
    const { plan } = deterministicPlan(planRequest({ weeklyHours: 6 }));
    expect(weeklyMinutes(plan)).toBeLessThan(6 * 60 * 0.9);
  });

  it("keeps enough steps to be a plan after rescaling a tiny budget", () => {
    const { plan } = deterministicPlan(planRequest({ weeklyHours: 1 }));
    expect(plan.steps.length).toBeGreaterThanOrEqual(3);
    expect(weeklyMinutes(plan)).toBeLessThanOrEqual(60);
  });

  it("references the user's own words rather than a canned template", () => {
    const { plan } = deterministicPlan(planRequest());
    const text = `${plan.reframedGoal} ${plan.feasibility.reasoning} ${plan.risks.join(" ")}`;
    expect(text.toLowerCase()).toContain("interview");
  });

  it("varies its diagnosis with the binding constraint", () => {
    const { plan: consistency } = deterministicPlan(planRequest({ bottleneck: "consistency", feasible: true }));
    const { plan: effort } = deterministicPlan(planRequest({ bottleneck: "effort", feasible: false, weeklyHours: 1.5, probabilityAtFullAdherence: 0.05 }));
    expect(consistency.feasibility.reasoning).not.toEqual(effort.feasibility.reasoning);
    expect(effort.feasibility.verdict).toBe("unrealistic");
  });

  it("names the funding gap for an unfunded finance goal", () => {
    const { plan } = deterministicPlan(
      planRequest({ domain: "finance", bottleneck: "funding", feasible: false, baseline: 2000, target: 50000, monthlyContribution: 100 }),
    );
    expect(JSON.stringify(plan)).toMatch(/month/i);
  });

  it("never emits a generic 'could not reach the model' sentence", () => {
    const { plan } = deterministicPlan(planRequest());
    const text = JSON.stringify(plan).toLowerCase();
    expect(text).not.toContain("unable to reach");
    expect(text).not.toContain("try again later");
    expect(text).not.toContain("i'm sorry");
  });

  it("reports itself as deterministic so the UI can show provenance", () => {
    expect(deterministicPlan(planRequest()).source).toBe("deterministic");
  });
});
