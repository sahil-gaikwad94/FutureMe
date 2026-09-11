/**
 * Planner agent.
 *
 * Replaces the previous implementation, which selected one of four hardcoded
 * five-item arrays keyed by domain. Every user asking for a career plan got the
 * same five sentences regardless of what they wrote, how much time they had, or
 * when they wanted it done.
 *
 * The agent asks the model for a plan against a strict schema. If the model is
 * unavailable, rate-limited, or returns something that fails validation, we fall
 * back to a deterministic builder — which is still parameterised on the user's
 * own words, time budget, deadline and measured bottleneck. Both paths report
 * which one produced the result, so nothing is silently passed off as advice.
 */

import { complete, extractJson, LLMError, type LLMClientOptions } from "./llm";
import { planSchema, type PlanDraft } from "./schemas";
import { groundingRules } from "./factpack";
import { BOTTLENECK_LABELS, DOMAIN_LABELS, requiredMonthlyContribution, type Bottleneck, type Domain } from "../engine/projection";

export type PlanRequest = {
  title: string;
  outcome: string;
  currentState: string;
  deadline: string;
  domain: Domain;
  weeklyHours: number;
  /** Baseline and target on the domain's native scale. */
  baseline: number;
  target: number;
  targetYears: number;
  monthlyContribution?: number;
  /** Binding constraint computed by the projection engine. */
  bottleneck: Bottleneck;
  probabilityOfTarget: number;
  probabilityAtFullAdherence: number;
  requiredAdherence: number;
  feasible: boolean;
};

export type PlanResult = {
  plan: PlanDraft;
  source: "model" | "deterministic";
  model?: string;
  /** Why the deterministic path ran, when it did. Surfaced in the UI. */
  degradedReason?: string;
};

export const PLANNER_SYSTEM = [
  "You are the planning engine inside FutureMe, a private trajectory observatory.",
  "You turn one real goal into an execution plan a person can actually run alongside a job and a life.",
  "",
  groundingRules(),
  "",
  "PLANNING RULES",
  "- Steps must be observable actions, not states of mind. \"Build confidence\" is not a step. \"Send the email\" is.",
  "- The sum of (weeklyFrequency × minutesPerSession) across all steps must not exceed the committed weekly time in FACTS. If it cannot fit, say so in feasibility.reasoning and propose the reduced version.",
  "- Order steps so the first one is the smallest thing that produces evidence.",
  "- Every step's `why` must reference the stated outcome or a specific fact id.",
  "- If the binding constraint is not consistency, the plan must attack that constraint first.",
  "- Do not pad. Three real steps beat seven plausible ones.",
  "",
  "Return JSON matching the schema exactly. No prose outside the JSON.",
].join("\n");

const SCHEMA_HINT = `Schema:
{
  "reframedGoal": string,
  "successMetric": { "description": string, "target": string, "unit": string, "reviewBy": string },
  "feasibility": { "verdict": "feasible"|"stretch"|"unrealistic", "reasoning": string, "suggestedWeeklyHours"?: number, "suggestedDeadline"?: string },
  "steps": [ { "title": string, "why": string, "weeklyFrequency": number, "minutesPerSession": number, "firstAction": string } ],  // 3 to 7
  "risks": [string],  // 1 to 5
  "firstWeekAction": string
}`;

export function requestBrief(request: PlanRequest): string {
  return [
    "FACTS",
    `Goal: ${request.title}`,
    `Stated outcome: ${request.outcome}`,
    `Starting point, in the user's words: ${request.currentState}`,
    `Deadline: ${request.deadline} (${request.targetYears} year(s) of runway)`,
    `Domain: ${DOMAIN_LABELS[request.domain]}`,
    `Committed time: ${request.weeklyHours}h per week (= ${Math.round(request.weeklyHours * 60)} minutes)`,
    `Baseline ${request.baseline} → target ${request.target}`,
    `Simulated probability of reaching the target: ${Math.round(request.probabilityOfTarget * 100)}%`,
    `Probability at flawless consistency: ${Math.round(request.probabilityAtFullAdherence * 100)}%`,
    `Binding constraint: ${BOTTLENECK_LABELS[request.bottleneck]}`,
    request.domain === "finance" && request.monthlyContribution !== undefined
      ? `Current monthly contribution: ${request.monthlyContribution}; required to fund the target: ${Math.round(requiredMonthlyContribution({ domain: "finance", baseline: request.baseline, target: request.target, weeklyHours: request.weeklyHours, frequency: 1, adherence: 0.7, horizonYears: request.targetYears, targetYears: request.targetYears }))}`
      : `Consistency needed for even odds: ${Math.round(request.requiredAdherence * 100)}%`,
  ].join("\n");
}

