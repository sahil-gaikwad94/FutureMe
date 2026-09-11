/**
 * Workspace, projection, scenarios and snapshots.
 *
 * The projection endpoints are the product's centrepiece and previously had no
 * callers at all — the five-year observatory existed server-side and was never
 * rendered. `whatIf` is the interactive version: it re-runs the simulation
 * against a hypothetical adherence, time budget or deadline without persisting
 * anything, which is what makes the "explore alternate paths" promise real.
 */

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import * as db from "../db";
import { MODEL_VERSION, projectDomain, requiredMonthlyContribution } from "../engine/projection";
import { emptyWorkspace, goalInput, loadWorkspace, projectWorkspace, projectionInputs, type Workspace } from "../workspace";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { domainSchema } from "./goals";

const load = async (database: any, userId: number | null): Promise<{ workspace: Workspace; isDemo: boolean }> => {
  if (!userId) return { workspace: emptyWorkspace, isDemo: true };
  const saved = await loadWorkspace(database, db.tables, userId);
  return { workspace: saved ?? emptyWorkspace, isDemo: !saved };
};

export const workspaceRouter = router({
  /**
   * Everything the dashboard needs in one round trip: rows, the projection
   * derived from them, and the derived metrics. Public so the signed-out demo
   * workspace works; `isDemo` tells the client nothing is being persisted.
   */
  get: publicProcedure.query(async ({ ctx }) => {
    const database = await db.getDb();
    const { workspace, isDemo } = await load(database, ctx.user?.id ?? null);
    const bundle = projectWorkspace(workspace);
    return {
      ...workspace,
      projection: bundle.projection,
      activeDomains: bundle.activeDomains,
      isDemo,
      persistence: database ? "postgres" : "unavailable",
      modelVersion: MODEL_VERSION,
    };
  }),

  saveProfile: protectedProcedure
    .input(
      z.object({
        values: z.string().min(2).max(5000),
        context: z.string().min(2).max(5000),
        horizonYears: z.number().int().min(1).max(30),
        onboardingComplete: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const profile = await db.saveProfile(ctx.user.id, input);
      if (!profile) return { saved: false as const, reason: "database-unavailable" as const };

      // First onboarding seeds the journal so the insight agent has material and
      // the user's own words appear in the fact pack from the first message.
      const database = await db.getDb();
      if (database && input.onboardingComplete) {
        const existing = await database.select().from(db.journalEntries).where(eq(db.journalEntries.userId, ctx.user.id)).limit(1);
        if (existing.length === 0) {
          await database.insert(db.journalEntries).values({ userId: ctx.user.id, content: input.values, tags: "onboarding" });
        }
      }
      return { saved: true as const, profile };
    }),
});

export const projectionRouter = router({
  /** Projection for the signed-in workspace, or an ad-hoc one for a signed-out visitor. */
  get: publicProcedure
    .input(
      z
        .object({
          horizonYears: z.number().int().min(1).max(30).optional(),
          adherenceOverride: z.number().min(0.05).max(1).optional(),
          paths: z.number().int().min(50).max(2000).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const database = await db.getDb();
      const { workspace, isDemo } = await load(database, ctx.user?.id ?? null);
      const bundle = projectWorkspace(workspace, {
        horizonYears: input?.horizonYears,
        adherenceOverride: input?.adherenceOverride,
        paths: input?.paths,
      });
      return {
        projection: bundle.projection,
        activeDomains: bundle.activeDomains,
        isDemo,
        generatedAt: new Date().toISOString(),
      };
    }),

  /**
   * What-if lab. Re-runs one domain against a hypothetical and reports what
   * changed, including the money and time the change actually costs. Nothing is
   * written, so a user can explore freely.
   */
  whatIf: publicProcedure
    .input(
      z.object({
        domain: domainSchema,
        baseline: z.number().min(0).max(100_000_000),
        target: z.number().min(0).max(100_000_000),
        weeklyHours: z.number().min(0).max(168),
        frequency: z.number().min(0).max(40),
        adherence: z.number().min(0.05).max(1),
        horizonYears: z.number().int().min(1).max(30),
        targetYears: z.number().min(0.25).max(30).optional(),
        monthlyContribution: z.number().min(0).max(10_000_000).optional(),
        paths: z.number().int().min(100).max(1500).default(400),
      }),
    )
    .query(({ input }) => {
      const { paths, ...rest } = input;
      const projected = projectDomain(goalInput({ ...rest, frequency: input.frequency, monthlyContribution: input.monthlyContribution }));
      return {
        projected,
        requiredMonthlyContribution: input.domain === "finance" ? requiredMonthlyContribution(goalInput({ ...rest, monthlyContribution: input.monthlyContribution })) : undefined,
        generatedAt: new Date().toISOString(),
      };
    }),

  /**
   * The adherence sweep behind the "what would it take" chart: probability of
   * reaching the target across a range of consistency levels. Computed in one
   * pass so the UI does not have to make eleven requests.
   */
  adherenceSweep: publicProcedure
    .input(
      z.object({
        domain: domainSchema,
        baseline: z.number().min(0).max(100_000_000),
        target: z.number().min(0).max(100_000_000),
        weeklyHours: z.number().min(0).max(168),
        frequency: z.number().min(0).max(40),
        horizonYears: z.number().int().min(1).max(30),
        targetYears: z.number().min(0.25).max(30).optional(),
        monthlyContribution: z.number().min(0).max(10_000_000).optional(),
      }),
    )
    .query(({ input }) => {
      const levels = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1];
      const points = levels.map(adherence => {
        const projected = projectDomain(goalInput({ ...input, adherence }), adherence);
        return {
          adherence,
          probabilityOfTarget: projected.probabilityOfTarget,
          attainment: projected.score,
        };
      });
      return { points, generatedAt: new Date().toISOString() };
    }),

  /** Inputs currently driving the projection — exposed so the model is auditable. */
  inputs: protectedProcedure.query(async ({ ctx }) => {
    const database = await db.getDb();
    const { workspace } = await load(database, ctx.user.id);
    return { inputs: projectionInputs(workspace), horizonYears: workspace.profile?.horizonYears ?? 5 };
  }),
});

export const scenariosRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(2).max(120),
        description: z.string().max(500).optional(),
        adherenceOverride: z.number().min(0.05).max(1),
        horizonYears: z.number().int().min(1).max(30).optional(),
        assumptions: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      if (!database) return { saved: false as const, reason: "database-unavailable" as const };
      const created = (
        await database
          .insert(db.scenarios)
          .values({
            userId: ctx.user.id,
            name: input.name,
            description: input.description,
            adherenceOverride: input.adherenceOverride,
            assumptions: { ...input.assumptions, ...(input.horizonYears ? { horizonYears: input.horizonYears } : {}) },
          })
          .returning()
      )[0];

      // Snapshot the trajectory at creation time so the saved scenario is a
      // record of what was believed then, not a live recomputation.
      const { workspace } = await load(database, ctx.user.id);
      const bundle = projectWorkspace(workspace, { adherenceOverride: input.adherenceOverride, horizonYears: input.horizonYears });
      const snapshot = await db.saveSnapshot(
        ctx.user.id,
        { composite: bundle.projection.composite, confidence: bundle.projection.confidence, domains: bundle.realistic.map(item => ({ domain: item.domain, score: item.score, probabilityOfTarget: item.probabilityOfTarget, bottleneck: item.bottleneck })) },
        { scenarioId: created.id },
      );
      return { saved: true as const, scenario: created, snapshot };
    }),

  delete: protectedProcedure.input(z.object({ scenarioId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const database = await db.getDb();
    if (!database) return { saved: false as const, reason: "database-unavailable" as const };
    const deleted = await database.delete(db.scenarios).where(and(eq(db.scenarios.userId, ctx.user.id), eq(db.scenarios.id, input.scenarioId))).returning();
    return { saved: deleted.length > 0 };
  }),

  /** Side-by-side comparison of saved scenarios against the live projection. */
  compare: protectedProcedure.query(async ({ ctx }) => {
    const database = await db.getDb();
    if (!database) return { saved: false as const, reason: "database-unavailable" as const };
    const { workspace } = await load(database, ctx.user.id);
    const live = projectWorkspace(workspace);
    const saved = workspace.scenarios as Array<{ id: number; name: string; adherenceOverride: number | null; assumptions: Record<string, unknown>; createdAt: Date }>;

    const rows = saved.slice(0, 6).map(scenario => {
      const bundle = projectWorkspace(workspace, {
        adherenceOverride: scenario.adherenceOverride ?? undefined,
        horizonYears: Number(scenario.assumptions?.horizonYears) || undefined,
      });
      return {
        id: scenario.id,
        name: scenario.name,
        adherenceOverride: scenario.adherenceOverride,
        composite: bundle.projection.composite,
        domains: bundle.realistic.map(item => ({ domain: item.domain, score: item.score, probabilityOfTarget: item.probabilityOfTarget })),
      };
    });

    return {
      saved: true as const,
      live: { composite: live.projection.composite, adherence: live.projection.currentAdherence, domains: live.realistic.map(item => ({ domain: item.domain, score: item.score, probabilityOfTarget: item.probabilityOfTarget })) },
      scenarios: rows,
    };
  }),
});

