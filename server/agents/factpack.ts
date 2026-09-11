/**
 * Grounding layer.
 *
 * The previous implementation passed raw database rows — including `userId`,
 * `createdAt` and Beta parameters — into the system prompt as JSON and asked
 * the model to make sense of them. That produced two failure modes: the model
 * invented numbers that were not in the data, and it burned tokens on schema
 * it did not need.
 *
 * The fact pack is the fix. It is a compact, numbered, human-readable brief of
 * everything the model is permitted to assert. Every fact has a stable id, so a
 * reply can be traced back to what it was grounded on, and the "unknown"
 * section makes the gaps explicit instead of leaving the model to fill them.
 */

import type { Domain } from "../engine/projection";
import { BOTTLENECK_LABELS, DOMAIN_LABELS, formatCurrency, type DomainProjection } from "../engine/projection";
import { currentStreak, deliveryRate, longestStreak, updateAdherence } from "../engine/evidence";

export type GoalRow = {
  id: number;
  domain: string;
  title: string;
  baseline: number;
  target: number;
  weeklyHours: number;
  targetDate: Date | null;
  details: Record<string, unknown> | null;
  notes: string | null;
  status?: string;
  archived?: boolean;
  createdAt: Date;
};

export type HabitRow = {
  id: number;
  goalId: number | null;
  domain: string;
  title: string;
  weeklyFrequency: number;
  minutesPerSession: number;
  adherencePrior: number;
  betaAlpha: number;
  betaBeta: number;
  currentStreak: number;
  longestStreak?: number;
  sortOrder?: number;
  archived?: boolean;
  lastCompletedAt: Date | null;
  createdAt: Date;
};

export type CheckinRow = {
  id: number;
  habitId: number;
  checkinDate: Date;
  completed: boolean;
  note: string | null;
};

export type JournalRow = { id: number; content: string; tags: string | null; createdAt: Date };

export type WorkspaceRows = {
  profile: { values?: string; context?: string; horizonYears?: number } | null;
  goals: GoalRow[];
  habits: HabitRow[];
  checkins: CheckinRow[];
  journal: JournalRow[];
};

export type StepFact = {
  id: number;
  title: string;
  weeklyFrequency: number;
  minutesPerSession: number;
  adherence: number;
  adherenceLow: number;
  adherenceHigh: number;
  checkins: number;
  deliveredLast28d: number;
  expectedLast28d: number;
  deliveryRate: number;
  /**
   * Dated check-ins, so a caller can measure any window rather than only the
   * fixed 28 days above. Not rendered into the prompt.
   */
  evidence: Array<{ date: string; completed: boolean }>;
  streak: number;
  longestStreak: number;
  daysSinceLastCompleted: number | null;
};

export type GoalFact = {
  id: number;
  title: string;
  domain: Domain;
  domainLabel: string;
  outcome: string;
  currentState: string;
  deadlineText: string;
  daysToDeadline: number | null;
  baseline: number;
  target: number;
  /** The scale's unit, so "30 → 90" is not read as a percentage when it is money. */
  unit: string;
  weeklyHours: number;
  attainmentNow: number;
  probabilityOfTarget: number;
  probabilityAtFullAdherence: number;
  requiredAdherence: number;
  feasible: boolean;
  bottleneck: string;
  bottleneckLabel: string;
  signal: string;
  adherence: number;
  adherenceLow: number;
  adherenceHigh: number;
  totalCheckins: number;
  completionRate30d: number;
  expectedActions30d: number;
  deliveredActions30d: number;
  steps: StepFact[];
  stalledSteps: number[];
};

export type FactPack = {
  asOf: string;
  horizonYears: number;
  person: { values: string; context: string };
  goals: GoalFact[];
  projection: {
    composite: number;
    confidence: number;
    domains: Array<{
      domain: Domain;
      label: string;
      attainment: number;
      probabilityOfTarget: number;
      bottleneck: string;
      bottleneckLabel: string;
    }>;
  };
  recentEvidence: Array<{ when: string; step: string; completed: boolean; note: string }>;
  journalCount: number;
  journalExcerpt: string[];
  /** Explicit gaps, so the model asks instead of inventing. */
  unknown: string[];
};

const MS_PER_DAY = 86_400_000;
const DEFAULT_PRIOR = { alpha: 7, beta: 3 };

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

function detailsOf(goal: GoalRow): Record<string, unknown> {
  if (goal.details && typeof goal.details === "object") return goal.details;
  // Older rows stored structured detail as a JSON string in `notes`.
  if (goal.notes) {
    try {
      const parsed = JSON.parse(goal.notes);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // free-form notes, not JSON
    }
  }
  return {};
}