export async function generatePlan(
  request: PlanRequest,
  options: { signal?: AbortSignal; client?: LLMClientOptions } = {},
): Promise<PlanResult> {
  const fallback = () => deterministicPlan(request);

  try {
    const result = await complete(
      {
        messages: [
          { role: "system", content: PLANNER_SYSTEM },
          { role: "user", content: `${requestBrief(request)}\n\n${SCHEMA_HINT}\n\nProduce the plan as JSON.` },
        ],
        json: true,
        maxTokens: 1400,
        temperature: 0.5,
        signal: options.signal,
      },
      { attemptTimeoutMs: 30_000, maxAttempts: 2, ...options.client },
    );

    const parsed = extractJson(result.text);
    if (!parsed) {
      return { ...fallback(), degradedReason: `The model returned prose instead of JSON (${result.model}).` };
    }
    const validated = planSchema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues.slice(0, 3).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      return { ...fallback(), degradedReason: `The model's plan failed validation (${issues}).` };
    }
    const plan = validated.data;
    if (!fitsTimeBudget(plan, request.weeklyHours)) {
      // Rather than discarding a good plan, rescale it to the stated budget and
      // note what happened. The alternative — a plan the user cannot run — is
      // the exact failure mode this product exists to avoid.
      return { plan: rescaleToBudget(plan, request.weeklyHours), source: "model", model: result.model, degradedReason: "Rescaled to fit the committed weekly hours." };
    }
    return { plan, source: "model", model: result.model };
  } catch (error) {
    if (error instanceof LLMError && error.kind === "aborted") throw error;
    const reason =
      error instanceof LLMError
        ? error.kind === "unconfigured"
          ? "No model key is configured on this deployment."
          : `Model unavailable (${error.kind}${error.status ? `, HTTP ${error.status}` : ""}).`
        : "Model request failed.";
    return { ...fallback(), degradedReason: reason };
  }
}

export function weeklyMinutes(plan: PlanDraft): number {
  return plan.steps.reduce((sum, step) => sum + step.weeklyFrequency * step.minutesPerSession, 0);
}

export function fitsTimeBudget(plan: PlanDraft, weeklyHours: number): boolean {
  return weeklyMinutes(plan) <= weeklyHours * 60 * 1.05 + 1;
}

/**
 * Scale a plan down until it fits the committed weekly time.
 *
 * Three levers, in order of how much they cost the user: cadence first, then
 * session length, then the number of steps. Frequency alone cannot always get
 * there — it bottoms out at a fortnightly session, and a plan with several long
 * sessions still overruns at that floor, which is the failure this exists to
 * prevent. Trimming the step list is last because dropping advice is worse than
 * shortening it.
 */
export function rescaleToBudget(plan: PlanDraft, weeklyHours: number): PlanDraft {
  const budget = weeklyHours * 60;
  if (weeklyMinutes(plan) <= budget || plan.steps.length === 0) return plan;

  // 1. Cadence. Rounded down to half-sessions so the result stays schedulable.
  let steps = scaleSteps(plan.steps, budget, step => step.weeklyFrequency, 0.5, (step, value) => ({ ...step, weeklyFrequency: value }), value => Math.floor(value * 2) / 2);
  if (weeklyMinutes({ ...plan, steps }) <= budget) return { ...plan, steps };

  // 2. Session length, to the nearest 5 minutes. A 15-minute floor: below that
  //    the step is not worth doing.
  steps = scaleSteps(steps, budget, step => step.minutesPerSession, 15, (step, value) => ({ ...step, minutesPerSession: value }), value => Math.floor(value / 5) * 5);
  if (weeklyMinutes({ ...plan, steps }) <= budget) return { ...plan, steps };

  // 3. Fewer steps, keeping the ones that come first (the plan is ordered by
  //    priority, so the earliest step is the one that produces evidence soonest).
  while (steps.length > 1 && weeklyMinutes({ ...plan, steps }) > budget) steps = steps.slice(0, -1);

  return { ...plan, steps };
}

type PlanStep = PlanDraft["steps"][number];

/**
 * Multiply one numeric field across every step by whatever factor brings the
 * total under budget, without letting any single value drop below `floor`.
 *
 * `round` must bias downward. Rounding to nearest can push the total back over
 * the budget by a few minutes, which previously cost an entire step.
 */
function scaleSteps(
  steps: PlanStep[],
  budget: number,
  read: (step: PlanStep) => number,
  floor: number,
  write: (step: PlanStep, value: number) => PlanStep,
  round: (value: number) => number,
): PlanStep[] {
  const current = weeklyMinutesOf(steps);
  if (current <= budget || current === 0) return steps;
  const factor = budget / current;
  return steps.map(step => {
    const scaled = Math.max(floor, round(read(step) * factor));
    return write(step, scaled < floor ? floor : scaled);
  });
}

function weeklyMinutesOf(steps: PlanStep[]): number {
  return steps.reduce((sum, step) => sum + step.weeklyFrequency * step.minutesPerSession, 0);
}

