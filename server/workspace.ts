/**
 * Workspace service.
 *
 * The projection input builder it replaces took the *first* goal and the *first*
 * habit per domain, wrote `baseline: 0, target: 100` regardless of what the user
 * entered, and defaulted a finance target to 86 — a readiness score, not money.
 * Every projection the product showed was therefore computed from constants.
 *
 * This module is the single place where stored rows become model input, so the
 * mapping can be tested once and reasoned about in one read.
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  buildProjection,
  DOMAINS,
  requiredMonthlyContribution,
  type Domain,
  type DomainProjection,
  type Projection,
  type ProjectionInput,
} from "./engine/projection";
import { updateAdherence } from "./engine/evidence";
import { buildFactPack, type CheckinRow, type FactPack, type GoalRow, type HabitRow, type JournalRow, type WorkspaceRows } from "./agents/factpack";

export type ProfileRow = {
  values: string;
  context: string;
  horizonYears: number;
  onboardingComplete: boolean;
} | null;

export type Workspace = {
  profile: ProfileRow;
  goals: GoalRow[];
  habits: HabitRow[];
  checkins: CheckinRow[];
  journal: JournalRow[];
  scenarios: unknown[];
  snapshots: unknown[];
  messages: unknown[];
  reviews: unknown[];
  insights: unknown[];
};

export const emptyWorkspace: Workspace = {
  profile: null,
  goals: [],
  habits: [],
  checkins: [],
  journal: [],
  scenarios: [],
  snapshots: [],
  messages: [],
  reviews: [],
  insights: [],
};

export type ProjectionBundle = {
  projection: Projection;
  /** Flat per-domain view, convenient for the UI and the fact pack. */
  realistic: DomainProjection[];
  inputs: Partial<Record<Domain, ProjectionInput>>;
  /** Domains the user actually has goals in. */
  activeDomains: Domain[];
};

const DEFAULT_HORIZON = 5;

function isDomain(value: string | null | undefined): value is Domain {
  return Boolean(value) && (DOMAINS as string[]).includes(value as string);
}

/**
 * Derive model inputs from stored rows.
 *
 * A domain's input aggregates *all* active goals and habits in it: committed
 * hours are summed, frequency is the sum of step cadences, and adherence is a
 * recency-weighted posterior across every check-in rather than one habit's
 * stored prior. Picking one row and ignoring the rest was the original bug.
 */
export function projectionInputs(workspace: Workspace, options: { horizonYears?: number; adherenceOverride?: number } = {}): Partial<Record<Domain, ProjectionInput>> {
  const horizon = clampInt(options.horizonYears ?? workspace.profile?.horizonYears ?? DEFAULT_HORIZON, 1, 30);
  const activeGoals = workspace.goals.filter(goal => !goal.archived && goal.status !== "archived");
  const activeHabits = workspace.habits.filter(habit => !habit.archived);
  const inputs: Partial<Record<Domain, ProjectionInput>> = {};

  const domainsWithGoals = new Set(activeGoals.map(goal => goal.domain).filter(isDomain));
  // A habit with no goal still represents real effort, so it counts toward its
  // domain even when the goal was deleted.
  for (const habit of activeHabits) {
    if (isDomain(habit.domain)) domainsWithGoals.add(habit.domain);
  }

  for (const domain of domainsWithGoals) {
    const goals = activeGoals.filter(goal => goal.domain === domain);
    const habits = activeHabits.filter(habit => habit.domain === domain);

    // Baseline and target come from the goal the user actually created. With
    // several goals in one domain the projection tracks the most ambitious one;
    // averaging would produce a number that matches no goal the user has.
    const primary = goals.sort((a, b) => Math.abs(b.target - b.baseline) - Math.abs(a.target - a.baseline))[0];
    const baseline = primary ? Number(primary.baseline) || 0 : 0;
    const target = primary ? Number(primary.target) || 100 : 100;

    const weeklyHours = goals.reduce((sum, goal) => sum + (Number(goal.weeklyHours) || 0), 0) || habits.reduce((sum, habit) => sum + (Number(habit.minutesPerSession) * Number(habit.weeklyFrequency)) / 60, 0);
    const frequency = habits.reduce((sum, habit) => sum + (Number(habit.weeklyFrequency) || 0), 0);

    const records = workspace.checkins
      .filter(checkin => habits.some(habit => habit.id === checkin.habitId))
      .map(checkin => ({ completed: checkin.completed, date: checkin.checkinDate }));

    const priorAlpha = habits.length > 0 ? habits.reduce((sum, habit) => sum + (Number(habit.betaAlpha) || 7), 0) / habits.length : 7;
    const priorBeta = habits.length > 0 ? habits.reduce((sum, habit) => sum + (Number(habit.betaBeta) || 3), 0) / habits.length : 3;
    const posterior = updateAdherence({ alpha: priorAlpha, beta: priorBeta }, records);

    const targetYears = targetYearsFor(primary?.targetDate ?? null, horizon);
    const adherence = options.adherenceOverride !== undefined ? clamp01(options.adherenceOverride) : posterior.mean;

    inputs[domain] = {
      domain,
      baseline,
      target,
      weeklyHours: clamp(weeklyHours, 0, 168),
      frequency: clamp(frequency, 0, 40),
      adherence,
      horizonYears: horizon,
      alpha: posterior.alpha,
      beta: posterior.beta,
      evidenceCount: records.length,
      targetYears,
      seed: stableSeed(domain, baseline, target),
      ...(domain === "finance" ? { monthlyContribution: financeContribution(primary, habits) } : {}),
    };
  }

  return inputs;
}

