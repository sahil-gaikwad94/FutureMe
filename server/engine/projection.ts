/**
 * Trajectory projection engine.
 *
 * Replaces the previous closed-form curve plus a sine-hash "noise" term with an
 * actual Monte Carlo simulation. The distinction matters for the product's
 * central promise: a five-year projection is only useful if the uncertainty it
 * shows is a real distribution implied by real evidence, and if it can answer
 * "what are the odds I actually get there?"
 *
 * Every run is seeded from the inputs, so results are reproducible and
 * comparable across snapshots.
 */

import {
  clamp,
  clamp01,
  hashSeed,
  makeGaussian,
  mean,
  mulberry32,
  percentile,
  sampleBeta,
  stddev,
} from "./random";

export const MODEL_VERSION = "v2.0";

export type Domain = "career" | "finance" | "health" | "relationships";
export type ScenarioKey = "pessimistic" | "realistic" | "optimistic";

export const DOMAINS: Domain[] = ["career", "finance", "health", "relationships"];

export const DOMAIN_LABELS: Record<Domain, string> = {
  career: "Work and learning",
  finance: "Money",
  health: "Health",
  relationships: "Relationships",
};

export type ProjectionInput = {
  domain: Domain;
  /** Current level in the domain's native unit (0–100 score, or currency). */
  baseline: number;
  /** Desired level in the same unit. */
  target: number;
  weeklyHours: number;
  /** Sessions per week. */
  frequency: number;
  /** Point estimate of adherence, 0–1. Used when alpha/beta are absent. */
  adherence: number;
  horizonYears: number;
  /**
   * Beta posterior over true adherence. When present the simulation samples
   * adherence per path, which is what widens the bands for thin evidence.
   */
  alpha?: number;
  beta?: number;
  /** Effective evidence backing the adherence estimate. 0 means "pure prior". */
  evidenceCount?: number;
  /** Years until the stated deadline, if any. Drives urgency in the growth rate. */
  targetYears?: number;
  /** Finance only: money added per month. */
  monthlyContribution?: number;
  /** Finance only: expected annual return. Defaults to a broad-market estimate. */
  annualReturn?: number;
  seed?: number;
};

export type DomainPoint = {
  year: number;
  /** Progress toward target, 0–100. */
  value: number;
  low: number;
  high: number;
  /** Same point in the domain's native unit (currency for finance). */
  raw: number;
  rawLow: number;
  rawHigh: number;
};

export type DomainProjection = {
  domain: Domain;
  score: number;
  /** Change in the domain's native unit over the horizon. */
  delta: number;
  /** Same change, human-readable and unit-aware. */
  deltaLabel: string;
  confidence: number;
  points: DomainPoint[];
  signal: string;
  /** Probability the final year clears the stated target, 0–1. */
  probabilityOfTarget: number;
  /**
   * Lowest adherence that makes the goal more likely than not (P ≥ 0.5).
   * 0.5 rather than a higher bar because the noise here is median-preserving:
   * even flawless consistency only makes a stretch goal a coin flip, so
   * demanding 80% would report "impossible" for almost every real goal.
   */
  requiredAdherence: number;
  /** Probability at flawless adherence, holding effort and deadline fixed. */
  probabilityAtFullAdherence: number;
  /** True when perfect consistency alone would make the goal more likely than not. */
  feasible: boolean;
  /** The year the probability above is judged at (the deadline, when set). */
  evaluatedAtYear: number;
  /** The binding constraint, named so the plan can address the right thing. */
  bottleneck: Bottleneck;
  /** Finance only: monthly contribution that would fund the target. */
  requiredMonthlyContribution?: number;
  assumptions: string[];
  adherenceUsed: number;
  evidenceCount: number;
  unit: string;
};

/**
 * The single constraint that is actually holding the goal back. Computed by
 * re-running the simulation with one lever relaxed at a time, so it is a
 * measurement rather than a heuristic guess.
 */
export type Bottleneck = "none" | "consistency" | "effort" | "funding" | "time" | "target";

export const BOTTLENECK_LABELS: Record<Bottleneck, string> = {
  none: "On track",
  consistency: "Consistency",
  effort: "Weekly time",
  funding: "Monthly money",
  time: "Deadline",
  target: "The target itself",
};

