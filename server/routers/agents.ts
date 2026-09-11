/**
 * Agent surfaces: chat, weekly review, journal and capability metadata.
 *
 * Two things were broken here. Chat history was written to the database and then
 * never read back, so every page load restarted the conversation from a canned
 * greeting. And the model was handed raw rows — `workspace.habits`, including
 * `userId` and Beta parameters — as JSON, which is how it ended up inventing
 * numbers.
 *
 * Both surfaces now run off the grounded fact pack, persist with provenance, and
 * report whether a model or the deterministic path produced the answer.
 */

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import * as db from "../db";
import { coach, deterministicCoach } from "../agents/coach";
import { generateReview } from "../agents/review";
import { isConfigured, modelChain } from "../agents/llm";
import { buildFactPack, renderFactPack } from "../agents/factpack";
import { emptyWorkspace, loadWorkspace, projectWorkspace, type Workspace } from "../workspace";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";

const load = async (database: any, userId: number | null): Promise<Workspace> => {
  if (!userId) return emptyWorkspace;
  return (await loadWorkspace(database, db.tables, userId)) ?? emptyWorkspace;
};

const contextFor = (workspace: Workspace, options: { horizonYears?: number; adherenceOverride?: number; now?: Date } = {}) => {
  const bundle = projectWorkspace(workspace, options);
  const factPack = buildFactPack(
    { profile: workspace.profile, goals: workspace.goals, habits: workspace.habits, checkins: workspace.checkins, journal: workspace.journal },
    { composite: bundle.projection.composite, confidence: bundle.projection.confidence, horizonYears: bundle.projection.horizonYears, realistic: bundle.realistic },
    options.now,
  );
  return { bundle, factPack };
};

const modeSchema = z.enum(["coach", "critic", "celebrate"]).default("coach");