/* ------------------------------------------------------------------ *
 * Deterministic fallback
 * ------------------------------------------------------------------ */

const DOMAIN_METRICS: Record<Domain, { description: string; target: string; unit: string }> = {
  career: { description: "Verifiable evidence of the target skill shown to people who hire for it", target: "1 artefact + 3 conversations", unit: "evidence" },
  finance: { description: "Money actually moved, measured on the account statement rather than by intention", target: "automated transfer running", unit: "currency/month" },
  health: { description: "Repetitions completed in the week, counted whether or not they felt productive", target: "the stated weekly frequency, four weeks running", unit: "sessions/week" },
  relationships: { description: "Contact initiated and reciprocated, not contact hoped for", target: "one standing ritual that happens without being planned", unit: "contacts/week" },
};

/**
 * Build a plan without a model. Parameterised on the user's own inputs, so it
 * is specific to them — but honestly labelled as deterministic.
 */
export function deterministicPlan(request: PlanRequest): { plan: PlanDraft; source: "deterministic" } {
  const budgetMinutes = Math.max(30, Math.round(request.weeklyHours * 60));
  const goalShort = shorten(request.title, 60);
  const outcomeShort = shorten(request.outcome, 90);

  // Split the committed time: one block for the real work, one for review, and
  // the remainder spread across repetitions. The split below intentionally
  // over-allocates, because the total is reconciled against the budget at the
  // end — the same rescaler the model path goes through. A plan that consumes
  // 100% of stated capacity has no room for a bad week, so the target here is
  // comfortably under it rather than exactly on it.
  const reviewMinutes = Math.min(30, Math.round(budgetMinutes * 0.12));
  const setupMinutes = Math.min(45, Math.round(budgetMinutes * 0.15));
  const remaining = Math.max(30, budgetMinutes - reviewMinutes - setupMinutes);
  const sessionsPerWeek = remaining <= 60 ? 1 : remaining <= 150 ? 2 : remaining <= 300 ? 3 : 4;
  const minutesPerSession = Math.max(15, Math.round(remaining / sessionsPerWeek / 5) * 5);

  const bottleneckStep = bottleneckStepFor(request, minutesPerSession);

  const steps = [
    bottleneckStep,
    {
      title: `Produce the first piece of evidence for "${outcomeShort}"`,
      why: `Nothing else counts until there is something to show. This is the smallest version of ${goalShort} that another person could evaluate.`,
      weeklyFrequency: sessionsPerWeek,
      minutesPerSession,
      firstAction: `In the next 48 hours, spend ${minutesPerSession} minutes producing a rough first version. Do not prepare first.`,
    },
    {
      title: "Put the work in a fixed slot and defend it",
      why: `You committed ${request.weeklyHours}h/week [FACTS]. A slot that is not in the calendar is a slot that gets spent elsewhere — measured consistency is the lever this plan is judged on.`,
      weeklyFrequency: 1,
      minutesPerSession: setupMinutes,
      firstAction: "Choose the day and time now, write it down, and set one recurring reminder.",
    },
    {
      title: "Record what actually happened, including the misses",
      why: "The projection is only as good as the evidence. A missed session you record teaches the model something; one you hide makes every future estimate wrong.",
      weeklyFrequency: 1,
      minutesPerSession: Math.max(10, reviewMinutes),
      firstAction: "After the next session, write one sentence about what happened and check it in.",
    },
    {
      title: "Get one external check on the evidence",
      why: `Self-assessment of ${goalShort} is unreliable. One person or one dataset outside your own head tells you whether the evidence is real.`,
      weeklyFrequency: 0.5,
      minutesPerSession: Math.max(20, minutesPerSession),
      firstAction: "Name the person or the dataset you will ask, and send the message this week.",
    },
  ];

  const metric = DOMAIN_METRICS[request.domain];
  const reviewBy = reviewDate(request.targetYears);

  const draft: PlanDraft = {
    reframedGoal: `${goalShort}, evidenced by ${outcomeShort.toLowerCase()}.`,
    successMetric: { ...metric, reviewBy },
    feasibility: feasibilityFor(request),
    steps,
    risks: risksFor(request),
    firstWeekAction: `${steps[1].firstAction} Then ${steps[0].firstAction.toLowerCase()}`,
  };

  // Same budget rule as the model path. Without this the offline plan asked for
  // more time than the user said they had, which is exactly the kind of plan
  // that gets abandoned in week two.
  const plan = fitsTimeBudget(draft, request.weeklyHours) ? draft : rescaleToBudget(draft, request.weeklyHours * 0.85);

  return { source: "deterministic", plan };
}

/**
 * The first step should attack whatever the projection engine identified as the
 * binding constraint. A plan that ignores the bottleneck is a plan that fails
 * for a reason we already knew.
 */
