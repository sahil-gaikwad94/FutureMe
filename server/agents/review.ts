/**
 * Review agent.
 *
 * Nothing in the previous version closed the loop. Check-ins went into the
 * database and the plan never changed in response — a step could sit dead for
 * six months and the UI would keep showing it as step three of five.
 *
 * The review reads a window of evidence, works out what moved and what stalled,
 * and returns concrete plan edits: steps to retire, steps to add, cadences to
 * cut. The caller applies them as an explicit, reversible revision rather than
 * silently rewriting the user's plan.
 */

import { complete, extractJson, LLMError, type LLMClientOptions } from "./llm";
import { reviewSchema, type ReviewDraft } from "./schemas";
import { groundingRules, type FactPack, renderFactPack } from "./factpack";

export type ReviewResult = {
  review: ReviewDraft;
  source: "model" | "deterministic";
  model?: string;
  degradedReason?: string;
  /** Computed metrics behind the narrative, so the summary can be audited. */
  metrics: Record<string, number | string>;
};

const SYSTEM = [
  "You are FutureMe's weekly review engine.",
  "You look at one week to four weeks of execution evidence and tell the user what is actually happening.",
  "",
  groundingRules(),
  "",
  "REVIEW RULES",
  "- Judge the plan against the evidence, not against the intention. A step nobody did is a failed step, not a busy week.",
  "- A win must be backed by a number from FACTS. If you cannot cite one, it is not a win.",
  "- A stall is a step that has gone quiet past its own cadence, or delivery below roughly 60% of what it asks for.",
  "- Every `change` must be actionable this week and must fit inside the committed weekly hours.",
  "- `nextActions` are the revised plan. Prefer retiring or shrinking a step over adding one — the usual failure is plan bloat, not plan shortage.",
  "- Use `replacesStepId` when a next action supersedes an existing step.",
  "- No encouragement for its own sake. If the week was bad, say so, then give the smallest credible restart.",
  "",
  "Return JSON matching the schema exactly. No prose outside the JSON.",
].join("\n");

const SCHEMA_HINT = `Schema:
{
  "summary": string,                       // 40 to 900 chars, what actually happened
  "wins": [string],                        // 0 to 6, each backed by a cited number
  "stalls": [string],                      // 0 to 6
  "changes": [string],                     // 1 to 6, actionable this week
  "nextActions": [                         // 1 to 5, the revised plan
    { "title": string, "weeklyFrequency": number, "minutesPerSession": number, "replacesStepId"?: number }
  ]
}`;

export async function generateReview(
  pack: FactPack,
  options: { windowDays?: number; signal?: AbortSignal; client?: LLMClientOptions } = {},
): Promise<ReviewResult> {
  const windowDays = options.windowDays ?? 14;
  const metrics = computeMetrics(pack, windowDays);
  const fallback = () => ({ review: deterministicReview(pack, metrics), source: "deterministic" as const, metrics });

  try {
    const result = await complete(
      {
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              "FACTS",
              renderFactPack(pack),
              "",
              `Review window: the last ${windowDays} days.`,
              `Computed metrics for that window: ${JSON.stringify(metrics)}`,
              "",
              SCHEMA_HINT,
              "",
              "Produce the review as JSON.",
            ].join("\n"),
          },
        ],
        json: true,
        maxTokens: 1200,
        temperature: 0.4,
        signal: options.signal,
      },
      { attemptTimeoutMs: 30_000, maxAttempts: 2, ...options.client },
    );

    const parsed = extractJson(result.text);
    if (!parsed) return { ...fallback(), degradedReason: `The model returned prose instead of JSON (${result.model}).` };
    const validated = reviewSchema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues.slice(0, 3).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      return { ...fallback(), degradedReason: `The model's review failed validation (${issues}).` };
    }
    return { review: validated.data, source: "model", model: result.model, metrics };
  } catch (error) {
    if (error instanceof LLMError && error.kind === "aborted") throw error;
    const reason =
      error instanceof LLMError
        ? error.kind === "unconfigured"
          ? "No model key is configured, so this review was computed from your check-ins directly."
          : `Model unavailable (${error.kind}), so this review was computed from your check-ins directly.`
        : "Model request failed.";
    return { ...fallback(), degradedReason: reason };
  }
}

