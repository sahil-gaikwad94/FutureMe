/**
 * Coach agent — the mentor surface.
 *
 * Three things were wrong before. The model was handed raw database rows and
 * asked to interpret them. Any failure at all returned one hardcoded sentence
 * with a 200 status, so a rate limit was indistinguishable from advice. And the
 * reply carried no record of what it was based on.
 *
 * This agent gets a compact numbered fact pack instead of rows, streams, and
 * falls back to a reply that is *constructed from the user's actual numbers* —
 * slower to read than a platitude, but true. Every reply reports its source.
 */

import { complete, stream, LLMError, type LLMClientOptions } from "./llm";
import { groundingRules, type FactPack, renderFactPack } from "./factpack";

export type CoachMode = "coach" | "critic" | "celebrate";

export type CoachRequest = {
  factPack: FactPack;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  mode?: CoachMode;
  signal?: AbortSignal;
};

export type CoachReply = {
  content: string;
  source: "model" | "deterministic";
  model?: string;
  degradedReason?: string;
  /** Fact ids the reply is grounded on, so the UI can show provenance. */
  groundedOn: string[];
};

const PERSONA = [
  "You are FutureMe's coach: an experienced practitioner who has helped people do difficult work in the real world.",
  "You are warm, direct, and specific. You are not a cheerleader and you do not perform concern.",
  "",
  "WHAT YOU DO",
  "- Name the bottleneck first. The user has a limited amount of attention; spend it on the thing that is actually binding.",
  "- Give one concrete next action that fits inside the user's stated weekly time. Not three. One.",
  "- Quote the user's own evidence back to them when it contradicts what they just said.",
  "- When a plan is not working, say so plainly and propose the smaller credible version.",
  "- Push back on optimism that the numbers do not support. Then offer the version that is supported.",
  "",
  "WHAT YOU NEVER DO",
  "- No motivational filler, no \"you've got this\", no rhetorical questions you do not answer.",
  "- No generic life advice that would apply to anyone. If a sentence would be true for a stranger, cut it.",
  "- No numbered lists longer than four items. No headings unless the answer is genuinely structured.",
  "- Do not restate the whole fact pack back. Cite at most three facts.",
  "",
  "LENGTH: aim for 90 to 180 words. Shorter when the answer is short.",
].join("\n");

const MODE_DIRECTIVE: Record<CoachMode, string> = {
  coach: "Mode: coaching. Find the binding constraint and give one next action that fits the stated time budget.",
  critic:
    "Mode: red team. Your job is to argue this plan will fail, using only the evidence in FACTS. Identify the weakest assumption, the step most likely to be skipped, and what the user is avoiding. Then state the smallest version that would survive contact with a bad week. Be rigorous, not cruel.",
  celebrate:
    "Mode: marking progress. Name specifically what the evidence shows has changed, tie it to a fact id, and identify what made it work so it can be repeated. Do not inflate it.",
};

export function coachSystemPrompt(pack: FactPack, mode: CoachMode): string {
  return [PERSONA, "", MODE_DIRECTIVE[mode], "", groundingRules(), "", "FACTS", renderFactPack(pack)].join("\n");
}

export async function coach(request: CoachRequest, options: { client?: LLMClientOptions } = {}): Promise<CoachReply> {
  const mode = request.mode ?? "coach";
  const messages = [
    { role: "system" as const, content: coachSystemPrompt(request.factPack, mode) },
    ...request.messages.slice(-12).map(message => ({ role: message.role, content: message.content })),
  ];

  try {
    const result = await complete(
      { messages, maxTokens: 800, temperature: 0.6, signal: request.signal },
      { attemptTimeoutMs: 30_000, maxAttempts: 2, ...options.client },
    );
    return {
      content: result.text,
      source: "model",
      model: result.model,
      groundedOn: extractCitedFacts(result.text),
    };
  } catch (error) {
    if (error instanceof LLMError && error.kind === "aborted") throw error;
    return {
      ...deterministicCoach(request.factPack, mode),
      degradedReason: describeFailure(error),
    };
  }
}

