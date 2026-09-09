import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { buildProjection, updateBayesianConsistency, type Domain, type ProjectionInput } from "./projection";
import * as db from "./db";
import { askOpenRouter, type ChatTurn } from "./openrouter";

const domainSchema = z.enum(["career", "finance", "health", "relationships"]);
const projectionInputSchema = z.object({
  domain: domainSchema,
  baseline: z.number().min(0).max(100_000_000),
  target: z.number().min(0).max(100_000_000),
  weeklyHours: z.number().min(0).max(168),
  frequency: z.number().min(0).max(21),
  adherence: z.number().min(0.01).max(1),
  horizonYears: z.number().int().min(1).max(20),
});

const demoWorkspace = {
  profile: { values: "Craft, freedom, and being present for the people I love.", context: "Building a career that leaves room for a real life.", horizonYears: 5, onboardingComplete: true },
  goals: [
    { id: 1, domain: "career", title: "Become the person who ships ambitious ideas", baseline: 38, target: 92 },
    { id: 2, domain: "finance", title: "Build a calmer financial runway", baseline: 18, target: 850 },
    { id: 3, domain: "health", title: "Make movement feel automatic", baseline: 42, target: 86 },
  ],
  habits: [
    { id: 1, domain: "career", title: "Deep work on the skill that matters", weeklyFrequency: 4, minutesPerSession: 90, adherencePrior: 0.74, betaAlpha: 7, betaBeta: 3, currentStreak: 6 },
    { id: 2, domain: "health", title: "Move before the day gets loud", weeklyFrequency: 4, minutesPerSession: 35, adherencePrior: 0.68, betaAlpha: 5, betaBeta: 3, currentStreak: 4 },
    { id: 3, domain: "relationships", title: "Make the call while it is still easy", weeklyFrequency: 2, minutesPerSession: 30, adherencePrior: 0.62, betaAlpha: 4, betaBeta: 3, currentStreak: 2 },
  ],
  journal: [{ id: 1, content: "I want progress that feels like mine — not a life optimized for somebody else's scoreboard.", tags: "values" }],
  checkins: [], scenarios: [], snapshots: [], messages: [],
};

function workspaceProjection(workspace: typeof demoWorkspace | NonNullable<Awaited<ReturnType<typeof db.getWorkspace>>>) {
  const inputs: Partial<Record<Domain, ProjectionInput>> = {};
  const goals = workspace.goals as any[];
  const habits = workspace.habits as any[];
  for (const domain of ["career", "finance", "health", "relationships"] as Domain[]) {
    const goal = goals.find((item: any) => item.domain === domain);
    const habit = habits.find((item: any) => item.domain === domain);
    inputs[domain] = {
      domain,
      baseline: Number(goal?.baseline ?? (domain === "career" ? 38 : domain === "finance" ? 18 : 42)),
      target: Number(goal?.target ?? (domain === "finance" ? 850 : 86)),
      weeklyHours: Number(habit?.weeklyFrequency ?? 3) * Number(habit?.minutesPerSession ?? 30) / 60,
      frequency: Number(habit?.weeklyFrequency ?? 3),
      adherence: habit ? Number(habit.betaAlpha) / Math.max(Number(habit.betaAlpha) + Number(habit.betaBeta), 1) : 0.7,
      horizonYears: Number(workspace.profile?.horizonYears ?? 5),
    };
  }
  return buildProjection(inputs, Number(workspace.profile?.horizonYears ?? 5));
}