/**
 * Metrics behind the review, computed rather than asked for. These go to the
 * model as input and are stored alongside the narrative, so a summary that says
 * "a strong week" can always be checked against the numbers that produced it.
 *
 * The window is measured against the fact pack's own `asOf`, not the wall clock
 * at call time. Measuring against `new Date()` meant a review requested hours
 * after the evidence was assembled silently reported an emptier window than the
 * one its prose claimed to cover.
 */
export function computeMetrics(pack: FactPack, windowDays: number, now: Date = new Date(pack.asOf)): Record<string, number | string> {
  const goal = pack.goals[0];
  if (!goal) {
    // Same keys as the populated case, zeroed. A review is stored and rendered
    // from these metrics, so callers should not have to special-case the shape
    // when the user simply has no goal yet.
    return {
      windowDays,
      goals: 0,
      steps: 0,
      stalledSteps: 0,
      deliveredActions: 0,
      expectedActions: 0,
      missedActions: 0,
      deliveryRate: 0,
      deliveredActions28d: 0,
      expectedActions28d: 0,
      completionRate30d: 0,
      measuredConsistency: 0,
      consistencyCI: "0-0%",
      totalCheckins: 0,
      bestStep: "none",
      bestStreak: 0,
      worstStep: "none",
      activeStepCount: 0,
      probabilityOfTarget: 0,
      bindingConstraint: "none",
      note: "No goal on file",
    };
  }

  const steps = goal.steps;
  const cutOff = new Date(now.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10);
  const inWindow = steps.flatMap(step => step.evidence.filter(item => item.date >= cutOff));
  const delivered = inWindow.filter(item => item.completed).length;
  const missed = inWindow.filter(item => !item.completed).length;
  // What the cadence asked for over this window, not over a fixed 28 days.
  const expected = steps.reduce((sum, step) => sum + Math.round((step.weeklyFrequency * windowDays) / 7), 0);
  const bestStep = [...steps].sort((a, b) => b.deliveryRate - a.deliveryRate)[0];
  const worstStep = [...steps].sort((a, b) => a.deliveryRate - b.deliveryRate)[0];
  const activeDays = new Set(steps.map(step => step.streak)).size;

  return {
    windowDays,
    goals: pack.goals.length,
    steps: steps.length,
    stalledSteps: goal.stalledSteps.length,
    deliveredActions: delivered,
    expectedActions: expected,
    missedActions: missed,
    deliveryRate: expected === 0 ? 0 : Math.round((delivered / expected) * 100) / 100,
    // The fixed 28-day figures stay available so a review can be compared
    // across windows, but they are labelled as such.
    deliveredActions28d: steps.reduce((sum, step) => sum + step.deliveredLast28d, 0),
    expectedActions28d: steps.reduce((sum, step) => sum + step.expectedLast28d, 0),
    completionRate30d: goal.completionRate30d,
    measuredConsistency: goal.adherence,
    consistencyCI: `${Math.round(goal.adherenceLow * 100)}-${Math.round(goal.adherenceHigh * 100)}%`,
    totalCheckins: goal.totalCheckins,
    bestStep: bestStep ? `${bestStep.title} (${Math.round(bestStep.deliveryRate * 100)}%)` : "none",
    bestStreak: steps.reduce((max, step) => Math.max(max, step.longestStreak), 0),
    worstStep: worstStep ? `${worstStep.title} (${Math.round(worstStep.deliveryRate * 100)}%)` : "none",
    activeStepCount: activeDays,
    probabilityOfTarget: goal.probabilityOfTarget,
    bindingConstraint: goal.bottleneckLabel,
  };
}

/**
 * Review without a model. Assembled from the computed metrics and the fact pack,
 * so it names the real steps, the real delivery rates and the real bottleneck.
 */