/**
 * Stream a coaching reply. Yields text deltas.
 *
 * If the stream fails before any content arrives, the caller receives the
 * deterministic reply as a single delta rather than an error — the user sees a
 * real answer either way, and the provenance field says which path produced it.
 */
export async function* coachStream(
  request: CoachRequest,
  options: { client?: LLMClientOptions } = {},
): AsyncGenerator<{ delta: string; source: "model" | "deterministic"; model?: string; degradedReason?: string; done: boolean }> {
  const mode = request.mode ?? "coach";
  const messages = [
    { role: "system" as const, content: coachSystemPrompt(request.factPack, mode) },
    ...request.messages.slice(-12).map(message => ({ role: message.role, content: message.content })),
  ];

  try {
    let emitted = false;
    const generator = stream(
      { messages, maxTokens: 800, temperature: 0.6, signal: request.signal },
      { attemptTimeoutMs: 60_000, ...options.client },
    );
    let meta: { model: string } | undefined;
    for (;;) {
      const next = await generator.next();
      if (next.done) {
        meta = next.value;
        break;
      }
      emitted = true;
      yield { delta: next.value.delta, source: "model", model: next.value.model, done: false };
    }
    if (!emitted) {
      const fallback = deterministicCoach(request.factPack, mode);
      yield { delta: fallback.content, source: "deterministic", degradedReason: "The model stream returned no content.", done: false };
      yield { delta: "", source: "deterministic", done: true };
      return;
    }
    yield { delta: "", source: "model", model: meta?.model, done: true };
  } catch (error) {
    if (error instanceof LLMError && error.kind === "aborted") {
      yield { delta: "", source: "deterministic", degradedReason: "aborted", done: true };
      return;
    }
    const fallback = deterministicCoach(request.factPack, mode);
    yield { delta: fallback.content, source: "deterministic", degradedReason: describeFailure(error), done: false };
    yield { delta: "", source: "deterministic", done: true };
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof LLMError) {
    switch (error.kind) {
      case "unconfigured":
        return "No model key is configured on this deployment, so this reply was reasoned from your data directly.";
      case "rate_limited":
        return "The model provider rate-limited this request, so this reply was reasoned from your data directly.";
      case "timeout":
        return "The model provider timed out, so this reply was reasoned from your data directly.";
      default:
        return `The model was unavailable (${error.kind}), so this reply was reasoned from your data directly.`;
    }
  }
  return "The model request failed, so this reply was reasoned from your data directly.";
}

/** Pull [G1.5]-style citations out of a reply so the UI can show provenance. */
export function extractCitedFacts(content: string): string[] {
  const matches = content.match(/\[(?:F\d+(?:\.\w+)?|G\d+\.[A-Z0-9]+|E\d+|J\d+|U\d+)\]/g) ?? [];
  return Array.from(new Set(matches.map(match => match.slice(1, -1))));
}

/* ------------------------------------------------------------------ *
 * Deterministic reply builder
 * ------------------------------------------------------------------ */

/**
 * Build a real answer from the fact pack without a model.
 *
 * This is not a canned string. It reads the measured consistency, the binding
 * constraint, the stalled steps and the overdue actions, and assembles them into
 * an answer that is specific to this user on this day. It is worse prose than a
 * good model produces and it is labelled as such — but it is never a platitude.
 */
