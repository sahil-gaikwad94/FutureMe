/**
 * Workspace → projection mapping.
 *
 * The implementation this replaced wrote `baseline: 0, target: 100` for every
 * goal regardless of what the user entered, took only the first habit per
 * domain, and defaulted a finance target to 86 — a readiness score, not money.
 * Every regression test here pins one of those.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, seedGoal, seedStep, seedUser, type TestDb } from "./test/db";
import { projectionInputs, projectWorkspace, workspaceContext, emptyWorkspace } from "./workspace";

let harness: TestDb;
let userId: number;

beforeEach(async () => {
  harness = createTestDb();
  const user = await seedUser(harness.db);
  userId = user.id;
});

const workspaceFor = async () => {
  const { loadWorkspace } = await import("./workspace");
  return (await loadWorkspace(harness.db, harness.tables, userId))!;
};

describe("projectionInputs", () => {
  it("uses the goal's real baseline and target, not constants", async () => {
    await seedGoal(harness.db, userId, { baseline: 22, target: 78 });
    const inputs = projectionInputs(await workspaceFor());
    expect(inputs.career?.baseline).toBe(22);
    expect(inputs.career?.target).toBe(78);
  });

  it("regression: does not fall back to baseline 0 / target 100", async () => {
    await seedGoal(harness.db, userId, { baseline: 45, target: 88 });
    const inputs = projectionInputs(await workspaceFor());
    expect(inputs.career?.baseline).not.toBe(0);
    expect(inputs.career?.target).not.toBe(100);
  });

  it("keeps finance targets in currency rather than a readiness score", async () => {
    await seedGoal(harness.db, userId, { domain: "finance", baseline: 3000, target: 60000, details: { monthlyContribution: 500 } });
    const inputs = projectionInputs(await workspaceFor());
    expect(inputs.finance?.target).toBe(60000);
    expect(inputs.finance?.monthlyContribution).toBe(500);
  });

  it("sums committed hours across every goal in a domain", async () => {
    await seedGoal(harness.db, userId, { title: "First", baseline: 20, target: 80, weeklyHours: 3 });
    await seedGoal(harness.db, userId, { title: "Second", baseline: 30, target: 90, weeklyHours: 4 });
    const inputs = projectionInputs(await workspaceFor());
    expect(inputs.career?.weeklyHours).toBe(7);
  });

  it("tracks the most ambitious goal rather than averaging two unrelated ones", async () => {
    await seedGoal(harness.db, userId, { title: "Small", baseline: 50, target: 60 });
    await seedGoal(harness.db, userId, { title: "Large", baseline: 10, target: 95 });
    const inputs = projectionInputs(await workspaceFor());
    // Averaging would give baseline 30 / target 77.5 — a goal nobody set.
    expect(inputs.career?.baseline).toBe(10);
    expect(inputs.career?.target).toBe(95);
  });

  it("sums step cadences into the domain frequency", async () => {
    const goal = await seedGoal(harness.db, userId);
    await seedStep(harness.db, userId, goal.id, { weeklyFrequency: 3 });
    await seedStep(harness.db, userId, goal.id, { weeklyFrequency: 2 });
    const inputs = projectionInputs(await workspaceFor());
    expect(inputs.career?.frequency).toBe(5);
  });

  it("derives adherence from check-ins across every step, not one stored prior", async () => {
    const goal = await seedGoal(harness.db, userId);
    const step = await seedStep(harness.db, userId, goal.id, { betaAlpha: 5, betaBeta: 5 });
    for (let index = 0; index < 10; index += 1) {
      await harness.db.insert(harness.tables.checkins).values({
        userId,
        habitId: step.id,
        checkinDate: new Date(Date.now() - index * 86_400_000),
        completed: true,
      });
    }
    const inputs = projectionInputs(await workspaceFor());
    expect(inputs.career?.evidenceCount).toBe(10);
    // Beta(5,5) prior (mean 0.5) plus ~9.7 decay-weighted completions gives
    // about 0.75. The assertion that matters is that the evidence moved the
    // estimate off the prior and that the posterior mass actually grew.
    expect(inputs.career?.adherence).toBeGreaterThan(0.7);
    expect(inputs.career?.adherence).toBeLessThan(0.85);
    expect(inputs.career?.alpha).toBeGreaterThan(5);
    expect(inputs.career?.beta).toBe(5);
  });

  it("excludes archived goals and steps", async () => {
    const goal = await seedGoal(harness.db, userId);
    await seedStep(harness.db, userId, goal.id, { archived: true });
    await harness.db.update(harness.tables.goals).set({ archived: true }).where(harness.tables.goals.id ? (await import("drizzle-orm")).eq(harness.tables.goals.id, goal.id) : undefined);
    const inputs = projectionInputs(await workspaceFor());
    expect(inputs.career).toBeUndefined();
  });

  it("still counts a step whose goal was deleted, since the effort is real", async () => {
    await seedStep(harness.db, userId, null as any, { weeklyFrequency: 2, minutesPerSession: 45 });
    const inputs = projectionInputs(await workspaceFor());
    expect(inputs.career?.frequency).toBe(2);
  });

  it("derives targetYears from the goal's deadline", async () => {
    const inOneYear = new Date(Date.now() + 365 * 86_400_000);
    await seedGoal(harness.db, userId, { targetDate: inOneYear });
    const inputs = projectionInputs(await workspaceFor(), { horizonYears: 5 });
    expect(inputs.career?.targetYears).toBe(1);
  });

  it("clamps a past deadline to one year rather than producing a negative horizon", async () => {
    await seedGoal(harness.db, userId, { targetDate: new Date(Date.now() - 400 * 86_400_000) });
    const inputs = projectionInputs(await workspaceFor());
    expect(inputs.career?.targetYears).toBe(1);
  });

  it("applies an adherence override when one is supplied", async () => {
    await seedGoal(harness.db, userId);
    const inputs = projectionInputs(await workspaceFor(), { adherenceOverride: 0.42 });
    expect(inputs.career?.adherence).toBeCloseTo(0.42, 5);
  });

  it("reads the horizon from the profile when set", async () => {
    await harness.db.insert(harness.tables.profiles).values({ userId, values: "x", context: "y", horizonYears: 10 });
    await seedGoal(harness.db, userId);
    expect(projectionInputs(await workspaceFor()).career?.horizonYears).toBe(10);
  });
});

describe("projectWorkspace", () => {
  it("projects only the domains the user has goals in", async () => {
    await seedGoal(harness.db, userId, { domain: "health" });
    const bundle = projectWorkspace(await workspaceFor());
    expect(bundle.activeDomains).toEqual(["health"]);
    expect(bundle.projection.scenarios.realistic).toHaveLength(1);
  });

  it("produces a stable seed so repeated runs are comparable", async () => {
    await seedGoal(harness.db, userId);
    const first = projectWorkspace(await workspaceFor());
    const second = projectWorkspace(await workspaceFor());
    expect(first.projection).toEqual(second.projection);
  });

  it("handles an empty workspace without throwing", () => {
    const bundle = projectWorkspace(emptyWorkspace);
    expect(bundle.activeDomains).toEqual([]);
    expect(bundle.projection.scenarios.realistic.length).toBeGreaterThan(0);
  });
});

describe("workspaceContext", () => {
  it("builds a fact pack that carries the goal's real numbers", async () => {
    const goal = await seedGoal(harness.db, userId, { baseline: 25, target: 85, weeklyHours: 7 });
    await seedStep(harness.db, userId, goal.id);
    const { factPack } = workspaceContext(await workspaceFor());
    expect(factPack.goals).toHaveLength(1);
    expect(factPack.goals[0].baseline).toBe(25);
    expect(factPack.goals[0].target).toBe(85);
    expect(factPack.goals[0].weeklyHours).toBe(7);
    expect(factPack.goals[0].steps).toHaveLength(1);
  });

  it("flags what is unknown rather than letting the model fill it in", async () => {
    await seedGoal(harness.db, userId, { details: {} });
    const { factPack } = workspaceContext(await workspaceFor());
    expect(factPack.unknown.length).toBeGreaterThan(0);
    expect(factPack.unknown.join(" ")).toMatch(/check-in evidence|no stated success|no deadline/i);
  });
});
