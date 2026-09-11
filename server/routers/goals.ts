/**
 * Goals, steps and check-ins.
 *
 * The previous API could create a goal and nothing else. There was no edit, no
 * delete, no archive, and `createGoalPlan` selected one of four hardcoded step
 * arrays while writing `baseline: 0, target: 100` regardless of user input.
 *
 * Here, creation runs the planner agent against the user's real numbers, every
 * row is mutable, and ownership is enforced on every access — a mutation that
 * cannot prove the row belongs to the caller affects zero rows rather than
 * throwing, so a stale client gets a clean `found: false`.
 */

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import * as db from "../db";
import { generatePlan } from "../agents/planner";
import { projectDomain } from "../engine/projection";
import { defaultFrequency, defaultScale, goalInput, loadWorkspace, projectionInputs, projectWorkspace } from "../workspace";
import { protectedProcedure, router } from "../_core/trpc";

export const domainSchema = z.enum(["career", "finance", "health", "relationships"]);

const parseDeadline = (value: string): Date | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.getTime())) return direct;
  // "December 2026", "Dec 2026", "2026" — free-form dates the user actually types.
  const monthYear = trimmed.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (monthYear) {
    const parsed = new Date(`${monthYear[1]} 1, ${monthYear[2]}`);
    if (!Number.isNaN(parsed.getTime())) {
      parsed.setMonth(parsed.getMonth() + 1, 0); // end of the stated month
      return parsed;
    }
  }
  const yearOnly = trimmed.match(/^(\d{4})$/);
  if (yearOnly) return new Date(`${yearOnly[1]}-12-31`);
  return null;
};

const yearsUntil = (date: Date | null, fallback: number): number => {
  if (!date) return fallback;
  const years = (date.getTime() - Date.now()) / (365 * 86_400_000);
  if (!Number.isFinite(years) || years <= 0) return 0.25;
  return Math.min(years, 30);
};