export type Projection = {
  modelVersion: string;
  horizonYears: number;
  scenarios: Record<ScenarioKey, DomainProjection[]>;
  currentAdherence: number;
  confidence: number;
  assumptions: string[];
  paths: number;
  /** Weighted composite, 0–100 — the headline "where this is heading" number. */
  composite: number;
};

const DOMAIN_UNITS: Record<Domain, string> = {
  career: "readiness",
  finance: "currency",
  health: "readiness",
  relationships: "readiness",
};

/** Process-noise scale per domain, as a fraction of the remaining gap per year. */
const VOLATILITY: Record<Domain, number> = {
  career: 0.16,
  finance: 0.11,
  health: 0.13,
  relationships: 0.15,
};

/** How strongly weekly effort accelerates the domain. */
const EFFORT_SATURATION_HOURS: Record<Domain, number> = {
  career: 10,
  finance: 4,
  health: 6,
  relationships: 4,
};

/**
 * Progress toward target on a 0–100 scale, direction-aware. Clamped, so a run
 * that overshoots still reads as 100 and "reached the target" is an exact test.
 */
export function attainment(input: ProjectionInput, raw: number): number {
  const span = input.target - input.baseline;
  if (Math.abs(span) < 1e-9) return 100;
  return clamp(((raw - input.baseline) / span) * 100, 0, 100);
}

/**
 * Weekly hours that "fully fund" a plan in each domain. Used as the reference
 * load: committing exactly this much yields an effort factor of 1.0, so the
 * median simulated future lands on the stated target and the risk the bands
 * express is genuinely about consistency rather than about an arbitrary growth
 * constant.
 */
const REFERENCE_WEEKLY_HOURS: Record<Domain, number> = {
  career: 8,
  finance: 1,
  health: 4,
  relationships: 2,
};

/** Sessions per week at which a behaviour becomes reliably automatic. */
const REFERENCE_WEEKLY_FREQUENCY: Record<Domain, number> = {
  career: 3,
  finance: 1,
  health: 4,
  relationships: 2,
};

/**
 * Headroom past the target, as a fraction of the gap. A strong run can
 * overshoot rather than pinning at exactly 100%, which is what makes
 * "probability of reaching the target" a non-degenerate quantity.
 */
const TARGET_HEADROOM = 1.12;

/**
 * Share of the headroom-extended gap that must be closed to land exactly on
 * target: (headroom - 1) / headroom. Constant across goals, which is the point —
 * the required pace is derived from the user's own baseline, target and
 * deadline rather than from a curve we picked for them.
 */
const REMAINING_AT_TARGET = (TARGET_HEADROOM - 1) / TARGET_HEADROOM;

/** -ln(REMAINING_AT_TARGET): the total gap-closure "work" a goal requires. */
const WORK_TO_TARGET = -Math.log(REMAINING_AT_TARGET);

/**
 * Maps committed weekly hours onto a pace multiplier. 1.0 at the reference
 * load, saturating near 1.25 — extra hours help, but not linearly.
 *
 * The reference load scales with the runway. The pace a goal requires is
 * inversely proportional to the time it has, so a one-year deadline needs about
 * five times the weekly hours a five-year one does. Without this, shortening a
 * deadline changed nothing at fixed hours, which quietly made urgency free.
 */
export function effortFactor(domain: Domain, weeklyHours: number, years = 5): number {
  const reference = REFERENCE_WEEKLY_HOURS[domain] * (5 / clamp(years, 0.5, 30));
  const ratio = Math.max(0, weeklyHours) / reference;
  return clamp(1.25 * (1 - Math.exp(-1.6 * ratio)), 0.1, 1.25);
}

/**
 * Maps sessions-per-week onto a pace multiplier for behaviour domains, where
 * repetition rather than raw hours is the mechanism.
 */
function frequencyFactor(domain: Domain, frequency: number): number {
  const reference = REFERENCE_WEEKLY_FREQUENCY[domain];
  return clamp(frequency / reference, 0.08, 1.6);
}

