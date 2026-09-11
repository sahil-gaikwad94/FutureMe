import { describe, expect, it } from "vitest";
import {
  betaCredibleInterval,
  currentStreak,
  decayWeight,
  deliveryRate,
  longestStreak,
  updateAdherence,
  updateBayesianConsistency,
} from "./evidence";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("Bayesian adherence", () => {
  it("moves up on a completed check-in and down on a miss", () => {
    const prior = updateBayesianConsistency(7, 3, 0, 0);
    expect(updateBayesianConsistency(7, 3, 1, 1).mean).toBeGreaterThan(prior.mean);
    expect(updateBayesianConsistency(7, 3, 0, 1).mean).toBeLessThan(prior.mean);
  });

  it("clamps completed above attempted instead of corrupting the posterior", () => {
    const result = updateBayesianConsistency(5, 5, 99, 2);
    expect(result.alpha).toBe(7);
    expect(result.beta).toBe(5);
  });

  it("returns a valid ordered credible interval", () => {
    const interval = betaCredibleInterval(18, 4);
    expect(interval.low).toBeGreaterThanOrEqual(0);
    expect(interval.high).toBeLessThanOrEqual(1);
    expect(interval.low).toBeLessThan(interval.high);
  });

  it("narrows the interval as evidence accumulates", () => {
    const thin = betaCredibleInterval(7, 3);
    const thick = betaCredibleInterval(70, 30);
    expect(thick.high - thick.low).toBeLessThan(thin.high - thin.low);
  });

  it("leaves the prior untouched when there is no evidence", () => {
    const result = updateAdherence({ alpha: 7, beta: 3 }, [], NOW);
    expect(result.mean).toBeCloseTo(0.7, 5);
    expect(result.sampleSize).toBe(0);
    expect(result.weight).toBe(0);
  });

  it("converges toward the observed rate with enough evidence", () => {
    const records = Array.from({ length: 60 }, (_, index) => ({ completed: index % 4 !== 0, date: daysAgo(index) }));
    const result = updateAdherence({ alpha: 7, beta: 3 }, records, NOW);
    // 45 of 60 completed = 0.75 observed.
    expect(result.mean).toBeGreaterThan(0.68);
    expect(result.mean).toBeLessThan(0.82);
  });
});

describe("evidence decay", () => {
  it("halves the weight of a check-in at the half-life", () => {
    expect(decayWeight(0)).toBeCloseTo(1, 5);
    expect(decayWeight(90)).toBeCloseTo(0.5, 5);
    expect(decayWeight(180)).toBeCloseTo(0.25, 5);
  });

  it("counts old evidence toward the mean but not fully toward confidence", () => {
    const fresh = updateAdherence({ alpha: 7, beta: 3 }, Array.from({ length: 30 }, (_, i) => ({ completed: true, date: daysAgo(i) })), NOW);
    const stale = updateAdherence({ alpha: 7, beta: 3 }, Array.from({ length: 30 }, (_, i) => ({ completed: true, date: daysAgo(300 + i) })), NOW);
    expect(fresh.weight).toBeGreaterThan(stale.weight);
    expect(fresh.alpha).toBeGreaterThan(stale.alpha);
  });

  it("rejects nonsense dates rather than poisoning the posterior", () => {
    const result = updateAdherence({ alpha: 7, beta: 3 }, [{ completed: true, date: new Date("not a date") }], NOW);
    expect(Number.isFinite(result.mean)).toBe(true);
  });
});

describe("streaks", () => {
  it("counts consecutive completed days", () => {
    expect(currentStreak([daysAgo(0), daysAgo(1), daysAgo(2)], NOW)).toBe(3);
  });

  it("survives today not being logged yet, so midnight does not reset it", () => {
    expect(currentStreak([daysAgo(1), daysAgo(2)], NOW)).toBe(2);
  });

  it("breaks on a gap", () => {
    expect(currentStreak([daysAgo(0), daysAgo(1), daysAgo(4), daysAgo(5)], NOW)).toBe(2);
  });

  it("is zero when nothing recent happened", () => {
    expect(currentStreak([daysAgo(10)], NOW)).toBe(0);
    expect(currentStreak([], NOW)).toBe(0);
  });

  it("de-duplicates same-day check-ins", () => {
    expect(currentStreak([daysAgo(0), daysAgo(0), daysAgo(1)], NOW)).toBe(2);
  });

  it("reports the longest run ever, independent of the current one", () => {
    expect(longestStreak([daysAgo(0), daysAgo(10), daysAgo(11), daysAgo(12)])).toBe(3);
  });
});

describe("delivery rate", () => {
  it("measures delivered against what the cadence asked for", () => {
    const records = Array.from({ length: 8 }, (_, index) => ({
      habitId: 1,
      date: daysAgo(index * 2).toISOString().slice(0, 10),
      completed: true,
    }));
    // 3x/week over 28 days asks for 12; 8 delivered.
    const result = deliveryRate(records, 3, 28, NOW);
    expect(result.expected).toBe(12);
    expect(result.delivered).toBe(8);
    expect(result.rate).toBeCloseTo(8 / 12, 5);
  });

  it("ignores misses when counting delivered", () => {
    const records = [
      { habitId: 1, date: daysAgo(1).toISOString().slice(0, 10), completed: false },
      { habitId: 1, date: daysAgo(2).toISOString().slice(0, 10), completed: true },
    ];
    expect(deliveryRate(records, 1, 28, NOW).delivered).toBe(1);
  });

  it("caps at 1 and handles a zero cadence", () => {
    const records = Array.from({ length: 40 }, (_, index) => ({ habitId: 1, date: daysAgo(index).toISOString().slice(0, 10), completed: true }));
    expect(deliveryRate(records, 1, 28, NOW).rate).toBeLessThanOrEqual(1);
    expect(deliveryRate([], 0, 28, NOW).rate).toBe(0);
  });

  it("excludes evidence older than the window", () => {
    const records = [{ habitId: 1, date: daysAgo(200).toISOString().slice(0, 10), completed: true }];
    expect(deliveryRate(records, 3, 28, NOW).delivered).toBe(0);
  });
});