/**
 * Monthly money going in. Read from the goal's structured detail when the user
 * stated it; otherwise zero, which the projection reports honestly as an
 * unfunded target rather than inventing a savings rate.
 */
function financeContribution(goal: GoalRow | undefined, habits: HabitRow[]): number {
  const details = (goal?.details ?? {}) as Record<string, unknown>;
  const stated = Number(details.monthlyContribution);
  if (Number.isFinite(stated) && stated > 0) return stated;
  const fromHabit = habits
    .map(habit => Number((habit as unknown as Record<string, unknown>).monthlyAmount))
    .find(value => Number.isFinite(value) && value > 0);
  return fromHabit ?? 0;
}

function targetYearsFor(targetDate: Date | null, horizon: number): number {
  if (!targetDate) return horizon;
  const years = (targetDate.getTime() - Date.now()) / (365 * 86_400_000);
  if (!Number.isFinite(years) || years <= 0) return 1;
  return clamp(Math.round(years), 1, horizon);
}

/** Stable seed so the same goal always produces the same bands. */
function stableSeed(domain: string, baseline: number, target: number): number {
  const text = `${domain}:${Math.round(baseline)}:${Math.round(target)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Full projection bundle for a workspace. Falls back to the engine's built-in
 * defaults only when the user has nothing stored, and says so via
 * `activeDomains` being empty.
 */
export function projectWorkspace(workspace: Workspace, options: { horizonYears?: number; adherenceOverride?: number; paths?: number } = {}): ProjectionBundle {
  const inputs = projectionInputs(workspace, options);
  const activeDomains = DOMAINS.filter(domain => inputs[domain]);
  const horizon = clampInt(options.horizonYears ?? workspace.profile?.horizonYears ?? DEFAULT_HORIZON, 1, 30);
  const projection = buildProjection(inputs, horizon, options.adherenceOverride, { paths: options.paths });
  return { projection, realistic: projection.scenarios.realistic, inputs, activeDomains };
}

/** Projection plus the grounded fact pack derived from it. */
export function workspaceContext(workspace: Workspace, options: { horizonYears?: number; adherenceOverride?: number; paths?: number; now?: Date } = {}): {
  bundle: ProjectionBundle;
  factPack: FactPack;
} {
  const bundle = projectWorkspace(workspace, options);
  const factPack = buildFactPack(
    {
      profile: workspace.profile,
      goals: workspace.goals,
      habits: workspace.habits,
      checkins: workspace.checkins,
      journal: workspace.journal,
    },
    {
      composite: bundle.projection.composite,
      confidence: bundle.projection.confidence,
      horizonYears: bundle.projection.horizonYears,
      realistic: bundle.realistic,
    },
    options.now,
  );
  return { bundle, factPack };
}

/**
 * The projection input for one goal in isolation — used by the planner so the
 * feasibility verdict and the bottleneck are computed from the user's real
 * numbers before any model is called.
 */
export function goalInput(args: {
  domain: Domain;
  baseline: number;
  target: number;
  weeklyHours: number;
  horizonYears: number;
  targetYears?: number;
  monthlyContribution?: number;
  frequency?: number;
  /** Overrides the 0.7 planning default — used by the adherence sweep. */
  adherence?: number;
}): ProjectionInput {
  return {
    domain: args.domain,
    baseline: args.baseline,
    target: args.target,
    weeklyHours: clamp(args.weeklyHours, 0, 168),
    frequency: clamp(args.frequency ?? defaultFrequency(args.domain), 0, 40),
    adherence: clamp01(args.adherence ?? 0.7),
    horizonYears: clampInt(args.horizonYears, 1, 30),
    targetYears: args.targetYears,
    alpha: 7,
    beta: 3,
    evidenceCount: 0,
    seed: stableSeed(args.domain, args.baseline, args.target),
    ...(args.domain === "finance" ? { monthlyContribution: args.monthlyContribution ?? 0 } : {}),
  };
}

/** Sessions per week the projection assumes when the plan is not built yet. */
export function defaultFrequency(domain: Domain): number {
  return domain === "career" ? 3 : domain === "health" ? 4 : domain === "relationships" ? 2 : 1;
}

/** Sensible starting scale for a domain when the user has not set numbers. */
export function defaultScale(domain: Domain): { baseline: number; target: number; unit: string } {
  switch (domain) {
    case "finance":
      return { baseline: 0, target: 10_000, unit: "currency" };
    default:
      return { baseline: 30, target: 90, unit: "readiness" };
  }
}

export { requiredMonthlyContribution };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

/**
 * Query helper: load a workspace. Kept here rather than in db.ts so the row
 * shaping and the row fetching stay next to each other.
 */
export async function loadWorkspace(
  database: any,
  tables: {
    profiles: any;
    goals: any;
    habits: any;
    checkins: any;
    journalEntries: any;
    scenarios: any;
    trajectorySnapshots: any;
    chatMessages: any;
    reviews: any;
    insights: any;
  },
  userId: number,
): Promise<Workspace | null> {
  if (!database) return null;
  const [profile, goals, habits, checkins, journal, scenarios, snapshots, messages, reviews, insights] = await Promise.all([
    database.select().from(tables.profiles).where(eq(tables.profiles.userId, userId)).limit(1),
    database.select().from(tables.goals).where(eq(tables.goals.userId, userId)).orderBy(desc(tables.goals.createdAt)),
    database.select().from(tables.habits).where(eq(tables.habits.userId, userId)).orderBy(tables.habits.sortOrder, desc(tables.habits.createdAt)),
    database.select().from(tables.checkins).where(eq(tables.checkins.userId, userId)).orderBy(desc(tables.checkins.checkinDate)).limit(500),
    database.select().from(tables.journalEntries).where(eq(tables.journalEntries.userId, userId)).orderBy(desc(tables.journalEntries.createdAt)).limit(40),
    database.select().from(tables.scenarios).where(eq(tables.scenarios.userId, userId)).orderBy(desc(tables.scenarios.updatedAt)).limit(20),
    database.select().from(tables.trajectorySnapshots).where(eq(tables.trajectorySnapshots.userId, userId)).orderBy(desc(tables.trajectorySnapshots.createdAt)).limit(20),
    database.select().from(tables.chatMessages).where(eq(tables.chatMessages.userId, userId)).orderBy(desc(tables.chatMessages.createdAt)).limit(60),
    database.select().from(tables.reviews).where(eq(tables.reviews.userId, userId)).orderBy(desc(tables.reviews.periodEnd)).limit(12),
    database.select().from(tables.insights).where(eq(tables.insights.userId, userId)).orderBy(desc(tables.insights.createdAt)).limit(12),
  ]);
  return {
    profile: profile[0] || null,
    goals,
    habits,
    checkins,
    journal,
    scenarios,
    snapshots,
    messages: [...messages].reverse(),
    reviews,
    insights,
  };
}

export { and, inArray, isNull };