/** Years the plan actually has: the deadline if one is set, else the horizon. */
function effectiveYears(input: ProjectionInput): number {
  const horizon = input.horizonYears;
  if (!input.targetYears || input.targetYears <= 0) return horizon;
  return clamp(Math.round(input.targetYears), 1, horizon);
}

/**
 * Gap-closure simulation, shared by every non-finance domain.
 *
 * The remaining distance to the goal decays geometrically: `gap *= exp(-k)`,
 * where `k` is the work rate — the pace the goal *requires* (solved from the
 * user's own baseline, target and deadline) times what the user actually
 * supplies (effort and adherence).
 *
 * Noise has two parts, both median-preserving so the unshocked trajectory is
 * the median path: a persistent per-path drift, so each simulated future has a
 * coherent character instead of year-to-year whiplash, and a per-year shock,
 * so one bad year does not define the path. The gap is carried forward rather
 * than recomputed from a resampled rate, which keeps paths internally
 * consistent.
 */
function simulateGapClosure(
  input: ProjectionInput,
  adherence: number,
  gaussian: () => number,
  horizon: number,
  options: { multiplier: number; volatility: number },
): number[] {
  const span = input.target - input.baseline;
  const capacitySpan = span === 0 ? Math.max(Math.abs(input.baseline), 1) * 0.1 : span * TARGET_HEADROOM;
  const capacity = input.baseline + capacitySpan;
  const years = effectiveYears(input);
  const rate = (WORK_TO_TARGET / years) * options.multiplier * adherence;
  const drift = gaussian() * options.volatility * 1.4;

  let gap = capacitySpan;
  const values: number[] = [input.baseline];
  for (let year = 1; year <= horizon; year += 1) {
    const shock = gaussian() * options.volatility;
    gap *= Math.exp(-rate * Math.exp(drift + shock));
    values.push(capacity - gap);
  }
  return values;
}

function futureValue(start: number, monthlyContribution: number, annualReturn: number, years: number): number {
  const monthlyRate = Math.pow(1 + annualReturn, 1 / 12) - 1;
  const months = years * 12;
  if (Math.abs(monthlyRate) < 1e-7) return start + monthlyContribution * months;
  const growth = Math.pow(1 + monthlyRate, months);
  return start * growth + monthlyContribution * ((growth - 1) / monthlyRate);
}

/**
 * Finance has an exact answer to "what does this cost per month?", so the lever
 * is funding rather than effort: the share of the required contribution the
 * user actually puts in. Overfunding is allowed to help but capped, since
 * extrapolating a 10x contribution is not a plan.
 */
function simulateFinance(input: ProjectionInput, adherence: number, gaussian: () => number, horizon: number): number[] {
  // Return drawn once per path: one market regime, not independent yearly coin
  // flips, which would badly understate long-horizon risk.
  const annualReturn = clamp(gaussian() * 0.11 + (input.annualReturn ?? 0.065), -0.15, 0.2);
  const required = requiredMonthlyContribution(input);
  const funded = required > 0 ? clamp((input.monthlyContribution ?? 0) / required, 0, 2) : 1;
  const contribution = required * funded * adherence;
  const values: number[] = [input.baseline];
  for (let year = 1; year <= horizon; year += 1) {
    values.push(Math.max(0, futureValue(input.baseline, contribution, annualReturn, year)));
  }
  return values;
}

function simulatePath(input: ProjectionInput, adherence: number, gaussian: () => number, horizon: number): number[] {
  switch (input.domain) {
    case "finance":
      return simulateFinance(input, adherence, gaussian, horizon);
    case "career":
      return simulateGapClosure(input, adherence, gaussian, horizon, {
        multiplier: effortFactor("career", input.weeklyHours, effectiveYears(input)),
        volatility: VOLATILITY.career,
      });
    case "health":
    case "relationships":
      return simulateGapClosure(input, adherence, gaussian, horizon, {
        multiplier: frequencyFactor(input.domain, input.frequency),
        volatility: VOLATILITY[input.domain],
      });
  }
}

