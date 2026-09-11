/**
 * Structured output contracts for the agents.
 *
 * Each agent declares what it must return, and every field has a floor: the
 * validator coerces or rejects rather than letting a half-parsed model reply
 * reach the database. Whatever the validator rejects, the caller falls back to
 * the deterministic builder — never to a generic sentence.
 */

import { z } from "zod";

export const domainEnum = z.enum(["career", "finance", "health", "relationships"]);

export const planStepSchema = z.object({
  title: z.string().min(8).max(180),
  /** Why this step, tied to the stated outcome. One sentence. */
  why: z.string().min(8).max(300),
  weeklyFrequency: z.number().min(0.5).max(14),
  minutesPerSession: z.number().min(5).max(240),
  /** Something the user can do in the next 48 hours. */
  firstAction: z.string().min(8).max(300),
});

export const planSchema = z.object({
  /** The goal restated in terms of an observable outcome, not an intention. */
  reframedGoal: z.string().min(10).max(400),
  successMetric: z.object({
    description: z.string().min(8).max(300),
    target: z.string().min(1).max(120),
    unit: z.string().min(1).max(60),
    /** ISO date by which the metric should first be checkable. */
    reviewBy: z.string().min(4).max(40),
  }),
  feasibility: z.object({
    verdict: z.enum(["feasible", "stretch", "unrealistic"]),
    reasoning: z.string().min(10).max(500),
    suggestedWeeklyHours: z.number().min(0.5).max(60).optional(),
    suggestedDeadline: z.string().max(40).optional(),
  }),
  steps: z.array(planStepSchema).min(3).max(7),
  risks: z.array(z.string().min(8).max(300)).min(1).max(5),
  firstWeekAction: z.string().min(10).max(400),
});

export const reviewSchema = z.object({
  summary: z.string().min(20).max(900),
  wins: z.array(z.string().min(6).max(300)).max(6).default([]),
  stalls: z.array(z.string().min(6).max(300)).max(6).default([]),
  changes: z.array(z.string().min(6).max(300)).min(1).max(6),
  nextActions: z
    .array(
      z.object({
        title: z.string().min(8).max(180),
        weeklyFrequency: z.number().min(0.5).max(14),
        minutesPerSession: z.number().min(5).max(240),
        /** Step id this replaces, when the review is swapping a stalled step out. */
        replacesStepId: z.number().int().positive().optional(),
      }),
    )
    .min(1)
    .max(5),
});

export type PlanDraft = z.infer<typeof planSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;
export type ReviewDraft = z.infer<typeof reviewSchema>;

export const feasibilityVerdicts = ["feasible", "stretch", "unrealistic"] as const;