export function bottleneckStepFor(request: PlanRequest, minutesPerSession: number) {
  switch (request.bottleneck) {
    case "effort":
      return {
        title: `Find the hours: this needs more than ${request.weeklyHours}h/week`,
        why: `The simulation says weekly time is the binding constraint [FACTS]. At ${request.weeklyHours}h/week the target is not reachable at any level of consistency, so the first job is capacity, not effort.`,
        weeklyFrequency: 1,
        minutesPerSession: 30,
        firstAction: `List what currently consumes your evenings, and cut or delegate one thing worth ${Math.max(2, Math.round(request.weeklyHours * 0.5))}h a week.`,
      };
    case "funding": {
      const required = Math.round(
        requiredMonthlyContribution({
          domain: "finance",
          baseline: request.baseline,
          target: request.target,
          weeklyHours: request.weeklyHours,
          frequency: 1,
          adherence: 0.7,
          horizonYears: request.targetYears,
          targetYears: request.targetYears,
        }),
      );
      return {
        title: `Close the funding gap to $${required}/month`,
        why: "The binding constraint is money in, not discipline [FACTS]. No amount of consistency funds a target that the contribution rate cannot reach.",
        weeklyFrequency: 1,
        minutesPerSession: 45,
        firstAction: `Work out the gap between what you transfer now and $${required}, then find the first $${Math.max(20, Math.round((required - (request.monthlyContribution ?? 0)) / 4))} from one recurring cost.`,
      };
    }
    case "time":
      return {
        title: "Reset the deadline, or shrink the target",
        why: `With ${request.targetYears} year(s) of runway the required pace exceeds what the stated time supports [FACTS]. Choosing deliberately now beats missing it silently later.`,
        weeklyFrequency: 1,
        minutesPerSession: 30,
        firstAction: "Write down two dates: the one you want and the one the maths supports. Pick one and tell someone.",
      };
    case "target":
      return {
        title: "Define the smaller version that is actually reachable",
        why: "The target is out of reach on these constraints [FACTS]. A smaller goal you hit beats a larger one you abandon in month three.",
        weeklyFrequency: 1,
        minutesPerSession: 30,
        firstAction: "Write the version of this goal you would be glad to have done in 12 months, and make that the plan.",
      };
    default:
      return {
        title: "Make the first repetition unmissable",
        why: `Consistency is the binding constraint [FACTS]. The cheapest way to buy consistency is to make the smallest version of the action take under ${Math.max(10, Math.round(minutesPerSession / 3))} minutes.`,
        weeklyFrequency: Math.min(7, Math.max(2, Math.round(request.weeklyHours))),
        minutesPerSession: Math.max(10, Math.round(minutesPerSession / 3)),
        firstAction: "Do the two-minute version today, before you decide how you feel about it.",
      };
  }
}

export function feasibilityFor(request: PlanRequest) {
  if (request.feasible && request.probabilityOfTarget >= 0.5) {
    return { verdict: "feasible" as const, reasoning: `At ${request.weeklyHours}h/week the simulation puts this at ${Math.round(request.probabilityOfTarget * 100)}%, and consistency is the only binding constraint.` };
  }
  if (request.feasible) {
    return {
      verdict: "stretch" as const,
      reasoning: `Reachable, but only near ${Math.round(request.requiredAdherence * 100)}% consistency [FACTS]. At your current rate it lands at ${Math.round(request.probabilityOfTarget * 100)}%.`,
    };
  }
  const constraint = BOTTLENECK_LABELS[request.bottleneck].toLowerCase();
  return {
    verdict: "unrealistic" as const,
    reasoning: `Flawless consistency would still not reach this target. The binding constraint is ${constraint}, not effort. Either add ${constraint === "weekly time" ? "hours" : constraint}, extend the ${request.targetYears}-year runway, or reduce the target.`,
    suggestedWeeklyHours: request.bottleneck === "effort" ? Math.round(request.weeklyHours * 2) : undefined,
  };
}

export function risksFor(request: PlanRequest): string[] {
  const risks = [
    `The plan assumes ${request.weeklyHours}h/week survives contact with a bad week. It usually does not — decide now what the reduced version looks like.`,
    `Progress on ${DOMAIN_LABELS[request.domain].toLowerCase()} is slow to become visible, and the most common failure is quitting during the flat section rather than at the start.`,
  ];
  if (request.bottleneck === "consistency") {
    risks.push(`Consistency is the binding constraint, and it is measured. Missing two weeks in a row will move the projection more than any single good session.`);
  }
  if (request.targetYears <= 1) {
    risks.push("The runway is under a year, so there is little room to absorb a restart.");
  }
  return risks;
}

function reviewDate(targetYears: number): string {
  const days = Math.max(14, Math.min(90, Math.round(targetYears * 60)));
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function shorten(value: string, max: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}