function deadlineText(goal: GoalRow, details: Record<string, unknown>): string {
  if (typeof details.deadlineText === "string" && details.deadlineText.trim()) return details.deadlineText.trim();
  if (goal.targetDate) return goal.targetDate.toISOString().slice(0, 10);
  return "not set";
}

/**
 * Build the fact pack. Pure: no I/O, no model calls, fully testable.
 */
export function buildFactPack(
  workspace: WorkspaceRows,
  projection: { composite: number; confidence: number; horizonYears: number; realistic: DomainProjection[] },
  now: Date = new Date(),
): FactPack {
  const activeGoals = (workspace.goals || []).filter(goal => !goal.archived && goal.status !== "archived");
  const activeHabits = (workspace.habits || []).filter(habit => !habit.archived);
  const checkinsByHabit = new Map<number, CheckinRow[]>();
  for (const checkin of workspace.checkins || []) {
    const list = checkinsByHabit.get(checkin.habitId) ?? [];
    list.push(checkin);
    checkinsByHabit.set(checkin.habitId, list);
  }

  const goals: GoalFact[] = activeGoals.map(goal => {
    const details = detailsOf(goal);
    const steps: StepFact[] = activeHabits
      .filter(habit => habit.goalId === goal.id)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id)
      .map(habit => {
        const records = checkinsByHabit.get(habit.id) ?? [];
        const posterior = updateAdherence(
          { alpha: habit.betaAlpha || DEFAULT_PRIOR.alpha, beta: habit.betaBeta || DEFAULT_PRIOR.beta },
          records.map(record => ({ completed: record.completed, date: record.checkinDate })),
          now,
        );
        const completedDays = records.filter(record => record.completed).map(record => record.checkinDate);
        const delivery = deliveryRate(
          records.map(record => ({ habitId: habit.id, date: record.checkinDate.toISOString().slice(0, 10), completed: record.completed })),
          habit.weeklyFrequency,
          28,
          now,
        );
        const last = records.filter(record => record.completed).map(record => record.checkinDate.getTime()).sort((a, b) => b - a)[0];
        return {
          id: habit.id,
          title: habit.title,
          weeklyFrequency: habit.weeklyFrequency,
          minutesPerSession: habit.minutesPerSession,
          adherence: round(posterior.mean),
          adherenceLow: round(posterior.low),
          adherenceHigh: round(posterior.high),
          checkins: records.length,
          deliveredLast28d: delivery.delivered,
          expectedLast28d: delivery.expected,
          deliveryRate: round(delivery.rate),
          evidence: records.map(record => ({ date: record.checkinDate.toISOString().slice(0, 10), completed: record.completed })),
          streak: currentStreak(completedDays, now),
          // A historical high-water mark is monotone, so take the better of the
          // stored value and what the loaded check-ins show. Recomputing alone
          // understates it whenever the check-in set is partial, which tells the
          // user they achieved less than they did.
          longestStreak: Math.max(habit.longestStreak ?? 0, longestStreak(completedDays)),
          daysSinceLastCompleted: last ? Math.floor(daysBetween(new Date(last), now)) : null,
        };
      });

    const allRecords = steps.flatMap(step => checkinsByHabit.get(step.id) ?? []);
    const last30 = allRecords.filter(record => daysBetween(record.checkinDate, now) <= 30);
    const expected30 = steps.reduce((sum, step) => sum + Math.round((step.weeklyFrequency * 30) / 7), 0);
    const delivered30 = last30.filter(record => record.completed).length;
    const overall = updateAdherence(
      DEFAULT_PRIOR,
      allRecords.map(record => ({ completed: record.completed, date: record.checkinDate })),
      now,
    );
    const projected = projection.realistic.find(item => item.domain === goal.domain);
    // A step is stalled when it has gone quiet for longer than twice its own
    // cadence — a weekly step that has not happened in three weeks is stalled,
    // a daily one needs less time to qualify.
    const stalledSteps = steps
      .filter(step => {
        if (step.checkins === 0) return false;
        const cadenceDays = 7 / Math.max(0.5, step.weeklyFrequency);
        return step.daysSinceLastCompleted !== null && step.daysSinceLastCompleted > Math.max(7, cadenceDays * 2.5);
      })
      .map(step => step.id);

    return {
      id: goal.id,
      title: goal.title,
      domain: (goal.domain as Domain) || "career",
      domainLabel: DOMAIN_LABELS[(goal.domain as Domain) || "career"] ?? goal.domain,
      outcome: text(details.outcome, "not stated"),
      currentState: text(details.currentState, "not stated"),
      deadlineText: deadlineText(goal, details),
      daysToDeadline: goal.targetDate ? Math.round(daysBetween(now, goal.targetDate)) : null,
      baseline: goal.baseline,
      target: goal.target,
      unit: projected?.unit ?? (typeof details.unit === "string" && details.unit ? details.unit : "readiness"),
      weeklyHours: goal.weeklyHours,
      attainmentNow: round(projected?.points?.[0]?.value ?? 0),
      probabilityOfTarget: round(projected?.probabilityOfTarget ?? 0),
      probabilityAtFullAdherence: round(projected?.probabilityAtFullAdherence ?? 0),
      requiredAdherence: round(projected?.requiredAdherence ?? 1),
      feasible: Boolean(projected?.feasible),
      bottleneck: projected?.bottleneck ?? "unknown",
      bottleneckLabel: BOTTLENECK_LABELS[projected?.bottleneck ?? "none"] ?? "Unknown",
      signal: projected?.signal ?? "no projection available",
      adherence: round(overall.mean),
      adherenceLow: round(overall.low),
      adherenceHigh: round(overall.high),
      totalCheckins: allRecords.length,
      completionRate30d: expected30 === 0 ? 0 : round(Math.min(1, delivered30 / expected30)),
      expectedActions30d: expected30,
      deliveredActions30d: delivered30,
      steps,
      stalledSteps,
    };
  });

  const recentEvidence = (workspace.checkins || [])
    .filter(checkin => checkin.note && checkin.note.trim())
    .sort((a, b) => b.checkinDate.getTime() - a.checkinDate.getTime())
    .slice(0, 8)
    .map(checkin => ({
      when: checkin.checkinDate.toISOString().slice(0, 10),
      step: activeHabits.find(habit => habit.id === checkin.habitId)?.title ?? "a plan step",
      completed: checkin.completed,
      note: (checkin.note ?? "").trim().slice(0, 300),
    }));

  const journal = (workspace.journal || []).slice(0, 6);
  const unknown: string[] = [];
  if (goals.length === 0) unknown.push("No goal has been created yet — the user's objective, deadline and starting point are all unknown.");
  for (const goal of goals) {
    if (goal.outcome === "not stated") unknown.push(`Goal "${goal.title}" has no stated success criteria.`);
    if (goal.deadlineText === "not set") unknown.push(`Goal "${goal.title}" has no deadline.`);
    if (goal.totalCheckins === 0) unknown.push(`Goal "${goal.title}" has no check-in evidence, so its consistency estimate is a prior, not a measurement.`);
  }
  if (recentEvidence.length === 0) unknown.push("No written evidence notes exist, so nothing is known about what actually happened when the user tried.");
  if (!workspace.profile?.context) unknown.push("The user's circumstances and constraints have not been described.");

  return {
    asOf: now.toISOString(),
    horizonYears: projection.horizonYears,
    person: {
      values: text(workspace.profile?.values, "not recorded"),
      context: text(workspace.profile?.context, "not recorded"),
    },
    goals,
    projection: {
      composite: round(projection.composite),
      confidence: round(projection.confidence),
      domains: projection.realistic.map(item => ({
        domain: item.domain,
        label: DOMAIN_LABELS[item.domain],
        attainment: round(item.score),
        probabilityOfTarget: round(item.probabilityOfTarget),
        bottleneck: item.bottleneck,
        bottleneckLabel: BOTTLENECK_LABELS[item.bottleneck],
      })),
    },
    recentEvidence,
    journalCount: (workspace.journal || []).length,
    journalExcerpt: journal.map(entry => entry.content.trim().slice(0, 400)),
    unknown,
  };
}