export const agentsRouter = router({
  /**
   * Which agents can actually reach a model. The client uses this to set
   * expectations before the user asks anything, rather than discovering a
   * degraded answer after waiting for it.
   */
  status: publicProcedure.query(() => ({
    modelConfigured: isConfigured(),
    modelChain: isConfigured() ? modelChain() : [],
    agents: [
      { id: "planner", name: "Planner", purpose: "Turns a goal into an execution plan sized to your committed hours", hasFallback: true },
      { id: "coach", name: "Coach", purpose: "Grounded mentoring against your measured evidence", hasFallback: true },
      { id: "critic", name: "Critic", purpose: "Argues the plan will fail, using only your own evidence", hasFallback: true },
      { id: "review", name: "Review", purpose: "Reads the check-in window and revises the plan", hasFallback: true },
    ],
  })),

  /** Exactly what the agents are allowed to assert. Shown in the UI as provenance. */
  factPack: protectedProcedure.query(async ({ ctx }) => {
    const database = await db.getDb();
    const workspace = await load(database, ctx.user.id);
    const { factPack } = contextFor(workspace);
    return { factPack, rendered: renderFactPack(factPack) };
  }),

  chat: protectedProcedure
    .input(
      z.object({
        messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(6000) })).min(1).max(24),
        mode: modeSchema,
        adherenceOverride: z.number().min(0.05).max(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      const workspace = await load(database, ctx.user.id);
      // The override is applied to the *user's own* projection. The previous
      // implementation passed an empty input set here, which silently replaced
      // the user's goals with built-in defaults for the duration of the chat.
      const { factPack } = contextFor(workspace, { adherenceOverride: input.adherenceOverride });

      const reply = await coach({ factPack, messages: input.messages, mode: input.mode });

      if (database) {
        const latest = input.messages[input.messages.length - 1];
        await database.insert(db.chatMessages).values([
          // meta is written explicitly on both rows. The column has a database
          // default, but a provenance record that this whole product turns on
          // should not depend on a default being applied — an omitted value
          // should be a visible choice, not a silent {}.
          { userId: ctx.user.id, role: latest.role, content: latest.content, agent: "user", meta: {} },
          {
            userId: ctx.user.id,
            role: "assistant",
            content: reply.content,
            agent: input.mode,
            meta: { model: reply.model, fallback: reply.source === "deterministic", groundedOn: reply.groundedOn },
          },
        ]);
      }

      return {
        response: reply.content,
        source: reply.source,
        model: reply.model,
        degradedReason: reply.degradedReason,
        groundedOn: reply.groundedOn,
        mode: input.mode,
      };
    }),

  /**
   * Deterministic coaching reply with no model call. Exposed deliberately: it is
   * the same code path that runs when the provider fails, so it can be inspected
   * and tested rather than only appearing during an outage.
   */
  deterministicReply: protectedProcedure.input(z.object({ mode: modeSchema })).mutation(async ({ ctx, input }) => {
    const database = await db.getDb();
    const workspace = await load(database, ctx.user.id);
    const { factPack } = contextFor(workspace);
    return deterministicCoach(factPack, input.mode);
  }),

  history: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      const database = await db.getDb();
      if (!database) return { messages: [] };
      const rows = await database
        .select()
        .from(db.chatMessages)
        .where(eq(db.chatMessages.userId, ctx.user.id))
        .orderBy(desc(db.chatMessages.createdAt))
        .limit(input?.limit ?? 50);
      return {
        messages: [...rows]
          .reverse()
          .map((row: any) => ({
            id: row.id,
            role: row.role === "user" ? ("user" as const) : ("assistant" as const),
            content: row.content,
            agent: row.agent,
            meta: row.meta,
            createdAt: row.createdAt,
          })),
      };
    }),

  clearHistory: protectedProcedure.mutation(async ({ ctx }) => {
    const database = await db.getDb();
    if (!database) return { saved: false as const, reason: "database-unavailable" as const };
    await database.delete(db.chatMessages).where(eq(db.chatMessages.userId, ctx.user.id));
    return { saved: true as const };
  }),

  /**
   * Weekly review. Generates the assessment, stores it with the metrics that
   * produced it, and optionally applies the revised plan — retiring the steps
   * the review retired and adding the ones it proposed.
   */
  review: protectedProcedure
    .input(z.object({ goalId: z.number().int().positive().optional(), windowDays: z.number().int().min(7).max(90).default(14), applyPlan: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      const workspace = await load(database, ctx.user.id);
      const { factPack } = contextFor(workspace);
      const result = await generateReview(factPack, { windowDays: input.windowDays });

      const periodEnd = new Date();
      const periodStart = new Date(periodEnd.getTime() - input.windowDays * 86_400_000);

      let applied: { retired: number[]; created: number[] } | undefined;
      if (input.applyPlan && database) {
        const goal = workspace.goals.find(item => item.id === (input.goalId ?? workspace.goals[0]?.id));
        if (goal) {
          const retired: number[] = [];
          for (const step of workspace.habits.filter(habit => habit.goalId === goal.id && !habit.archived)) {
            const superseded = result.review.nextActions.some(action => action.replacesStepId === step.id);
            const mentioned = result.review.nextActions.some(action => action.title.trim().toLowerCase() === step.title.trim().toLowerCase());
            if (!superseded && !mentioned) {
              await database.update(db.habits).set({ archived: true }).where(and(eq(db.habits.userId, ctx.user.id), eq(db.habits.id, step.id)));
              retired.push(step.id);
            }
          }
          const created: number[] = [];
          for (const action of result.review.nextActions) {
            if (action.replacesStepId) continue;
            const exists = workspace.habits.some(habit => habit.goalId === goal.id && habit.title.trim().toLowerCase() === action.title.trim().toLowerCase());
            if (exists) continue;
            const row = (
              await database
                .insert(db.habits)
                .values({
                  userId: ctx.user.id,
                  goalId: goal.id,
                  domain: goal.domain,
                  title: action.title,
                  weeklyFrequency: action.weeklyFrequency,
                  minutesPerSession: action.minutesPerSession,
                  adherencePrior: 0.5,
                  betaAlpha: 5,
                  betaBeta: 5,
                })
                .returning()
            )[0];
            created.push(row.id);
          }
          applied = { retired, created };
        }
      }

      let stored: any = null;
      if (database) {
        stored = (
          await database
            .insert(db.reviews)
            .values({
              userId: ctx.user.id,
              goalId: input.goalId ?? workspace.goals[0]?.id ?? null,
              periodStart,
              periodEnd,
              summary: result.review.summary,
              findings: { wins: result.review.wins, stalls: result.review.stalls, changes: result.review.changes, metrics: result.metrics },
              agent: result.source === "model" ? "review" : "review-deterministic",
              model: result.model,
            })
            .returning()
        )[0];
      }

      return {
        review: result.review,
        metrics: result.metrics,
        source: result.source,
        model: result.model,
        degradedReason: result.degradedReason,
        applied,
        stored: Boolean(stored),
      };
    }),

  reviews: protectedProcedure.query(async ({ ctx }) => {
    const database = await db.getDb();
    if (!database) return { reviews: [] };
    const rows = await database.select().from(db.reviews).where(eq(db.reviews.userId, ctx.user.id)).orderBy(desc(db.reviews.periodEnd)).limit(20);
    return { reviews: rows };
  }),
});