export function deterministicCoach(pack: FactPack, mode: CoachMode): CoachReply {
  const groundedOn: string[] = ["F3", "F4"];
  const goal = pack.goals[0];

  if (!goal) {
    return {
      content:
        "There is no goal on file yet, so there is nothing here to reason from [F3]. Set one — a specific outcome, a date, and where you are starting — and the projection and this conversation both become useful. Until then anything I said would be generic, and generic advice is worse than none.",
      source: "deterministic",
      groundedOn: ["F3", "U1"],
    };
  }

  const lines: string[] = [];

  if (mode === "critic") {
    lines.push(`Here is the case against "${goal.title}".`);
    if (goal.totalCheckins === 0) {
      lines.push(
        `You have never checked in [G1.5]. The ${Math.round(goal.adherence * 100)}% consistency figure is a prior I assumed, not something you have demonstrated — which means every projection you are looking at is a guess wearing a confidence interval. That is the weakest point in the plan, and it costs one minute to fix.`,
      );
      groundedOn.push("G1.5");
    } else {
      lines.push(
        `Measured consistency is ${Math.round(goal.adherence * 100)}% (95% CI ${Math.round(goal.adherenceLow * 100)}–${Math.round(goal.adherenceHigh * 100)}%) from ${goal.totalCheckins} check-ins [G1.5]. Over the last 30 days you completed ${goal.deliveredActions30d} of ${goal.expectedActions30d} planned actions [G1.6].`,
      );
      groundedOn.push("G1.5", "G1.6");
    }
    if (goal.stalledSteps.length > 0) {
      const stalled = goal.steps.filter(step => goal.stalledSteps.includes(step.id));
      lines.push(
        `${stalled.length === 1 ? "One step has" : `${stalled.length} steps have`} gone quiet well past their own cadence: ${stalled.map(step => `"${step.title}" (${step.daysSinceLastCompleted} days)`).join(", ")} [G1.10]. A plan with a silently dead step is not a plan, it is a list.`,
      );
      groundedOn.push("G1.10");
    }
    lines.push(
      `The binding constraint is ${goal.bottleneckLabel.toLowerCase()} [G1.8], and at current consistency the simulated chance of reaching the target is ${Math.round(goal.probabilityOfTarget * 100)}% [G1.7]. The smallest version that survives a bad week: cut the plan to the single step with the best delivery record, run it four times, and only then add the second one back.`,
    );
    groundedOn.push("G1.8", "G1.7");
    return { content: lines.join(" "), source: "deterministic", groundedOn };
  }

  if (mode === "celebrate") {
    const best = [...goal.steps].sort((a, b) => b.deliveryRate - a.deliveryRate)[0];
    if (!best || best.checkins === 0) {
      lines.push(
        `There is no recorded evidence yet for "${goal.title}" [G1.5], so there is nothing I can honestly mark. That is not a criticism of the work — it is a gap in the record. Log what you have actually done and this becomes a real assessment.`,
      );
      groundedOn.push("G1.5");
      return { content: lines.join(" "), source: "deterministic", groundedOn };
    }
    lines.push(
      `"${best.title}" is running at ${Math.round(best.deliveryRate * 100)}% delivery over the last 28 days — ${best.deliveredLast28d} of ${best.expectedLast28d} planned sessions, with a current streak of ${best.streak} and a best of ${best.longestStreak} [G1.P1]. That is the part of the plan that is real.`,
    );
    groundedOn.push("G1.P1");
    if (best.longestStreak >= 7) {
      lines.push(
        `A ${best.longestStreak}-day streak means this has survived at least one bad week already, which is the only evidence that matters early on. Whatever made it easy — the time of day, the size of it, where you do it — write that down and copy it onto the step that is not working.`,
      );
    }
    return { content: lines.join(" "), source: "deterministic", groundedOn };
  }

  // Default coaching mode.
  lines.push(
    `"${goal.title}" is currently at ${Math.round(goal.attainmentNow)}/100 toward the target, with a simulated ${Math.round(goal.probabilityOfTarget * 100)}% chance of getting there [G1.7].`,
  );
  groundedOn.push("G1.7");

  const constraint = constraintSentence(goal);
  lines.push(constraint.sentence);
  groundedOn.push(...constraint.facts);

  const action = nextAction(goal);
  lines.push(action.sentence);
  groundedOn.push(...action.facts);

  if (pack.recentEvidence.length > 0) {
    const latest = pack.recentEvidence[0];
    lines.push(`Last recorded evidence, ${latest.when}: "${latest.note}" — that is the kind of specific detail the projection cannot infer on its own.`);
    groundedOn.push("E1");
  } else {
    lines.push(
      "One thing would sharpen all of this: when you next check in, write a sentence about what actually happened rather than just marking it done. The model can see that you did something; it cannot see what you learned.",
    );
  }

  return { content: lines.join(" "), source: "deterministic", groundedOn };
}