function text(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Render the fact pack as the numbered brief the model actually sees.
 *
 * Kept deliberately terse: every token here competes with the conversation, and
 * the compact form is also easier for a model to cite by id.
 */
export function renderFactPack(pack: FactPack): string {
  const lines: string[] = [];
  lines.push(`AS OF ${pack.asOf.slice(0, 10)} · HORIZON ${pack.horizonYears} YEARS`);
  lines.push("");
  lines.push(`F1 Person's stated values: ${pack.person.values}`);
  lines.push(`F2 Person's circumstances: ${pack.person.context}`);
  lines.push(`F3 Journal entries on file: ${pack.journalCount}`);
  lines.push(`F4 Composite trajectory: ${pack.projection.composite.toFixed(0)}/100 at ${(pack.projection.confidence * 100).toFixed(0)}% confidence`);

  for (const domain of pack.projection.domains) {
    lines.push(
      `F5.${domain.domain} ${domain.label}: ${domain.attainment.toFixed(0)}/100 projected, ` +
        `${percent(domain.probabilityOfTarget)} likely to reach target, binding constraint: ${domain.bottleneckLabel}`,
    );
  }

  pack.goals.forEach((goal, index) => {
    const g = index + 1;
    lines.push("");
    lines.push(`GOAL ${g} — ${goal.title}  (${goal.domainLabel})`);
    lines.push(`G${g}.1 Success looks like: ${goal.outcome}`);
    lines.push(`G${g}.2 Starting point: ${goal.currentState}`);
    lines.push(
      `G${g}.3 Deadline: ${goal.deadlineText}${goal.daysToDeadline !== null ? ` (${goal.daysToDeadline} days from now)` : ""}`,
    );
    lines.push(
      `G${g}.4 Committed time: ${goal.weeklyHours}h/week; scale ${goal.baseline} → ${goal.target} (${goal.unit}); ` +
        `${Math.round(goal.attainmentNow)}/100 of the way there now`,
    );
    lines.push(
      `G${g}.5 Measured consistency: ${percent(goal.adherence)} ` +
        `(95% CI ${percent(goal.adherenceLow)}–${percent(goal.adherenceHigh)}) from ${goal.totalCheckins} check-in${goal.totalCheckins === 1 ? "" : "s"}`,
    );
    lines.push(
      `G${g}.6 Last 30 days: ${goal.deliveredActions30d} of ${goal.expectedActions30d} planned actions completed (${percent(goal.completionRate30d)})`,
    );
    lines.push(
      `G${g}.7 Simulated probability of reaching the target: ${percent(goal.probabilityOfTarget)} now, ` +
        `${percent(goal.probabilityAtFullAdherence)} at flawless consistency`,
    );
    lines.push(
      `G${g}.8 Binding constraint: ${goal.bottleneckLabel}. ` +
        (goal.feasible
          ? `Consistency needed for even odds: ${percent(goal.requiredAdherence)}.`
          : "Flawless consistency alone would not reach this target — effort, money or the deadline is also binding."),
    );
    lines.push(`G${g}.9 Model reads this as: ${goal.signal}`);

    goal.steps.forEach((step, stepIndex) => {
      const s = stepIndex + 1;
      lines.push(
        `G${g}.P${s} Step "${step.title}" — ${step.weeklyFrequency}x/week, ${step.minutesPerSession}min, ` +
          `consistency ${percent(step.adherence)} from ${step.checkins} check-in${step.checkins === 1 ? "" : "s"}, ` +
          `${step.deliveredLast28d}/${step.expectedLast28d} delivered in 28 days, current streak ${step.streak}, ` +
          `longest ${step.longestStreak}${step.daysSinceLastCompleted !== null ? `, last done ${step.daysSinceLastCompleted}d ago` : ", never completed"}`,
      );
    });
    if (goal.stalledSteps.length > 0) {
      const names = goal.stalledSteps
        .map(id => goal.steps.find(step => step.id === id)?.title)
        .filter(Boolean)
        .join("; ");
      lines.push(`G${g}.10 STALLED (gone quiet well past its own cadence): ${names}`);
    }
  });

  if (pack.recentEvidence.length > 0) {
    lines.push("");
    lines.push("EVIDENCE NOTES (the user's own words):");
    pack.recentEvidence.forEach((item, index) => {
      lines.push(`E${index + 1} [${item.when}] ${item.step}${item.completed ? "" : " (missed)"}: "${item.note}"`);
    });
  }

  if (pack.journalExcerpt.length > 0) {
    lines.push("");
    lines.push("JOURNAL EXCERPTS:");
    pack.journalExcerpt.forEach((entry, index) => lines.push(`J${index + 1} ${entry}`));
  }

  lines.push("");
  lines.push("NOT KNOWN — do not invent these; ask if the answer would change your advice:");
  if (pack.unknown.length === 0) lines.push("- (nothing flagged)");
  pack.unknown.forEach((item, index) => lines.push(`U${index + 1} ${item}`));

  return lines.join("\n");
}

/**
 * The grounding contract given to every agent. Short and imperative, because
 * long behavioural preamble is the first thing a small model drops.
 */
export function groundingRules(): string {
  return [
    "GROUNDING CONTRACT",
    "1. Every number you state must appear in the FACTS block. If it does not appear there, do not state it.",
    "2. If a fact you need is listed under NOT KNOWN, say it is missing. Ask only if the answer would change your advice.",
    "3. Cite the fact id inline in square brackets when you lean on a specific number, e.g. [G1.5].",
    "4. Never invent check-ins, dates, amounts, job titles, diagnoses, or events that are not in FACTS.",
    "5. Projection figures are a scenario model, not a forecast. Say so if the user treats them as certain.",
    "6. No medical, legal, or individualised financial advice. Finance figures are illustrative.",
  ].join("\n");
}

/** Currency helper re-exported so agents format money consistently. */
export { formatCurrency };