export const journalRouter = router({
  create: protectedProcedure
    .input(z.object({ content: z.string().min(2).max(8000), tags: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const database = await db.getDb();
      if (!database) return { saved: false as const, reason: "database-unavailable" as const };
      const entry = (await database.insert(db.journalEntries).values({ userId: ctx.user.id, content: input.content, tags: input.tags }).returning())[0];

      // Theme extraction is lexical rather than model-driven: it must work with
      // no key configured, and the vocabulary a person reuses is the signal,
      // not a paraphrase of it.
      const themes = extractThemes(input.content);
      if (themes.length > 0) {
        await database
          .insert(db.insights)
          .values({ userId: ctx.user.id, sourceType: "journal", sourceId: entry.id, themes, summary: `Language patterns in this entry: ${themes.join(", ")}.` });
      }
      return { saved: true as const, entry, themes };
    }),

  delete: protectedProcedure.input(z.object({ entryId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const database = await db.getDb();
    if (!database) return { saved: false as const, reason: "database-unavailable" as const };
    const deleted = await database.delete(db.journalEntries).where(and(eq(db.journalEntries.userId, ctx.user.id), eq(db.journalEntries.id, input.entryId))).returning();
    return { saved: deleted.length > 0 };
  }),

  /**
   * Recurring vocabulary across the journal. Words a person returns to under
   * their own steam are usually the real subject, and this needs no model to
   * find them.
   */
  insights: protectedProcedure.query(async ({ ctx }) => {
    const database = await db.getDb();
    if (!database) return { themes: [], entries: 0 };
    const { workspace } = { workspace: await load(database, ctx.user.id) };
    const counts = new Map<string, number>();
    for (const entry of workspace.journal) {
      for (const token of tokenize(entry.content)) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
    const themes = Array.from(counts.entries())
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([token, count]) => ({ token, count }));
    return { themes, entries: workspace.journal.length };
  }),
});

/** Words that carry no signal about what the person is actually dealing with. */
const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","than","that","this","these","those","with","without","from","into","onto","over","under","about","after","before","during","while","because","so","such","very","really","just","still","already","always","never","often","sometimes","today","tomorrow","yesterday","week","weeks","day","days","time","times","thing","things","lot","bit","get","got","make","made","take","took","know","think","feel","feeling","want","need","try","trying","going","went","done","does","doing","have","has","had","was","were","will","would","could","should","can","cannot","not","no","yes","too","also","more","most","much","many","some","any","all","each","every","other","same","own","out","up","down","here","there","where","when","what","which","who","why","how","i","me","my","mine","we","our","us","you","your","it","its","they","them","their","he","she","him","her","his","am","is","are","be","been","being","at","by","for","of","to","in","on","as","it's","i'm","don't","didn't","doesn't","wasn't","can't","won't","that's","there's","one","two","first","even","back","keep","start","started","work","worked","working",
]);

function tokenize(content: string): string[] {
  return content
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .map(token => token.replace(/^['-]+|['-]+$/g, ""))
    .filter(token => token.length >= 4 && !STOPWORDS.has(token));
}

function extractThemes(content: string): string[] {
  const counts = new Map<string, number>();
  for (const token of tokenize(content)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return Array.from(counts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([token]) => token);
}
