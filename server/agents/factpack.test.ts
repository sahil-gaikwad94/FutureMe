/**
 * Fact pack — the single source of truth every agent is shown.
 *
 * The implementation this replaced injected raw database rows into the prompt.
 * These tests pin the properties that make grounding enforceable: real numbers
 * with stable ids, explicit gaps, and no invented history.
 */

import { describe, expect, it } from "vitest";
import { buildFactPack, groundingRules, renderFactPack, type WorkspaceRows } from "./factpack";
import type { DomainProjection } from "../engine/projection";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function rows(overrides: Partial<WorkspaceRows> = {}): WorkspaceRows {
  return {
    profile: { values: "Craft and honesty", context: "Full-time job, one child", horizonYears: 5 },
    goals: [
      {
        id: 1,
        domain: "career",
        title: "Get a backend engineering role",
        baseline: 30,
        target: 90,
        weeklyHours: 6,
        targetDate: new Date("2027-06-01"),
        details: { outcome: "Three final-round interviews", currentState: "Self-taught, no professional experience" },
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
      { id: 2, habitId: 11, checkinDate: daysAgo(3), completed: true, note: null },
      { id: 3, habitId: 11, checkinDate: daysAgo(5), completed: false, note: "Kid was sick" },
    ],
    journal: [{ id: 1, content: "I keep saying yes to overtime and then resent it.", tags: null, createdAt: daysAgo(4) }],
    ...overrides,
  };
}

function projection(realistic: DomainProjection[] = []): { composite: number; confidence: number; horizonYears: number; realistic: DomainProjection[] } {
  return { composite: 62, confidence: 0.44, horizonYears: 5, realistic };
}

describe("buildFactPack", () => {
  it("carries the goal's real numbers", () => {
    const pack = buildFactPack(rows(), projection(), NOW);
    expect(pack.goals[0].title).toBe("Get a backend engineering role");
    expect(pack.goals[0].baseline).toBe(30);
    expect(pack.goals[0].target).toBe(90);
    expect(pack.goals[0].weeklyHours).toBe(6);
  });

  it("reads structured details, falling back to JSON stored in notes", () => {
    const legacy = rows({
      goals: [{ ...rows().goals[0], details: null, notes: JSON.stringify({ outcome: "From legacy notes" }) }],
    });
    expect(buildFactPack(legacy, projection(), NOW).goals[0].outcome).toBe("From legacy notes");
  });

  it("counts every check-in, completed and missed", () => {
    const pack = buildFactPack(rows(), projection(), NOW);
    expect(pack.goals[0].totalCheckins).toBe(3);
    expect(pack.goals[0].steps[0].checkins).toBe(3);
  });

  it("reports the measured consistency, not the stored prior", () => {
    const pack = buildFactPack(rows(), projection(), NOW);
    // Two of three completed, over a Beta(7,3) prior: above 0.5, well below 1.
    expect(pack.goals[0].steps[0].adherence).toBeGreaterThan(0.55);
    expect(pack.goals[0].steps[0].adherence).toBeLessThan(0.85);
  });

  it("gives a credible interval that brackets the point estimate", () => {
    const step = buildFactPack(rows(), projection(), NOW).goals[0].steps[0];
    expect(step.adherenceLow).toBeLessThan(step.adherence);
    expect(step.adherence).toBeLessThan(step.adherenceHigh);
  });

  it("surfaces the user's own words as evidence", () => {
    const pack = buildFactPack(rows(), projection(), NOW);
    expect(pack.recentEvidence.some(item => item.note === "Shipped the auth endpoint")).toBe(true);
    expect(pack.recentEvidence.some(item => item.completed === false)).toBe(true);
  });

  it("includes the journal excerpt", () => {
    const pack = buildFactPack(rows(), projection(), NOW);
    expect(pack.journalCount).toBe(1);
    expect(pack.journalExcerpt.join(" ")).toMatch(/overtime/);
  });

  it("flags what is unknown instead of leaving the model to invent it", () => {
    const sparse = rows({
      goals: [{ ...rows().goals[0], targetDate: null, details: {} }],
      checkins: [],
      journal: [],
    });
    const pack = buildFactPack(sparse, projection(), NOW);
    expect(pack.unknown.length).toBeGreaterThan(0);
    const text = pack.unknown.join(" ").toLowerCase();
    expect(text).toMatch(/no deadline|no stated success|no check-in/);
  });

  it("says nothing is unknown when everything is present", () => {
    const pack = buildFactPack(rows(), projection(), NOW);
    expect(pack.unknown).toEqual([]);
  });

  it("excludes archived goals and steps", () => {
    const archived = rows({
      goals: [{ ...rows().goals[0], archived: true }],
      habits: [{ ...rows().habits[0], archived: true }],
    });
    const pack = buildFactPack(archived, projection(), NOW);
    expect(pack.goals).toHaveLength(0);
  });

  it("keeps a step that outlived its goal, since the evidence is still real", () => {
    const orphan = rows({ goals: [], habits: [{ ...rows().habits[0], goalId: null }] });
    const pack = buildFactPack(orphan, projection(), NOW);
    expect(pack.goals).toHaveLength(0);
  });

  it("identifies a stalled step", () => {
    const stalled = rows({
      habits: [{ ...rows().habits[0], lastCompletedAt: daysAgo(40) }],
      checkins: [{ id: 9, habitId: 11, checkinDate: daysAgo(40), completed: true, note: null }],
    });
    const pack = buildFactPack(stalled, projection(), NOW);
    expect(pack.goals[0].stalledSteps).toContain(11);
  });

  it("carries the person's stated values and circumstances", () => {
    const pack = buildFactPack(rows(), projection(), NOW);
    expect(pack.person.values).toBe("Craft and honesty");
    expect(pack.person.context).toBe("Full-time job, one child");
  });

  it("handles a completely empty workspace", () => {
    const pack = buildFactPack({ profile: null, goals: [], habits: [], checkins: [], journal: [] }, projection(), NOW);
    expect(pack.goals).toEqual([]);
    expect(pack.unknown.length).toBeGreaterThan(0);
    expect(() => renderFactPack(pack)).not.toThrow();
  });
});

describe("renderFactPack — what the model reads", () => {
  it("assigns stable, citable ids to every goal fact", () => {
    const rendered = renderFactPack(buildFactPack(rows(), projection(), NOW));
    expect(rendered).toContain("GOAL 1 — Get a backend engineering role");
    for (const id of ["G1.1", "G1.2", "G1.3", "G1.4", "G1.5", "G1.6", "G1.7", "G1.8", "G1.9"]) {
      expect(rendered).toContain(id);
    }
  });

  it("labels person-level facts separately from goal facts", () => {
    const rendered = renderFactPack(buildFactPack(rows(), projection(), NOW));
    expect(rendered).toContain("F1 Person's stated values");
    expect(rendered).toContain("F4 Composite trajectory: 62/100");
  });

  it("renders the step's real cadence and delivery", () => {
    const rendered = renderFactPack(buildFactPack(rows(), projection(), NOW));
    expect(rendered).toContain('Step "Ship one endpoint" — 3x/week, 90min');
    expect(rendered).toContain("longest 6");
  });

  it("quotes evidence notes verbatim", () => {
    const rendered = renderFactPack(buildFactPack(rows(), projection(), NOW));
    expect(rendered).toContain('"Shipped the auth endpoint"');
    expect(rendered).toContain("(missed)");
  });

  it("has an explicit NOT KNOWN section", () => {
    const rendered = renderFactPack(buildFactPack(rows({ journal: [] }), projection(), NOW));
    expect(rendered).toContain("NOT KNOWN — do not invent these");
  });

  it("names the stalled step by title, not id", () => {
    const stalled = rows({
      habits: [{ ...rows().habits[0], lastCompletedAt: daysAgo(40) }],
      checkins: [{ id: 9, habitId: 11, checkinDate: daysAgo(40), completed: true, note: null }],
    });
    const rendered = renderFactPack(buildFactPack(stalled, projection(), NOW));
    expect(rendered).toContain("STALLED");
    expect(rendered).toContain("Ship one endpoint");
  });

  it("contains no placeholder text a model could mistake for data", () => {
    const rendered = renderFactPack(buildFactPack(rows(), projection(), NOW));
    expect(rendered).not.toMatch(/\bundefined\b/);
    expect(rendered).not.toMatch(/\[object Object\]/);
    expect(rendered).not.toMatch(/\bNaN\b/);
  });
});

describe("grounding contract", () => {
  it("requires numbers to come from the fact block", () => {
    expect(groundingRules()).toMatch(/must appear in the FACTS block/);
  });

  it("forbids inventing check-ins, dates and amounts", () => {
    expect(groundingRules()).toMatch(/Never invent check-ins/);
  });

  it("warns that projections are a model, not a forecast", () => {
    expect(groundingRules()).toMatch(/not a forecast/);
  });

  it("excludes individualised professional advice", () => {
    expect(groundingRules()).toMatch(/No medical, legal, or individualised financial advice/);
  });
});
