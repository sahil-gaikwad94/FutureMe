/**
 * Router end-to-end tests.
 *
 * These run the real tRPC procedures against the real Drizzle schema (the
 * project's own migrations applied to an in-memory Postgres), so a query that
 * compiles but does not match a column, or a mutation that returns the wrong
 * shape, fails here rather than in production. Authentication is injected at the
 * context boundary; the auth middleware itself is covered by
 * server/auth.logout.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appRouter } from "./routers";
import * as db from "./db";
import { createTestDb, seedUser, type TestDb } from "./test/db";

let harness: TestDb;
let userId: number;
let caller: ReturnType<typeof appRouter.createCaller>;
let anon: ReturnType<typeof appRouter.createCaller>;

const goalInput = {
  title: "Get a backend engineering role",
  outcome: "Three final-round interviews by June 2027",
  currentState: "Self-taught, building side projects, no professional experience",
  deadline: "June 2027",
  domain: "career" as const,
  weeklyHours: 6,
  baseline: 30,
  target: 90,
};

/** A minimal but sufficient stand-in for the Express req/res pair. */
function httpStubs() {
  const req: any = { headers: {}, cookies: {}, protocol: "https", get: () => undefined };
  const res: any = {
    cleared: [] as string[],
    clearCookie(name: string) {
      this.cleared.push(name);
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return { req, res };
}

beforeEach(async () => {
  harness = createTestDb();
  db.setDbForTests(harness.db);
  const user = await seedUser(harness.db);
  userId = user.id;
  const { req, res } = httpStubs();
  caller = appRouter.createCaller({ req, res, user });
  anon = appRouter.createCaller({ req, res, user: null });
});

afterEach(() => {
  db.setDbForTests(null);
});

async function createGoal() {
  const result = await caller.goals.create(goalInput);
  return result.goal.id as number;
}

describe("public surface", () => {
  it("answers the health check without a session", async () => {
    const health = await anon.health();
    expect(health.ok).toBe(true);
    expect(health.modelVersion).toBeTruthy();
  });

  it("reports the model chain honestly", async () => {
    const status = await caller.agents.status();
    expect(typeof status.modelConfigured).toBe("boolean");
    expect(status.modelChain.length).toBeGreaterThan(0);
  });

  it("returns null for auth.me when signed out", async () => {
    expect(await anon.auth.me()).toBeNull();
  });

  it("returns the user for auth.me when signed in", async () => {
    expect((await caller.auth.me())?.id).toBe(userId);
  });

  it("serves a demo workspace to a signed-out visitor rather than failing", async () => {
    // The landing page runs a live projection with no session, so this is public
    // by design. What matters is that it does not leak another user's data.
    const workspace = await anon.workspace.get();
    expect(workspace.isDemo).toBe(true);
    expect(workspace.goals.every(goal => goal.userId !== userId)).toBe(true);
  });

  it("rejects every write route when signed out", async () => {
    await expect(anon.goals.create(goalInput)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anon.journal.create({ content: "A thought worth keeping" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anon.workspace.saveProfile({ values: "Craft", context: "Full-time job", horizonYears: 5 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anon.agents.deterministicReply({ mode: "coach" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("goal lifecycle", () => {
  it("creates a goal and reads it back through the workspace", async () => {
    const created = await caller.goals.create(goalInput);
    expect(created.saved).toBe(true);

    const workspace = await caller.workspace.get();
    expect(workspace.goals).toHaveLength(1);
    // Regression: the projection used to be built from baseline 0 / target 100,
    // discarding whatever the user actually entered.
    expect(workspace.goals[0].baseline).toBe(30);
    expect(workspace.goals[0].target).toBe(90);
    expect(workspace.goals[0].weeklyHours).toBe(6);
  });

  it("generates a plan on creation and stores the steps", async () => {
    const created = await caller.goals.create(goalInput);
    expect(created.steps.length).toBeGreaterThanOrEqual(3);

    const workspace = await caller.workspace.get();
    expect(workspace.habits.length).toBe(created.steps.length);

    const totalMinutes = workspace.habits.reduce((sum: number, step: any) => sum + step.weeklyFrequency * step.minutesPerSession, 0);
    // The plan must fit the time the user said they had.
    expect(totalMinutes).toBeLessThanOrEqual(6 * 60);
  });

  it("updates a goal's numbers", async () => {
    const goalId = await createGoal();
    const updated = await caller.goals.update({ goalId, target: 95, weeklyHours: 8 });
    expect(updated.saved).toBe(true);

    const workspace = await caller.workspace.get();
    expect(workspace.goals[0].target).toBe(95);
    expect(workspace.goals[0].weeklyHours).toBe(8);
  });

  it("archives and unarchives a goal", async () => {
    const goalId = await createGoal();
    // The workspace intentionally includes archived goals — the settings page
    // counts them and unarchiving needs them. Every view filters them out, so
    // assert on the flag rather than on absence.
    const visible = (workspace: any) => workspace.goals.filter((goal: any) => !goal.archived && goal.status !== "archived");

    await caller.goals.archive({ goalId, archived: true });
    let workspace = await caller.workspace.get();
    expect(visible(workspace)).toHaveLength(0);
    expect(workspace.goals).toHaveLength(1);

    await caller.goals.archive({ goalId, archived: false });
    workspace = await caller.workspace.get();
    expect(visible(workspace)).toHaveLength(1);
  });

  it("deletes a goal and its steps, leaving no orphans", async () => {
    const goalId = await createGoal();
    expect((await harness.db.select().from(db.habits)).length).toBeGreaterThan(0);

    await caller.goals.delete({ goalId });

    expect((await harness.db.select().from(db.goals)).length).toBe(0);
    // Regression: habits.goalId is ON DELETE SET NULL, so a plain delete left the
    // plan behind as orphan steps still rendering on the plan page.
    expect((await harness.db.select().from(db.habits)).length).toBe(0);
  });

  it("regenerates a plan without duplicating the goal", async () => {
    const goalId = await createGoal();
    await caller.goals.replan({ goalId });
    const workspace = await caller.workspace.get();
    expect(workspace.goals).toHaveLength(1);
    expect(workspace.habits.length).toBeGreaterThan(0);
  });

  it("refuses to touch another user's goal", async () => {
    const goalId = await createGoal();
    const intruder = await seedUser(harness.db, { openId: "google:someone-else" });
    const { req, res } = httpStubs();
    const otherCaller = appRouter.createCaller({ req, res, user: intruder });

    const result = await otherCaller.goals.delete({ goalId });
    expect(result.saved).toBe(false);
    expect((await harness.db.select().from(db.goals)).length).toBe(1);
  });

  it("rejects a goal with no meaningful title", async () => {
    await expect(caller.goals.create({ ...goalInput, title: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("step lifecycle", () => {
  it("adds a step to a goal", async () => {
    const goalId = await createGoal();
    const before = (await caller.workspace.get()).habits.length;

    const created = await caller.steps.create({ goalId, domain: "career", title: "Send two tailored applications", weeklyFrequency: 2, minutesPerSession: 45 });
    expect(created.saved).toBe(true);
    expect((await caller.workspace.get()).habits.length).toBe(before + 1);
  });

  it("updates a step's cadence", async () => {
    await createGoal();
    const stepId = (await caller.workspace.get()).habits[0].id;

    await caller.steps.update({ stepId, weeklyFrequency: 4, minutesPerSession: 30 });

    const step = (await caller.workspace.get()).habits.find((row: any) => row.id === stepId)!;
    expect(step.weeklyFrequency).toBe(4);
    expect(step.minutesPerSession).toBe(30);
  });

  it("deletes a step and its check-ins", async () => {
    await createGoal();
    const stepId = (await caller.workspace.get()).habits[0].id;
    await caller.checkins.record({ stepId, completed: true, note: "did it" });
    expect((await harness.db.select().from(db.checkins)).length).toBe(1);

    await caller.steps.delete({ stepId });

    expect((await harness.db.select().from(db.habits).where(eq(db.habits.id, stepId))).length).toBe(0);
    expect((await harness.db.select().from(db.checkins)).length).toBe(0);
  });

  it("rejects a cadence nobody could keep", async () => {
    const goalId = await createGoal();
    await expect(
      caller.steps.create({ goalId, domain: "career", title: "Do everything at once", weeklyFrequency: 200, minutesPerSession: 60 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("check-ins", () => {
  async function firstStepId() {
    await createGoal();
    return (await caller.workspace.get()).habits[0].id as number;
  }

  it("records a check-in and moves the step's streak and posterior", async () => {
    const stepId = await firstStepId();
    const before = (await caller.workspace.get()).habits.find((row: any) => row.id === stepId)!;

    const recorded = await caller.checkins.record({ stepId, completed: true, note: "shipped the auth endpoint" });
    expect(recorded.saved).toBe(true);
    expect(recorded.updated).toBe(false);

    // One check-in a day, so the loop below only lands once; assert on the
    // posterior and streak moving off the prior instead.
    expect((recorded.step as any).currentStreak).toBe(1);
    expect((recorded.step as any).betaAlpha).toBeGreaterThan((before as any).betaAlpha);
    expect((recorded.step as any).lastCompletedAt).toBeTruthy();
  });

  it("defaults the date to today when one is not supplied", async () => {
    const stepId = await firstStepId();
    // Regression: checkinDate was a required z.coerce.date(), so omitting it
    // produced an Invalid Date and a validation error that did not name the field.
    const recorded = await caller.checkins.record({ stepId, completed: true });
    expect(recorded.saved).toBe(true);
    expect((await harness.db.select().from(db.checkins)).length).toBe(1);
  });

  it("keeps one check-in per day and updates rather than duplicating", async () => {
    const stepId = await firstStepId();
    await caller.checkins.record({ stepId, completed: true });
    const second = await caller.checkins.record({ stepId, completed: false, note: "changed my mind" });

    // Regression: the old route compared a date string against a full-timestamp
    // unique index, so the second write threw instead of updating.
    expect(second.updated).toBe(true);
    const rows = await harness.db.select().from(db.checkins);
    expect(rows.length).toBe(1);
    expect(rows[0].completed).toBe(false);
    expect((rows[0] as any).note).toBe("changed my mind");
  });

  it("undoes a check-in", async () => {
    const stepId = await firstStepId();
    const recorded = await caller.checkins.record({ stepId, completed: true });
    const undone = await caller.checkins.undo({ checkinId: recorded.checkin.id });
    expect(undone.saved).toBe(true);
    expect((await harness.db.select().from(db.checkins)).length).toBe(0);
  });

  it("refuses a check-in against another user's step", async () => {
    const stepId = await firstStepId();
    const intruder = await seedUser(harness.db, { openId: "google:intruder" });
    const { req, res } = httpStubs();
    const otherCaller = appRouter.createCaller({ req, res, user: intruder });

    const result = await otherCaller.checkins.record({ stepId, completed: true });
    expect(result.saved).toBe(false);
  });
});

describe("projection", () => {
  it("projects the user's actual workspace", async () => {
    await createGoal();
    const { projection } = await caller.projection.get();
    expect(projection.scenarios.realistic).toHaveLength(1);
    expect(projection.scenarios.realistic[0].domain).toBe("career");
    expect(projection.scenarios.realistic[0].points[0].raw).toBe(30);
  });

  it("is deterministic across calls so snapshots can be compared", async () => {
    await createGoal();
    const first = await caller.projection.get();
    const second = await caller.projection.get();
    // generatedAt is a timestamp; the model itself must not move.
    expect(first.projection).toEqual(second.projection);
  });

  it("names the constraint that binds", async () => {
    await createGoal();
    const { projection } = await caller.projection.get();
    const domain = projection.scenarios.realistic[0];
    expect(domain.bottleneck).toBeTruthy();
    expect(domain.signal.length).toBeGreaterThan(0);
  });

  it("answers a what-if without mutating the stored goal", async () => {
    await createGoal();
    const { projection: baseline } = await caller.projection.get();
    const whatIf = await caller.projection.whatIf({
      domain: "career",
      baseline: 30,
      target: 90,
      weeklyHours: 20,
      frequency: 4,
      adherence: 0.9,
      horizonYears: 5,
    });

    expect(whatIf.projected.probabilityOfTarget).toBeGreaterThan(baseline.scenarios.realistic[0].probabilityOfTarget);
    expect((await caller.workspace.get()).goals[0].weeklyHours).toBe(6);
  });

  it("produces a monotone adherence sweep", async () => {
    const sweep = await caller.projection.adherenceSweep({ domain: "career", baseline: 30, target: 90, weeklyHours: 6, frequency: 3, horizonYears: 5 });
    expect(sweep.points.length).toBeGreaterThan(3);
    for (let index = 1; index < sweep.points.length; index += 1) {
      expect(sweep.points[index].probabilityOfTarget).toBeGreaterThanOrEqual(sweep.points[index - 1].probabilityOfTarget);
    }
  });

  it("reports the required contribution for a finance what-if", async () => {
    const whatIf = await caller.projection.whatIf({
      domain: "finance",
      baseline: 2000,
      target: 50000,
      weeklyHours: 1,
      frequency: 1,
      adherence: 0.8,
      horizonYears: 5,
      targetYears: 5,
    });
    expect(whatIf.requiredMonthlyContribution).toBeGreaterThan(0);
  });

  it("exposes the inputs driving the projection so the model is auditable", async () => {
    await createGoal();
    const result = await caller.projection.inputs();
    expect(result.inputs.career).toBeTruthy();
    // The audit trail has to show the user's own numbers, not defaults.
    expect(result.inputs.career.baseline).toBe(30);
    expect(result.inputs.career.target).toBe(90);
    expect(result.horizonYears).toBe(5);
  });
});

describe("scenarios and snapshots", () => {
  it("saves a scenario and snapshots the trajectory at that moment", async () => {
    await createGoal();
    const saved = await caller.scenarios.create({ name: "If I doubled my consistency", adherenceOverride: 0.95 });
    expect(saved.saved).toBe(true);
    expect(saved.snapshot).toBeTruthy();

    const comparison = await caller.scenarios.compare();
    expect(comparison.scenarios.length).toBe(1);
    expect(comparison.live).toBeTruthy();
  });

  it("deletes a scenario", async () => {
    await createGoal();
    const saved = await caller.scenarios.create({ name: "Throwaway", adherenceOverride: 0.6 });
    await caller.scenarios.delete({ scenarioId: saved.scenario.id });
    expect((await harness.db.select().from(db.scenarios)).length).toBe(0);
  });

  it("saves a snapshot and returns it in the timeline", async () => {
    await createGoal();
    await caller.snapshots.save({ note: "before the review" });

    const timeline = await caller.snapshots.timeline();
    expect(timeline.points.length).toBe(1);
    // Regression: trajectory_snapshots was never written by any code path.
    expect((await harness.db.select().from(db.trajectorySnapshots)).length).toBe(1);
  });
});

describe("profile and onboarding", () => {
  it("stores the horizon so the projection stops defaulting to five years", async () => {
    const saved = await caller.workspace.saveProfile({ values: "Craft and honesty", context: "Full-time job, one child", horizonYears: 10 });
    expect(saved.saved).toBe(true);

    const rows = await harness.db.select().from(db.profiles);
    expect(rows.length).toBe(1);
    expect(rows[0].horizonYears).toBe(10);

    await createGoal();
    expect((await caller.projection.get()).projection.horizonYears).toBe(10);
  });

  it("seeds the journal on first onboarding so the fact pack has material", async () => {
    await caller.workspace.saveProfile({
      values: "I want work I am proud of",
      context: "Full-time job, one child",
      horizonYears: 5,
      onboardingComplete: true,
    });
    expect((await harness.db.select().from(db.journalEntries)).length).toBe(1);
  });

  it("rejects an out-of-range horizon rather than storing it", async () => {
    await expect(
      caller.workspace.saveProfile({ values: "Craft", context: "Full-time job", horizonYears: 999 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("journal", () => {
  it("stores an entry and surfaces it in the workspace", async () => {
    await caller.journal.create({ content: "I keep saying yes to overtime and then resent it.", tags: "work" });
    expect((await caller.workspace.get()).journal.length).toBe(1);
  });

  it("extracts themes lexically, with no model involved", async () => {
    await caller.journal.create({ content: "I am exhausted and anxious about the deadline." });
    await caller.journal.create({ content: "Anxious again, and tired. The deadline is not moving." });

    const insights = await caller.journal.insights();
    expect(insights.themes.length).toBeGreaterThan(0);
  });

  it("deletes an entry", async () => {
    await caller.journal.create({ content: "A throwaway thought" });
    const entryId = (await caller.workspace.get()).journal[0].id;
    await caller.journal.delete({ entryId });
    expect((await harness.db.select().from(db.journalEntries)).length).toBe(0);
  });

  it("rejects an entry that is too short to be worth keeping", async () => {
    await expect(caller.journal.create({ content: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("agents", () => {
  it("returns a deterministic reply that references the real goal", async () => {
    await createGoal();
    const reply = await caller.agents.deterministicReply({ mode: "coach" });
    expect(reply.source).toBe("deterministic");
    expect(reply.content).toContain("backend engineering");
  });

  it("exposes the fact pack the agents are shown", async () => {
    await createGoal();
    const { factPack, rendered } = await caller.agents.factPack();
    expect(factPack.goals.length).toBe(1);
    expect(factPack.goals[0].baseline).toBe(30);
    // The rendered form is what the model actually reads, so it must carry the
    // same numbers rather than a paraphrase of them.
    expect(rendered).toContain("GOAL 1 — Get a backend engineering role");
    expect(rendered).toContain("scale 30 → 90");
  });

  it("persists chat history so the conversation survives a reload", async () => {
    await createGoal();
    await caller.agents.chat({ messages: [{ role: "user", content: "Am I on track?" }], mode: "coach" });

    const history = await caller.agents.history();
    expect(history.messages.length).toBe(2); // the question and the answer
    // Regression: the mentor chat was useState-seeded and never read the
    // database, so every reload wiped the conversation.
    expect((await harness.db.select().from(db.chatMessages)).length).toBe(2);
  });

  it("records provenance on the stored assistant message", async () => {
    await createGoal();
    await caller.agents.chat({ messages: [{ role: "user", content: "Am I on track?" }], mode: "coach" });
    const rows = await harness.db.select().from(db.chatMessages);
    const assistant = rows.find((row: any) => row.role === "assistant") as any;
    expect(assistant.meta.fallback).toBe(true); // no model key in tests
    expect(assistant.agent).toBe("coach");
  });

  it("clears chat history", async () => {
    await createGoal();
    await caller.agents.chat({ messages: [{ role: "user", content: "Am I on track?" }], mode: "coach" });
    await caller.agents.clearHistory();
    expect((await harness.db.select().from(db.chatMessages)).length).toBe(0);
  });

  it("produces a review whose metrics are stored beside the narrative", async () => {
    await createGoal();
    const stepId = (await caller.workspace.get()).habits[0].id;
    await caller.checkins.record({ stepId, completed: true, note: "shipped" });

    const result = await caller.agents.review({ windowDays: 14 });
    expect(result.metrics).toBeTruthy();
    expect(Number(result.metrics.deliveredActions)).toBe(1);

    expect((await harness.db.select().from(db.reviews)).length).toBe(1);
    expect((await caller.agents.reviews()).reviews.length).toBe(1);
  });

  it("reports the window it actually measured", async () => {
    await createGoal();
    const narrow = await caller.agents.review({ windowDays: 7 });
    expect(narrow.metrics.windowDays).toBe(7);
  });
});

describe("data isolation", () => {
  it("gives a second user an empty workspace, not the first user's", async () => {
    await createGoal();
    const second = await seedUser(harness.db, { openId: "google:second-person" });
    const { req, res } = httpStubs();
    const otherCaller = appRouter.createCaller({ req, res, user: second });

    const workspace = await otherCaller.workspace.get();
    expect(workspace.goals).toHaveLength(0);
    expect(workspace.isDemo).toBe(false);
  });

  it("does not list another user's journal or reviews", async () => {
    await caller.journal.create({ content: "A private thought" });
    const second = await seedUser(harness.db, { openId: "google:nosy" });
    const { req, res } = httpStubs();
    const otherCaller = appRouter.createCaller({ req, res, user: second });

    expect((await otherCaller.workspace.get()).journal).toHaveLength(0);
    expect((await otherCaller.agents.reviews()).reviews).toHaveLength(0);
  });
});