function normalize(input: ProjectionInput): ProjectionInput {
  const horizon = Math.max(1, Math.round(input.horizonYears));
  return {
    ...input,
    baseline: Number.isFinite(input.baseline) ? input.baseline : 0,
    target: Number.isFinite(input.target) ? input.target : 100,
    weeklyHours: clamp(input.weeklyHours ?? 0, 0, 168),
    frequency: clamp(input.frequency ?? 0, 0, 21),
    adherence: clamp01(input.adherence ?? 0.7),
    horizonYears: horizon,
    alpha: input.alpha && input.alpha > 0 ? input.alpha : undefined,
    beta: input.beta && input.beta > 0 ? input.beta : undefined,
    evidenceCount: Math.max(0, Math.round(input.evidenceCount ?? 0)),
  };
}

export type SimulationResult = {
  points: DomainPoint[];
  probabilityOfTarget: number;
  /**
   * The year the target is judged at. When a deadline is set the goal is scored
   * at that deadline; scoring a 1-year goal at year 5 would report success for
   * a plan that already missed its date.
   */
  evaluatedAtYear: number;
  /** Dispersion of the final year across paths, in attainment points. */
  spread: number;
};

/**
 * Run the simulation. `paths` is the number of independent futures sampled.
 */
export function simulate(input: ProjectionInput, options: { paths?: number; seed?: number } = {}): SimulationResult {
  const normalized = normalize(input);
  const horizon = normalized.horizonYears;
  const paths = clamp(options.paths ?? 400, 24, 4000);
  const seed = options.seed ?? normalized.seed ?? hashSeed(`${normalized.domain}:${normalized.baseline}:${normalized.target}:${normalized.adherence}:${horizon}`);
  const random = mulberry32(seed);
  const gaussian = makeGaussian(random);

  const hasPosterior = Boolean(normalized.alpha && normalized.beta);
  const deadlineYear = clamp(Math.round(normalized.targetYears ?? horizon), 1, horizon);
  const attainmentByYear: number[][] = Array.from({ length: horizon + 1 }, () => []);
  const rawByYear: number[][] = Array.from({ length: horizon + 1 }, () => []);
  let hits = 0;

  for (let path = 0; path < paths; path += 1) {
    // Sample adherence per path from the Beta posterior when we have one. With
    // thin evidence this spreads widely and the fan you see is genuine.
    const adherence = hasPosterior
      ? sampleBeta(random, gaussian, normalized.alpha as number, normalized.beta as number)
      : clamp01(normalized.adherence + gaussian() * 0.05);
    const raw = simulatePath(normalized, adherence, gaussian, horizon);
    for (let year = 0; year <= horizon; year += 1) {
      rawByYear[year].push(raw[year]);
      attainmentByYear[year].push(attainment(normalized, raw[year]));
    }
    if (attainment(normalized, raw[deadlineYear]) >= 100) hits += 1;
  }

  const points: DomainPoint[] = [];
  for (let year = 0; year <= horizon; year += 1) {
    points.push({
      year,
      value: percentile(attainmentByYear[year], 0.5),
      low: percentile(attainmentByYear[year], 0.1),
      high: percentile(attainmentByYear[year], 0.9),
      raw: percentile(rawByYear[year], 0.5),
      rawLow: percentile(rawByYear[year], 0.1),
      rawHigh: percentile(rawByYear[year], 0.9),
    });
  }

  return {
    points,
    probabilityOfTarget: hits / paths,
    evaluatedAtYear: deadlineYear,
    spread: stddev(attainmentByYear[horizon]),
  };
}

/**
 * Lowest adherence that lifts P(target) to `threshold`. Solved by bisection on
 * a cheaper simulation so the cost stays bounded.
 */
export function solveRequiredAdherence(input: ProjectionInput, threshold = 0.5, paths = 140): number {
  const normalized = normalize(input);
  const base = simulate({ ...normalized, alpha: undefined, beta: undefined }, { paths }).probabilityOfTarget;
  if (base >= threshold) return clamp01(normalized.adherence);

  let low = normalized.adherence;
  let high = 1;
  if (simulate({ ...normalized, adherence: high, alpha: undefined, beta: undefined }, { paths }).probabilityOfTarget < threshold) {
    // Even perfect consistency does not get there — the target itself is the
    // binding constraint, and saying so is more useful than returning 1.0.
    return 1;
  }
  for (let i = 0; i < 12; i += 1) {
    const mid = (low + high) / 2;
    const probability = simulate({ ...normalized, adherence: mid, alpha: undefined, beta: undefined }, { paths }).probabilityOfTarget;
    if (probability >= threshold) high = mid;
    else low = mid;
  }
  return clamp01(high);
}