export function deterministicReview(pack: FactPack, metrics: Record<string, number | string>): ReviewDraft {
  const goal = pack.goals[0];
  if (!goal) {
    return {
      summary: "There is no goal on file, so there is nothing to review. Create one and the first review will have evidence to work from.",
      wins: [],
      stalls: [],
      changes: ["Create a goal with an outcome, a date, and a starting point."],
      nextActions: [{ title: "Define the goal and its first observable step", weeklyFrequency: 1, minutesPerSession: 30 }],
    };
  }

  const stalled = goal.steps.filter(step => goal.stalledSteps.includes(step.id));
  const strong = goal.steps.filter(step => step.deliveryRate >= 0.6 && step.checkins > 0);
  const weak = goal.steps.filter(step => !goal.stalledSteps.includes(step.id) && step.deliveryRate < 0.6);

  const deliveryPct = Math.round((Number(metrics.deliveryRate) || 0) * 100);

  const wins = strong.map(
    step =>
      `"${step.title}" ran at ${Math.round(step.deliveryRate * 100)}% of what it asks for — ${step.deliveredLast28d} of ${step.expectedLast28d} sessions, current streak ${step.streak}, best ${step.longestStreak}.`,
  );

  const stalls = [
    ...stalled.map(step => `"${step.title}" has been silent for ${step.daysSinceLastCompleted} days against a ${step.weeklyFrequency}x/week cadence.`),
    ...weak.map(step => `"${step.title}" is delivering ${step.deliveredLast28d} of ${step.expectedLast28d} — ${Math.round(step.deliveryRate * 100)}% of plan.`),
  ];
  if (goal.totalCheckins === 0) {
    stalls.push("No check-ins recorded at all, so consistency is an assumption rather than a measurement.");
  }

  const changes: string[] = [];
  if (goal.totalCheckins === 0) {
    changes.push("Log every session from here on, including misses. Until then no review or projection can be trusted.");
  }
  for (const step of stalled.slice(0, 2)) {
    changes.push(`Retire or shrink "${step.title}". A step that has been dead ${step.daysSinceLastCompleted} days is not coming back at its current size.`);
  }
  for (const step of weak.slice(0, 2)) {
    changes.push(`Cut "${step.title}" to ${Math.max(1, Math.floor(step.weeklyFrequency / 2))}x/week until it runs clean for two weeks.`);
  }
  if (goal.bottleneck === "effort") {
    changes.push(`Weekly time is binding at ${goal.weeklyHours}h. Find the hours or shrink the target — discipline will not close this one.`);
  }
  if (goal.bottleneck === "funding") {
    changes.push("Funding is binding. Put the money movement on autopay before adding any new behavioural step.");
  }
  if (changes.length === 0) {
    changes.push(`Delivery is at ${deliveryPct}% and nothing is stalled. Hold the current plan for two more weeks before changing anything — churn is its own failure mode.`);
  }

  // The revised plan: keep what works, shrink what does not, drop what is dead.
  const nextActions = goal.steps
    .filter(step => !goal.stalledSteps.includes(step.id))
    .slice(0, 4)
    .map(step => ({
      title: step.title,
      weeklyFrequency: step.deliveryRate >= 0.6 ? step.weeklyFrequency : Math.max(0.5, Math.floor(step.weeklyFrequency / 2)),
      minutesPerSession: step.minutesPerSession,
    }));

  if (nextActions.length === 0) {
    nextActions.push({
      title: `Restart the smallest version of "${goal.title}"`,
      weeklyFrequency: 2,
      minutesPerSession: 15,
    });
  }

  return {
    summary: [
      `${goal.steps.length} steps on "${goal.title}", ${deliveryPct}% of planned actions delivered in the window.`,
      goal.totalCheckins === 0
        ? "No check-ins were recorded, so the consistency figure is an assumption."
        : `Measured consistency is ${Math.round(goal.adherence * 100)}% (${metrics.consistencyCI}) across ${goal.totalCheckins} check-ins.`,
      stalls.length === 0 && wins.length > 0
        ? "Nothing has stalled."
        : `${stalled.length + weak.length} step${stalled.length + weak.length === 1 ? "" : "s"} need${stalled.length + weak.length === 1 ? "s" : ""} attention.`,
      `Binding constraint: ${goal.bottleneckLabel.toLowerCase()}. Simulated chance of the target: ${Math.round(goal.probabilityOfTarget * 100)}%.`,
    ].join(" "),
    wins,
    stalls,
    changes,
    nextActions,
  };
}