export const appRouter = router({
  system: systemRouter,
  health: publicProcedure.query(() => ({ ok: true, service: "futureme", timestamp: new Date().toISOString() })),
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  workspace: router({
    get: publicProcedure.query(async ({ ctx }) => {
      if (!ctx.user) return { ...demoWorkspace, projection: workspaceProjection(demoWorkspace), isDemo: true };
      const saved = await db.getWorkspace(ctx.user.id);
      const workspace = saved || demoWorkspace;
      return { ...workspace, projection: workspaceProjection(workspace as typeof demoWorkspace), isDemo: !saved };
    }),
    projection: publicProcedure.input(z.object({ adherenceOverride: z.number().min(0.05).max(1).optional(), horizonYears: z.number().int().min(1).max(20).default(5), inputs: z.array(projectionInputSchema).optional() })).query(({ input }) => {
      const byDomain = Object.fromEntries((input.inputs || []).map(item => [item.domain, item])) as Partial<Record<Domain, ProjectionInput>>;
      return buildProjection(byDomain, input.horizonYears, input.adherenceOverride);
    }),
    saveProfile: protectedProcedure.input(z.object({ values: z.string().min(2).max(5000), context: z.string().min(2).max(5000), horizonYears: z.number().int().min(1).max(20), onboardingComplete: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
      const profile = await db.saveProfile(ctx.user.id, input);
      const database = await db.getDb();
      if (database && input.onboardingComplete) {
        const existingGoals = await database.select().from(db.goals).where(eq(db.goals.userId, ctx.user.id)).limit(1);
        if (existingGoals.length === 0) {
          const createdGoals = await database.insert(db.goals).values([
            { userId: ctx.user.id, domain: "career", title: "Become the person who ships ambitious ideas", baseline: 38, target: 92 },
            { userId: ctx.user.id, domain: "finance", title: "Build a calmer financial runway", baseline: 18, target: 850 },
            { userId: ctx.user.id, domain: "health", title: "Make movement feel automatic", baseline: 42, target: 86 },
            { userId: ctx.user.id, domain: "relationships", title: "Stay close to the people who matter", baseline: 48, target: 84 },
          ]).returning();
          await database.insert(db.habits).values([
            { userId: ctx.user.id, goalId: createdGoals[0]?.id, domain: "career", title: "Deep work on the skill that matters", weeklyFrequency: 4, minutesPerSession: 90, adherencePrior: 0.74, betaAlpha: 7, betaBeta: 3 },
            { userId: ctx.user.id, goalId: createdGoals[2]?.id, domain: "health", title: "Move before the day gets loud", weeklyFrequency: 4, minutesPerSession: 35, adherencePrior: 0.68, betaAlpha: 5, betaBeta: 3 },
            { userId: ctx.user.id, goalId: createdGoals[3]?.id, domain: "relationships", title: "Make the call while it is still easy", weeklyFrequency: 2, minutesPerSession: 30, adherencePrior: 0.62, betaAlpha: 4, betaBeta: 3 },
          ]);
          await database.insert(db.journalEntries).values({ userId: ctx.user.id, content: input.values, tags: "onboarding" });
        }
      }
      return { profile, saved: Boolean(profile) };
    }),
    addGoal: protectedProcedure.input(z.object({ domain: domainSchema, title: z.string().min(2).max(160), baseline: z.number().min(0), target: z.number().min(0), notes: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      if (!database) return { saved: false };
      const result = await database.insert(db.goals).values({ userId: ctx.user.id, ...input }).returning();
      return { saved: true, goal: result[0] };
    }),
    addHabit: protectedProcedure.input(z.object({ domain: domainSchema, title: z.string().min(2).max(160), weeklyFrequency: z.number().min(0).max(21), minutesPerSession: z.number().min(1).max(720), adherencePrior: z.number().min(0.01).max(1) })).mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      if (!database) return { saved: false };
      const result = await database.insert(db.habits).values({ userId: ctx.user.id, ...input, betaAlpha: Math.max(1, input.adherencePrior * 10), betaBeta: Math.max(1, (1 - input.adherencePrior) * 10) }).returning();
      return { saved: true, habit: result[0] };
    }),
    addJournal: protectedProcedure.input(z.object({ content: z.string().min(2).max(5000), tags: z.string().max(200).optional() })).mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      if (!database) return { saved: false };
      const result = await database.insert(db.journalEntries).values({ userId: ctx.user.id, ...input }).returning();
      return { saved: true, entry: result[0] };
    }),
    checkIn: protectedProcedure.input(z.object({ habitId: z.number().int().positive(), completed: z.boolean(), checkinDate: z.coerce.date(), note: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      const habit = await db.getHabitForUser(ctx.user.id, input.habitId);
      if (!database || !habit) return { saved: false };
      const existing = await database.select().from(db.checkins).where(eq(db.checkins.habitId, input.habitId));
      if (existing.some((item: any) => item.checkinDate.toISOString().slice(0, 10) === input.checkinDate.toISOString().slice(0, 10))) return { saved: true, duplicate: true };
      await database.insert(db.checkins).values({ userId: ctx.user.id, habitId: input.habitId, completed: input.completed, checkinDate: input.checkinDate, note: input.note });
      const updated = updateBayesianConsistency(Number(habit.betaAlpha), Number(habit.betaBeta), input.completed ? 1 : 0, 1);
      await database.update(db.habits).set({ betaAlpha: updated.alpha, betaBeta: updated.beta, adherencePrior: updated.mean, currentStreak: input.completed ? Number(habit.currentStreak) + 1 : 0 }).where(eq(db.habits.id, input.habitId));
      return { saved: true, duplicate: false, posterior: updated };
    }),
    createScenario: protectedProcedure.input(z.object({ name: z.string().min(2).max(120), description: z.string().max(500).optional(), adherenceOverride: z.number().min(0.05).max(1), assumptions: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}) })).mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      if (!database) return { saved: false };
      const result = await database.insert(db.scenarios).values({ userId: ctx.user.id, ...input }).returning();
      return { saved: true, scenario: result[0] };
    }),
    chat: protectedProcedure.input(z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(4000) })).min(1).max(20), adherenceOverride: z.number().min(0.05).max(1).optional() })).mutation(async ({ ctx, input }) => {
      const saved = await db.getWorkspace(ctx.user.id);
      const workspace = saved || demoWorkspace;
      const projection = workspaceProjection(workspace as typeof demoWorkspace);
      const overridden = input.adherenceOverride ? buildProjection({}, projection.horizonYears, input.adherenceOverride) : projection;
      const turns: ChatTurn[] = input.messages.map(message => ({ role: message.role, content: message.content }));
      const response = await askOpenRouter(turns, { projection: overridden, voice: (workspace.journal || []).map((item: any) => item.content) });
      const database = await db.getDb();
      if (database) {
        const latest = input.messages[input.messages.length - 1];
        await database.insert(db.chatMessages).values([{ userId: ctx.user.id, role: latest.role, content: latest.content }, { userId: ctx.user.id, role: "assistant", content: response }]);
      }
      return { response, projection: overridden };
    }),
  }),
});

export type AppRouter = typeof appRouter;