/**
 * Monthly contribution that would fund a finance target at the median return.
 * Returned so the plan can name a concrete number instead of "save more".
 */
export function requiredMonthlyContribution(input: ProjectionInput): number {
  const annualReturn = input.annualReturn ?? 0.065;
  const monthlyRate = Math.pow(1 + annualReturn, 1 / 12) - 1;
  const months = Math.max(1, Math.round((input.targetYears ?? input.horizonYears) * 12));
  const growth = Math.pow(1 + monthlyRate, months);
  const gap = input.target - input.baseline * growth;
  if (gap <= 0) return 0;
  if (Math.abs(monthlyRate) < 1e-7) return gap / months;
  return Math.max(0, gap / ((growth - 1) / monthlyRate));
}

/**
 * Confidence in the projection. Driven by evidence volume first and adherence
 * second: a plan nobody has executed yet deserves wide bands no matter how
 * confident its owner feels.
 */
function confidenceFor(input: ProjectionInput, spread: number): number {
  const evidence = input.evidenceCount ?? 0;
  const evidenceFactor = 1 - Math.exp(-evidence / 18);
  const adherenceFactor = clamp01(input.adherence);
  const dispersionPenalty = clamp(spread / 45, 0, 0.25);
  return clamp(0.18 + 0.5 * evidenceFactor + 0.32 * adherenceFactor - dispersionPenalty, 0.08, 0.95);
}

function signalFor(domain: Domain, probability: number, delta: number, bottleneck: Bottleneck): string {
  if (probability >= 0.5) return "More likely than not at current consistency";
  if (delta <= 1) return "Flat — the plan is not moving this yet";
  switch (bottleneck) {
    case "consistency":
      return "Consistency is the binding constraint";
    case "effort":
      return domain === "finance" ? "Underfunded for the target" : "The weekly hours are the limit, not the effort";
    case "funding":
      return "Underfunded for the target";
    case "time":
      return "Reachable with a longer runway";
    case "target":
      return "Target is out of reach on these constraints";
    default:
      return "Will fall short without a change";
  }
}

function assumptionsFor(input: ProjectionInput): string[] {
  const list = [
    `Simulated ${input.horizonYears} year${input.horizonYears === 1 ? "" : "s"} forward from today`,
    `Adherence treated as ${(input.adherence * 100).toFixed(0)}%${(input.evidenceCount ?? 0) > 0 ? `, estimated from ${input.evidenceCount} check-in${(input.evidenceCount ?? 0) === 1 ? "" : "s"}` : ", with no check-in evidence yet"}`,
  ];
  switch (input.domain) {
    case "career":
      list.push(`Weekly hours are measured against a ${Math.round(REFERENCE_WEEKLY_HOURS.career * (5 / Math.max(0.5, input.targetYears ?? input.horizonYears)))}h/week reference for this runway — a shorter deadline needs more hours, not the same hours faster`, "Market conditions are held neutral — no boom or layoff cycle is modelled");
      break;
    case "finance":
      list.push(`Median annual return of ${((input.annualReturn ?? 0.065) * 100).toFixed(1)}% with year-to-year variation`, "Inflation is not adjusted for — figures are nominal", "Tax and fees are not modelled");
      break;
    case "health":
      list.push("Progress scales with sessions per week against a 4x/week reference", "No medical outcome is predicted — this tracks the behaviour, not the body");
      break;
    case "relationships":
      list.push("Connection builds with repeated contact against a 2x/week reference", "Assumes the other party remains willing — a projection cannot model that");
      break;
  }
  return list;
}

/**
 * Name the binding constraint by relaxing one lever at a time and seeing which
 * one actually clears the bar. Deterministic, cheap, and specific enough to
 * drive a plan: "you need 9 more hours a week" beats "stay consistent".
 */
/** How close to even-money still counts as "consistency is the lever". */
const NEAR_MISS = 0.08;