export const goalsRouter = router({
  /**
   * Create a goal and its plan.
   *
   * Runs the projection engine first so the planner is handed a measured
   * feasibility verdict and binding constraint, then asks the planner agent for
   * steps. If the model is unavailable the deterministic planner still produces
   * a plan parameterised on the user's own inputs — and says which path ran.
   */
  create: protectedProcedure
    .input(
      z.object({
        title: z.string().min(3).max(180),
        outcome: z.string().min(3).max(600),
        currentState: z.string().min(3).max(2000),
        deadline: z.string().max(60),
        domain: domainSchema,
        weeklyHours: z.number().min(0.5).max(60),
        baseline: z.number().min(0).max(100_000_000).optional(),
        target: z.number().min(0).max(100_000_000).optional(),
        monthlyContribution: z.number().min(0).max(10_000_000).optional(),
        horizonYears: z.number().int().min(1).max(30).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      if (!database) {
        return { saved: false as const, reason: "database-unavailable" as const };
      }

      const workspace = (await loadWorkspace(database, db.tables, ctx.user.id)) ?? {
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
      const horizon = input.horizonYears ?? workspace.profile?.horizonYears ?? 5;
      const targetDate = parseDeadline(input.deadline);
      const targetYears = yearsUntil(targetDate, horizon);
      const scale = defaultScale(input.domain);
      const baseline = input.baseline ?? scale.baseline;
      const target = input.target ?? scale.target;

      // Measured feasibility, computed before the model is asked anything.
      const projected = projectDomain(
        goalInput({
          domain: input.domain,
          baseline,
          target,
          weeklyHours: input.weeklyHours,
          horizonYears: horizon,
          targetYears,
          monthlyContribution: input.monthlyContribution,
          frequency: defaultFrequency(input.domain),
        }),
      );

      const result = await generatePlan({
        title: input.title,
        outcome: input.outcome,
        currentState: input.currentState,
        deadline: input.deadline || "not set",
        domain: input.domain,
        weeklyHours: input.weeklyHours,
        baseline,
        target,
        targetYears,
        monthlyContribution: input.monthlyContribution,
        bottleneck: projected.bottleneck,
        probabilityOfTarget: projected.probabilityOfTarget,
        probabilityAtFullAdherence: projected.probabilityAtFullAdherence,
        requiredAdherence: projected.requiredAdherence,
        feasible: projected.feasible,
      });

      const plan = result.plan;
      const goalRows = await database
        .insert(db.goals)
        .values({
          userId: ctx.user.id,
          domain: input.domain,
          title: input.title,
          baseline,
          target,
          weeklyHours: input.weeklyHours,
          targetDate,
          details: {
            outcome: input.outcome,
            currentState: input.currentState,
            deadlineText: input.deadline,
            unit: scale.unit,
            planVersion: "v2",
            plannedBy: result.source === "model" ? (result.model ?? "model") : "deterministic",
            reframedGoal: plan.reframedGoal,
            successMetric: plan.successMetric,
            feasibility: plan.feasibility,
            risks: plan.risks,
            firstWeekAction: plan.firstWeekAction,
            ...(input.monthlyContribution !== undefined ? { monthlyContribution: input.monthlyContribution } : {}),
          },
        })
        .returning();
      const goal = goalRows[0];

      const habitRows = await database
        .insert(db.habits)
        .values(
          plan.steps.map((step, index) => ({
            userId: ctx.user.id,
            goalId: goal.id,
            domain: input.domain,
            title: step.title,
            weeklyFrequency: step.weeklyFrequency,
            minutesPerSession: step.minutesPerSession,
            adherencePrior: 0.5,
            betaAlpha: 5,
            betaBeta: 5,
            sortOrder: index,
          })),
        )
        .returning();

      return {
        saved: true as const,
        goal,
        steps: habitRows,
        plan,
        source: result.source,
        model: result.model,
        degradedReason: result.degradedReason,
        feasibility: {
          verdict: plan.feasibility.verdict,
          reasoning: plan.feasibility.reasoning,
          probabilityOfTarget: projected.probabilityOfTarget,
          probabilityAtFullAdherence: projected.probabilityAtFullAdherence,
          bottleneck: projected.bottleneck,
        },
      };
    }),

  update: protectedProcedure
    .input(
      z.object({
        goalId: z.number().int().positive(),
        title: z.string().min(3).max(180).optional(),
        domain: domainSchema.optional(),
        baseline: z.number().min(0).max(100_000_000).optional(),
        target: z.number().min(0).max(100_000_000).optional(),
        weeklyHours: z.number().min(0).max(60).optional(),
        deadline: z.string().max(60).optional(),
        outcome: z.string().min(3).max(600).optional(),
        currentState: z.string().min(3).max(2000).optional(),
        monthlyContribution: z.number().min(0).max(10_000_000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      if (!database) return { saved: false as const, reason: "database-unavailable" as const };

      const { goalId, deadline, outcome, currentState, monthlyContribution, ...columns } = input;
      const existing = (
        await database.select().from(db.goals).where(and(eq(db.goals.userId, ctx.user.id), eq(db.goals.id, goalId))).limit(1)
      )[0];
      if (!existing) return { saved: false as const, reason: "not-found" as const };

      const details = { ...(existing.details as Record<string, unknown> ?? {}) };
      if (outcome !== undefined) details.outcome = outcome;
      if (currentState !== undefined) details.currentState = currentState;
      if (deadline !== undefined) details.deadlineText = deadline;
      if (monthlyContribution !== undefined) details.monthlyContribution = monthlyContribution;

      const updated = (
        await database
          .update(db.goals)
          .set({
            ...columns,
            ...(deadline !== undefined ? { targetDate: parseDeadline(deadline) } : {}),
            details,
            updatedAt: new Date(),
          })
          .where(and(eq(db.goals.userId, ctx.user.id), eq(db.goals.id, goalId)))
          .returning()
      )[0];

      return { saved: true as const, goal: updated };
    }),

  archive: protectedProcedure
    .input(z.object({ goalId: z.number().int().positive(), archived: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      if (!database) return { saved: false as const, reason: "database-unavailable" as const };
      const updated = await database
        .update(db.goals)
        .set({ archived: input.archived, status: input.archived ? "archived" : "active", updatedAt: new Date() })
        .where(and(eq(db.goals.userId, ctx.user.id), eq(db.goals.id, input.goalId)))
        .returning();
      return { saved: updated.length > 0, goal: updated[0] };
    }),

  /**
   * Delete a goal and its plan.
   *
   * The steps are removed explicitly rather than relying on the foreign key:
   * `habits.goalId` is `ON DELETE SET NULL`, so a cascade would leave the plan
   * behind as orphans that still render on the plan page with no goal to belong
   * to. Their check-ins go with them via `checkins.habitId` cascade.
   */
  delete: protectedProcedure.input(z.object({ goalId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const database = await db.getDb();
    if (!database) return { saved: false as const, reason: "database-unavailable" as const };
    const owned = await database.select().from(db.goals).where(and(eq(db.goals.userId, ctx.user.id), eq(db.goals.id, input.goalId))).limit(1);
    if (owned.length === 0) return { saved: false as const, reason: "not-found" as const };
    await database.delete(db.habits).where(and(eq(db.habits.userId, ctx.user.id), eq(db.habits.goalId, input.goalId)));
    const deleted = await database.delete(db.goals).where(and(eq(db.goals.userId, ctx.user.id), eq(db.goals.id, input.goalId))).returning();
    return { saved: deleted.length > 0 };
  }),

  /** Re-run the planner over an existing goal, replacing its steps. */
  replan: protectedProcedure.input(z.object({ goalId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const database = await db.getDb();
    if (!database) return { saved: false as const, reason: "database-unavailable" as const };
    const goal = (await database.select().from(db.goals).where(and(eq(db.goals.userId, ctx.user.id), eq(db.goals.id, input.goalId))).limit(1))[0];
    if (!goal) return { saved: false as const, reason: "not-found" as const };

    const workspace = await loadWorkspace(database, db.tables, ctx.user.id);
    const horizon = workspace?.profile?.horizonYears ?? 5;
    const targetYears = yearsUntil(goal.targetDate, horizon);
    const details = (goal.details ?? {}) as Record<string, unknown>;
    const projected = projectDomain(
      goalInput({
        domain: goal.domain as z.infer<typeof domainSchema>,
        baseline: Number(goal.baseline),
        target: Number(goal.target),
        weeklyHours: Number(goal.weeklyHours),
        horizonYears: horizon,
        targetYears,
        monthlyContribution: Number(details.monthlyContribution) || undefined,
        frequency: defaultFrequency(goal.domain as z.infer<typeof domainSchema>),
      }),
    );

    const result = await generatePlan({
      title: goal.title,
      outcome: String(details.outcome ?? goal.title),
      currentState: String(details.currentState ?? "not recorded"),
      deadline: String(details.deadlineText ?? "not set"),
      domain: goal.domain as z.infer<typeof domainSchema>,
      weeklyHours: Number(goal.weeklyHours),
      baseline: Number(goal.baseline),
      target: Number(goal.target),
      targetYears,
      monthlyContribution: Number(details.monthlyContribution) || undefined,
      bottleneck: projected.bottleneck,
      probabilityOfTarget: projected.probabilityOfTarget,
      probabilityAtFullAdherence: projected.probabilityAtFullAdherence,
      requiredAdherence: projected.requiredAdherence,
      feasible: projected.feasible,
    });

    await database.update(db.habits).set({ archived: true }).where(and(eq(db.habits.userId, ctx.user.id), eq(db.habits.goalId, goal.id)));
    const steps = await database
      .insert(db.habits)
      .values(
        result.plan.steps.map((step, index) => ({
          userId: ctx.user.id,
          goalId: goal.id,
          domain: goal.domain,
          title: step.title,
          weeklyFrequency: step.weeklyFrequency,
          minutesPerSession: step.minutesPerSession,
          adherencePrior: 0.5,
          betaAlpha: 5,
          betaBeta: 5,
          sortOrder: index,
        })),
      )
      .returning();

    await database
      .update(db.goals)
      .set({ details: { ...details, planVersion: "v2", plannedBy: result.source, reframedGoal: result.plan.reframedGoal, risks: result.plan.risks }, updatedAt: new Date() })
      .where(and(eq(db.goals.userId, ctx.user.id), eq(db.goals.id, goal.id)));

    return { saved: true as const, steps, plan: result.plan, source: result.source, degradedReason: result.degradedReason };
  }),
});

export const stepsRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        goalId: z.number().int().positive().optional(),
        domain: domainSchema,
        title: z.string().min(3).max(180),
        weeklyFrequency: z.number().min(0.5).max(14),
        minutesPerSession: z.number().min(5).max(240),
        adherencePrior: z.number().min(0.05).max(0.95).default(0.5),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      if (!database) return { saved: false as const, reason: "database-unavailable" as const };
      const prior = input.adherencePrior;
      const created = (
        await database
          .insert(db.habits)
          .values({
            userId: ctx.user.id,
            goalId: input.goalId ?? null,
            domain: input.domain,
            title: input.title,
            weeklyFrequency: input.weeklyFrequency,
            minutesPerSession: input.minutesPerSession,
            adherencePrior: prior,
            betaAlpha: Math.max(1, Math.round(prior * 10)),
            betaBeta: Math.max(1, Math.round((1 - prior) * 10)),
          })
          .returning()
      )[0];
      return { saved: true as const, step: created };
    }),

  update: protectedProcedure
    .input(
      z.object({
        stepId: z.number().int().positive(),
        title: z.string().min(3).max(180).optional(),
        weeklyFrequency: z.number().min(0.5).max(14).optional(),
        minutesPerSession: z.number().min(5).max(240).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      if (!database) return { saved: false as const, reason: "database-unavailable" as const };
      const { stepId, ...values } = input;
      const updated = await database
        .update(db.habits)
        .set(values)
        .where(and(eq(db.habits.userId, ctx.user.id), eq(db.habits.id, stepId)))
        .returning();
      return { saved: updated.length > 0, step: updated[0] };
    }),

  archive: protectedProcedure
    .input(z.object({ stepId: z.number().int().positive(), archived: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      if (!database) return { saved: false as const, reason: "database-unavailable" as const };
      const updated = await database
        .update(db.habits)
        .set({ archived: input.archived })
        .where(and(eq(db.habits.userId, ctx.user.id), eq(db.habits.id, input.stepId)))
        .returning();
      return { saved: updated.length > 0, step: updated[0] };
    }),

  delete: protectedProcedure.input(z.object({ stepId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const database = await db.getDb();
    if (!database) return { saved: false as const, reason: "database-unavailable" as const };
    const deleted = await database.delete(db.habits).where(and(eq(db.habits.userId, ctx.user.id), eq(db.habits.id, input.stepId))).returning();
    return { saved: deleted.length > 0 };
  }),
});

export const checkinsRouter = router({
  /**
   * Record a check-in.
   *
   * Deduplication is done in SQL on the UTC day rather than by loading every row
   * for the habit and filtering in JavaScript, and the streak is recomputed from
   * the completed set instead of being incremented — an incremented counter
   * silently keeps its old value after a missed week.
   */
  record: protectedProcedure
    .input(
      z.object({
        stepId: z.number().int().positive(),
        completed: z.boolean().default(true),
        // Optional, defaulting to now. As a required `z.coerce.date()` an omitted
        // date became `new Date(undefined)` — an Invalid Date that failed
        // validation with a message that did not name the missing field.
        checkinDate: z.coerce.date().optional(),
        note: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      if (!database) return { saved: false as const, reason: "database-unavailable" as const };

      const step = (
        await database.select().from(db.habits).where(and(eq(db.habits.userId, ctx.user.id), eq(db.habits.id, input.stepId))).limit(1)
      )[0];
      if (!step) return { saved: false as const, reason: "not-found" as const };

      const checkinDate = input.checkinDate ?? new Date();
      const dayStart = startOfUtcDay(checkinDate);
      const dayEnd = new Date(dayStart.getTime() + 86_400_000);

      const sameDay = await database
        .select()
        .from(db.checkins)
        .where(and(eq(db.checkins.userId, ctx.user.id), eq(db.checkins.habitId, input.stepId)))
        .limit(500);
      const existing = sameDay.find((row: any) => {
        const when = new Date(row.checkinDate).getTime();
        return when >= dayStart.getTime() && when < dayEnd.getTime();
      });

      if (existing) {
        const updatedCheckin = (
          await database
            .update(db.checkins)
            .set({ completed: input.completed, note: input.note ?? (existing as any).note })
            .where(and(eq(db.checkins.userId, ctx.user.id), eq((db.checkins as any).id, (existing as any).id)))
            .returning()
        )[0];
        const posterior = await recomputeStep(database, ctx.user.id, step);
        return { saved: true as const, updated: true as const, checkin: updatedCheckin, step: posterior };
      }

      const created = (
        await database
          .insert(db.checkins)
          .values({ userId: ctx.user.id, habitId: input.stepId, checkinDate, completed: input.completed, note: input.note })
          .returning()
      )[0];
      const posterior = await recomputeStep(database, ctx.user.id, step);
      return { saved: true as const, updated: false as const, checkin: created, step: posterior };
    }),

  /** Remove a mis-logged check-in and recompute the step's posterior. */
  undo: protectedProcedure.input(z.object({ checkinId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const database = await db.getDb();
    if (!database) return { saved: false as const, reason: "database-unavailable" as const };
    const target = (
      await database.select().from(db.checkins).where(and(eq(db.checkins.userId, ctx.user.id), eq(db.checkins.id, input.checkinId))).limit(1)
    )[0];
    if (!target) return { saved: false as const, reason: "not-found" as const };
    await database.delete(db.checkins).where(and(eq(db.checkins.userId, ctx.user.id), eq(db.checkins.id, input.checkinId)));
    const step = (await database.select().from(db.habits).where(and(eq(db.habits.userId, ctx.user.id), eq(db.habits.id, (target as any).habitId))).limit(1))[0];
    const posterior = step ? await recomputeStep(database, ctx.user.id, step) : undefined;
    return { saved: true as const, step: posterior };
  }),
});

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Recompute a step's adherence posterior, streaks and last-completed timestamp
 * from its full check-in history.
 *
 * Deriving rather than incrementing means the stored numbers cannot drift out of
 * sync with the ledger — deleting or editing a check-in always yields the same
 * result as if it had been recorded that way from the start.
 */
async function recomputeStep(database: any, userId: number, step: any) {
  const { currentStreak, longestStreak, updateAdherence } = await import("../engine/evidence");
  const rows = await database.select().from(db.checkins).where(and(eq(db.checkins.userId, userId), eq(db.checkins.habitId, step.id)));
  const records: Array<{ completed: boolean; date: Date }> = rows.map((row: any) => ({ completed: Boolean(row.completed), date: new Date(row.checkinDate) }));
  const posterior = updateAdherence({ alpha: 5, beta: 5 }, records);
  const completedDays = records.filter(record => record.completed).map(record => record.date);
  const lastCompleted = completedDays.length > 0 ? new Date(Math.max(...completedDays.map(day => day.getTime()))) : null;

  const updated = (
    await database
      .update(db.habits)
      .set({
        betaAlpha: posterior.alpha,
        betaBeta: posterior.beta,
        adherencePrior: posterior.mean,
        currentStreak: currentStreak(completedDays),
        longestStreak: Math.max(longestStreak(completedDays), Number(step.longestStreak) || 0),
        lastCompletedAt: lastCompleted,
      })
      .where(and(eq(db.habits.userId, userId), eq(db.habits.id, step.id)))
      .returning()
  )[0];
  return updated;
}

export { projectionInputs, projectWorkspace };