export const snapshotsRouter = router({
  save: protectedProcedure
    .input(z.object({ note: z.string().max(500).optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      if (!database) return { saved: false as const, reason: "database-unavailable" as const };
      const { workspace } = await load(database, ctx.user.id);
      const bundle = projectWorkspace(workspace);
      const snapshot = await db.saveSnapshot(
        ctx.user.id,
        {
          note: input?.note,
          composite: bundle.projection.composite,
          confidence: bundle.projection.confidence,
          adherence: bundle.projection.currentAdherence,
          domains: bundle.realistic.map(item => ({
            domain: item.domain,
            score: item.score,
            probabilityOfTarget: item.probabilityOfTarget,
            bottleneck: item.bottleneck,
            evidenceCount: item.evidenceCount,
          })),
        },
      );
      return { saved: Boolean(snapshot), snapshot };
    }),

  /**
   * How the trajectory has moved over time. This is the payoff for storing
   * snapshots: the user can see whether the projection improved as evidence
   * accumulated, which is the only real validation the model gets.
   */
  timeline: protectedProcedure.query(async ({ ctx }) => {
    const database = await db.getDb();
    if (!database) return { saved: false as const, reason: "database-unavailable" as const };
    const { workspace } = await load(database, ctx.user.id);
    const snapshots = workspace.snapshots as Array<{ id: number; createdAt: Date; modelVersion: string; payload: Record<string, any> }>;
    return {
      saved: true as const,
      points: [...snapshots]
        .reverse()
        .map(snapshot => ({
          id: snapshot.id,
          at: snapshot.createdAt,
          modelVersion: snapshot.modelVersion,
          composite: Number(snapshot.payload?.composite ?? 0),
          adherence: Number(snapshot.payload?.adherence ?? 0),
          note: typeof snapshot.payload?.note === "string" ? snapshot.payload.note : undefined,
          domains: Array.isArray(snapshot.payload?.domains) ? snapshot.payload.domains : [],
        })),
    };
  }),
});