/**
 * Name the binding constraint by relaxing one lever at a time and seeing which
 * one actually clears the bar. Deterministic, cheap, and specific enough to
 * drive a plan: "you need 9 more hours a week" beats "stay consistent".
 *
 * Order matters. Consistency is checked first because it is the only lever the
 * user controls daily, and a near-miss at full adherence is a consistency
 * problem rather than a structural one — reporting it as "the target is
 * unrealistic" when the honest answer is "you did 40% of the plan" would be
 * both wrong and demoralising.
 */
function diagnoseBottleneck(
  input: ProjectionInput,
  current: number,
  atFullAdherence: number,
  threshold: number,
): Bottleneck {
  if (current >= threshold) return "none";
  if (atFullAdherence >= threshold - NEAR_MISS) return "consistency";

  const probe = (candidate: ProjectionInput) =>
    simulate({ ...normalize(candidate), alpha: undefined, beta: undefined }, { paths: 120 }).probabilityOfTarget;

  if (input.domain === "finance") {
    const required = requiredMonthlyContribution(input);
    if (required > 0 && (input.monthlyContribution ?? 0) < required) return "funding";
  }

  const scaledReference = REFERENCE_WEEKLY_HOURS[input.domain] * (5 / clamp(effectiveYears(input), 0.5, 30));
  if (probe({ ...input, weeklyHours: scaledReference * 2, frequency: Math.max(input.frequency, 6) }) >= threshold) return "effort";
  if (probe({ ...input, targetYears: (input.targetYears ?? input.horizonYears) * 2, horizonYears: clamp(input.horizonYears * 2, 1, 30) }) >= threshold) return "time";
  return "target";
}

export function projectDomain(input: ProjectionInput, adherence = input.adherence): DomainProjection {
  const normalized = normalize({ ...input, adherence });
  const result = simulate(normalized);
  const finalPoint = result.points[result.points.length - 1];
  const score = finalPoint.value;
  const rawDelta = finalPoint.raw - normalized.baseline;
  const unit = DOMAIN_UNITS[normalized.domain];
  const confidence = confidenceFor(normalized, result.spread);
  // Only meaningful when consistency is the lever; otherwise "100%" reads as
  // "just try harder" for a goal that effort alone cannot reach.
  const required = solveRequiredAdherence(normalized);
  const atFullAdherence = simulate({ ...normalized, adherence: 1, alpha: undefined, beta: undefined }, { paths: 200 }).probabilityOfTarget;
  const threshold = 0.5;
  const bottleneck = diagnoseBottleneck(normalized, result.probabilityOfTarget, atFullAdherence, threshold);

  return {
    domain: normalized.domain,
    score,
    delta: rawDelta,
    deltaLabel: normalized.domain === "finance" ? formatCurrency(rawDelta) : `${rawDelta >= 0 ? "+" : ""}${rawDelta.toFixed(1)} ${unit}`,
    confidence,
    points: result.points,
    signal: signalFor(normalized.domain, result.probabilityOfTarget, score, bottleneck),
    probabilityOfTarget: result.probabilityOfTarget,
    evaluatedAtYear: result.evaluatedAtYear,
    requiredAdherence: required,
    probabilityAtFullAdherence: atFullAdherence,
    feasible: atFullAdherence >= threshold - NEAR_MISS,
    bottleneck,
    requiredMonthlyContribution: normalized.domain === "finance" ? requiredMonthlyContribution(normalized) : undefined,
    assumptions: assumptionsFor(normalized),
    adherenceUsed: clamp01(adherence),
    evidenceCount: normalized.evidenceCount ?? 0,
    unit,
  };
}

