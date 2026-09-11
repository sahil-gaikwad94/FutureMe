/**
 * Evidence layer.
 *
 * The product's claim is that it learns from what you actually did, not from
 * what you said you would do. That requires turning raw check-ins into a
 * posterior over "true adherence" that (a) weights recent behaviour above
 * behaviour from six months ago, (b) reports how much evidence backs it, and
 * (c) degrades honestly to the prior when there is nothing to learn from.
 */

import { clamp01 } from "./random";

export type EvidenceRecord = {
  /** Habit this check-in belongs to. */
  habitId: number;
  /** Day the check-in refers to, at UTC midnight. */
  date: string;
  completed: boolean;
};

export type AdherencePosterior = {
  alpha: number;
  beta: number;
  /** Posterior mean — the point estimate of true adherence. */
  mean: number;
  /** 95% credible interval on adherence. */
  low: number;
  high: number;
  /** Number of check-ins that informed this estimate. */
  sampleSize: number;
  /** 0..1 — how much the posterior has actually moved off the prior. */
  weight: number;
};

const MS_PER_DAY = 86_400_000;

/**
 * Half-life for evidence decay, in days. A check-in from three months ago
 * still counts, but at a fraction of the weight of one from last week —
 * behaviour drifts, and pretending otherwise overstates confidence.
 */
export const EVIDENCE_HALF_LIFE_DAYS = 90;

export function betaMean(alpha: number, beta: number): number {
  return alpha / Math.max(alpha + beta, 1e-9);
}

/**
 * Normal-approximation credible interval for a Beta posterior. Accurate enough
 * for alpha+beta above ~10 and cheap enough to run 400 times per projection.
 */
export function betaCredibleInterval(alpha: number, beta: number): { low: number; high: number } {
  const total = Math.max(alpha + beta, 1e-9);
  const mu = alpha / total;
  const variance = (alpha * beta) / (total * total * (total + 1));
  const sigma = Math.sqrt(Math.max(variance, 0));
  return { low: clamp01(mu - 1.96 * sigma), high: clamp01(mu + 1.96 * sigma) };
}

export function decayWeight(daysAgo: number, halfLifeDays = EVIDENCE_HALF_LIFE_DAYS): number {
  if (!Number.isFinite(daysAgo) || daysAgo < 0) return 0;
  return Math.pow(0.5, daysAgo / halfLifeDays);
}

/**
 * Update a Beta posterior with a batch of check-ins, weighting each by how
 * recently it happened. Weights below 1 shrink the effective sample size,
 * which is the correct behaviour: old evidence informs the mean but should not
 * buy you the same confidence as fresh evidence.
 */
export function updateAdherence(
  prior: { alpha: number; beta: number },
  records: Array<{ completed: boolean; date: Date | string }>,
  now: Date = new Date(),
  halfLifeDays = EVIDENCE_HALF_LIFE_DAYS,
): AdherencePosterior {
  let alpha = Math.max(1e-6, prior.alpha);
  let beta = Math.max(1e-6, prior.beta);
  let effectiveSamples = 0;

  for (const record of records) {
    const when = typeof record.date === "string" ? new Date(record.date) : record.date;
    const daysAgo = Number.isNaN(when.getTime()) ? halfLifeDays : Math.max(0, (now.getTime() - when.getTime()) / MS_PER_DAY);
    const weight = decayWeight(daysAgo, halfLifeDays);
    effectiveSamples += weight;
    if (record.completed) alpha += weight;
    else beta += weight;
  }

  const interval = betaCredibleInterval(alpha, beta);
  const priorMass = Math.max(prior.alpha + prior.beta, 1e-9);
  return {
    alpha,
    beta,
    mean: betaMean(alpha, beta),
    low: interval.low,
    high: interval.high,
    sampleSize: records.length,
    weight: clamp01(effectiveSamples / (priorMass + effectiveSamples)),
  };
}

/**
 * Pure-integer variant used by the check-in mutation, which persists the
 * posterior back to the habits row. No decay here — decay is applied when the
 * projection reads the evidence, so the stored row stays a faithful ledger.
 */
export function updateBayesianConsistency(alpha: number, beta: number, completed: number, attempted: number) {
  const safeAttempted = Math.max(0, Math.round(attempted));
  const safeCompleted = Math.min(safeAttempted, Math.max(0, Math.round(completed)));
  const nextAlpha = alpha + safeCompleted;
  const nextBeta = beta + (safeAttempted - safeCompleted);
  return { alpha: nextAlpha, beta: nextBeta, mean: betaMean(nextAlpha, nextBeta) };
}

/**
 * Current streak, computed from the set of completed days rather than
 * incremented on write. An incremented counter silently rots: skip a week and
 * it still shows the old number until the next miss is recorded.
 */
export function currentStreak(completedDays: Array<Date | string>, now: Date = new Date()): number {
  if (completedDays.length === 0) return 0;
  const days = new Set(
    completedDays
      .map(value => (typeof value === "string" ? new Date(value) : value))
      .filter(value => !Number.isNaN(value.getTime()))
      .map(value => value.toISOString().slice(0, 10)),
  );
  let streak = 0;
  const cursor = new Date(now);
  // A streak is still alive if today is done, or if yesterday was — users
  // check in at different times of day and should not be reset at midnight.
  if (!days.has(cursor.toISOString().slice(0, 10))) {
    cursor.setTime(cursor.getTime() - MS_PER_DAY);
    if (!days.has(cursor.toISOString().slice(0, 10))) return 0;
  }
  for (;;) {
    if (!days.has(cursor.toISOString().slice(0, 10))) break;
    streak += 1;
    cursor.setTime(cursor.getTime() - MS_PER_DAY);
    if (streak > 3650) break;
  }
  return streak;
}

/** Longest streak ever recorded — durable evidence, unlike the current streak. */
export function longestStreak(completedDays: Array<Date | string>): number {
  const days = Array.from(new Set(completedDays.map(value => (typeof value === "string" ? new Date(value) : value).toISOString().slice(0, 10)))).sort();
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of days) {
    const time = Date.parse(day);
    run = previous !== null && time - previous === MS_PER_DAY ? run + 1 : 1;
    previous = time;
    longest = Math.max(longest, run);
  }
  return longest;
}

/**
 * How many of the actions a habit asked for were actually delivered, over the
 * trailing window. Weekly frequency says "4x a week"; this answers "did you?".
 */
export function deliveryRate(
  records: EvidenceRecord[],
  weeklyFrequency: number,
  windowDays = 28,
  now: Date = new Date(),
): { delivered: number; expected: number; rate: number } {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const delivered = records.filter(record => record.completed && Date.parse(record.date) >= cutoff).length;
  const expected = Math.max(0, Math.round((weeklyFrequency * windowDays) / 7));
  return { delivered, expected, rate: expected === 0 ? 0 : clamp01(delivered / expected) };
}