function constraintSentence(goal: FactPack["goals"][number]): { sentence: string; facts: string[] } {
  if (goal.totalCheckins === 0) {
    return {
      sentence: `The honest headline is that consistency is unmeasured — the ${Math.round(goal.adherence * 100)}% figure is an assumed prior, not your record [G1.5]. Until there are check-ins, the projection is describing a plan, not you.`,
      facts: ["G1.5"],
    };
  }
  switch (goal.bottleneck) {
    case "consistency":
      return {
        sentence: `Consistency is the binding constraint [G1.8]: at ${Math.round(goal.adherence * 100)}% you land at ${Math.round(goal.probabilityOfTarget * 100)}%, and even odds need ${Math.round(goal.requiredAdherence * 100)}%. The gap is ${Math.round((goal.requiredAdherence - goal.adherence) * 100)} points, which is one or two sessions a week.`,
        facts: ["G1.8", "G1.5"],
      };
    case "effort":
      return {
        sentence: `Weekly time is the binding constraint, not effort [G1.8]. At ${goal.weeklyHours}h/week this target is not reachable at any level of consistency — flawless adherence still gives ${Math.round(goal.probabilityAtFullAdherence * 100)}%. So the first problem to solve is capacity, and no amount of discipline substitutes for it.`,
        facts: ["G1.8", "G1.4"],
      };
    case "funding":
      return {
        sentence: `The binding constraint is money in, not discipline [G1.8]. Consistency cannot fund a gap the contribution rate does not cover, so the next action belongs in your budget, not your calendar.`,
        facts: ["G1.8"],
      };
    case "time":
      return {
        sentence: `The deadline is the binding constraint [G1.8]. With ${goal.daysToDeadline !== null ? `${goal.daysToDeadline} days` : `about ${runwayYears(goal)} years`} of runway the required pace exceeds what the plan supports, so either the date moves or the target shrinks — and choosing deliberately now is better than discovering it later.`,
        facts: ["G1.8", "G1.3"],
      };
    case "none":
      return {
        sentence: `Nothing is structurally binding right now [G1.8] — at ${Math.round(goal.adherence * 100)}% consistency this is more likely than not. The risk has shifted from feasibility to drift, which is quieter and easier to miss.`,
        facts: ["G1.8", "G1.5"],
      };
    default:
      return {
        sentence: `The projection reads this as: ${goal.signal} [G1.9].`,
        facts: ["G1.9"],
      };
  }
}

function runwayYears(goal: FactPack["goals"][number]): number {
  return goal.daysToDeadline !== null ? Math.max(1, Math.round(goal.daysToDeadline / 365)) : 1;
}

/**
 * Pick the single next action. Prefers a stalled step, then the least-delivered
 * step, then the first step of the plan. One action, sized to the user's cadence.
 */
function nextAction(goal: FactPack["goals"][number]): { sentence: string; facts: string[] } {
  if (goal.steps.length === 0) {
    return {
      sentence: "There are no steps on this goal yet, so the next action is to break it into three observable things you could do this week.",
      facts: [],
    };
  }
  const stalled = goal.steps.find(step => goal.stalledSteps.includes(step.id));
  if (stalled) {
    return {
      sentence: `So the next action is the smallest possible restart of "${stalled.title}" — it has been ${stalled.daysSinceLastCompleted} days [G1.10]. Do a version short enough that skipping it would be harder than doing it, and log it today. Restarting a dead step is worth more than starting a new one.`,
      facts: ["G1.10"],
    };
  }
  const weakest = [...goal.steps].sort((a, b) => a.deliveryRate - b.deliveryRate)[0];
  if (weakest.deliveryRate < 0.6) {
    return {
      sentence: `The next action is one session of "${weakest.title}" — it is running at ${Math.round(weakest.deliveryRate * 100)}% of what it asks for (${weakest.deliveredLast28d} of ${weakest.expectedLast28d} in 28 days). Either do it once today, or cut its weekly frequency to something you will actually hit. An honest small number beats an aspirational large one.`,
      facts: ["G1.6"],
    };
  }
  const first = goal.steps[0];
  return {
    sentence: `Next action: one session of "${first.title}", ${first.minutesPerSession} minutes, and write down what happened afterwards.`,
    facts: ["G1.P1"],
  };
}