export function formatCurrency(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(2)}M`;
  if (absolute >= 10_000) return `${sign}$${(absolute / 1000).toFixed(1)}k`;
  return `${sign}$${absolute.toFixed(0)}`;
}

function defaultInput(domain: Domain, index: number): ProjectionInput {
  const base: Record<Domain, ProjectionInput> = {
    career: { domain, baseline: 38, target: 92, weeklyHours: 6, frequency: 4, adherence: 0.75, horizonYears: 5, alpha: 7.5, beta: 2.5, evidenceCount: 0 },
    finance: { domain, baseline: 1200, target: 24000, weeklyHours: 1, frequency: 1, adherence: 0.68, horizonYears: 5, alpha: 6.8, beta: 3.2, evidenceCount: 0, monthlyContribution: 250 },
    health: { domain, baseline: 42, target: 86, weeklyHours: 3, frequency: 4, adherence: 0.72, horizonYears: 5, alpha: 7.2, beta: 2.8, evidenceCount: 0 },
    relationships: { domain, baseline: 48, target: 84, weeklyHours: 2, frequency: 2, adherence: 0.64, horizonYears: 5, alpha: 6.4, beta: 3.6, evidenceCount: 0 },
  };
  return { ...base[domain], seed: index + 1 };
}

/**
 * Composite "where this is heading" score across the domains the user has
 * actually set goals for. Domains without goals are excluded rather than
 * dragged in at a default, which would quietly invent a life the user does not
 * have.
 */
function compositeFrom(domains: DomainProjection[]): number {
  if (domains.length === 0) return 0;
  const weighted = domains.reduce((sum, item) => sum + item.score * Math.max(0.3, item.confidence), 0);
  const weights = domains.reduce((sum, item) => sum + Math.max(0.3, item.confidence), 0);
  return weights === 0 ? 0 : clamp(weighted / weights, 0, 100);
}

export function buildProjection(
  inputs: Partial<Record<Domain, ProjectionInput>> = {},
  horizonYears = 5,
  adherenceOverride?: number,
  options: { paths?: number; seed?: number } = {},
): Projection {
  const horizon = clamp(Math.round(horizonYears), 1, 30);
  const activeDomains = DOMAINS.filter(domain => inputs[domain]);
  const domainsToProject = activeDomains.length > 0 ? activeDomains : DOMAINS;

  const built = domainsToProject.map((domain, index) => {
    const merged = normalize({ ...defaultInput(domain, index), ...(inputs[domain] || {}), horizonYears: horizon });
    const adherence = adherenceOverride !== undefined ? clamp01(adherenceOverride) : merged.adherence;
    return projectDomain(merged, adherence);
  });

  const realistic = built;
  const pessimistic = built.map(item => withScenario(item, 0.1));
  const optimistic = built.map(item => withScenario(item, 0.9));

  const adherenceValues = built.map(item => item.adherenceUsed);
  const currentAdherence = mean(adherenceValues);
  const confidence = clamp(0.18 + 0.5 * mean(built.map(item => 1 - Math.exp(-item.evidenceCount / 18))) + 0.32 * currentAdherence, 0.08, 0.95);

  const assumptions = [
    `${options.paths ?? 400} simulated futures per domain, seeded so results are reproducible`,
    "Bands are the 10th to 90th percentile of those futures — 8 of 10 simulated outcomes land inside them",
    "Consistency is estimated from your check-ins and decays with age, so recent behaviour counts most",
    "This is a scenario model, not a forecast. Finance and health figures are illustrative, not advice",
  ];

  return {
    modelVersion: MODEL_VERSION,
    horizonYears: horizon,
    scenarios: { pessimistic, realistic, optimistic },
    currentAdherence,
    confidence,
    assumptions,
    paths: options.paths ?? 400,
    composite: compositeFrom(realistic),
  };
}

/**
 * Derive a named scenario by reading a different percentile off the same
 * simulation. Cheaper than re-running, and internally consistent: the
 * pessimistic, realistic and optimistic lines are the same distribution viewed
 * three ways, not three unrelated models.
 */
function withScenario(projection: DomainProjection, q: number): DomainProjection {
  const points = projection.points.map(point => {
    const low = point.low;
    const high = point.high;
    const value = q <= 0.5 ? low + (point.value - low) * (q / 0.5) : point.value + (high - point.value) * ((q - 0.5) / 0.5);
    const rawSpan = point.rawHigh - point.rawLow;
    return {
      ...point,
      value: clamp(value, 0, 100),
      raw: point.rawLow + rawSpan * q,
    };
  });
  const finalScore = points[points.length - 1]?.value ?? 0;
  return {
    ...projection,
    points,
    score: finalScore,
    signal: q <= 0.5 ? "If consistency slips" : "If consistency holds and compounds",
  };
}

export { defaultInput, percentile };
