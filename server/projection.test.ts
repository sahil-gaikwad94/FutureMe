import { describe, expect, it } from "vitest";
import { betaCredibleInterval, buildProjection, projectDomain, updateBayesianConsistency } from "./projection";

describe("FutureMe projection engine", () => {
  it("is deterministic for the same inputs", () => {
    const first = buildProjection({}, 5);
    const second = buildProjection({}, 5);
    expect(first).toEqual(second);
  });

  it("keeps the realistic branch between pessimistic and optimistic outcomes", () => {
    const projection = buildProjection({}, 5);
    for (const domain of projection.scenarios.realistic) {
      const low = projection.scenarios.pessimistic.find(item => item.domain === domain.domain);
      const high = projection.scenarios.optimistic.find(item => item.domain === domain.domain);
      expect(low?.score).toBeLessThanOrEqual(domain.score);
      expect(domain.score).toBeLessThanOrEqual(high?.score || 100);
    }
  });

  it("keeps domain values bounded and confidence intervals ordered", () => {
    const domain = projectDomain({ domain: "health", baseline: 30, target: 90, weeklyHours: 3, frequency: 4, adherence: 0.8, horizonYears: 5 });
    expect(domain.points).toHaveLength(6);
    for (const point of domain.points) {
      expect(point.low).toBeGreaterThanOrEqual(0);
      expect(point.high).toBeLessThanOrEqual(100);
      expect(point.low).toBeLessThanOrEqual(point.value);
      expect(point.value).toBeLessThanOrEqual(point.high);
    }
  });
});

describe("Bayesian consistency updater", () => {
  it("moves upward after a completed check-in and downward after a missed one", () => {
    const prior = updateBayesianConsistency(7, 3, 0, 0);
    const completed = updateBayesianConsistency(7, 3, 1, 1);
    const missed = updateBayesianConsistency(7, 3, 0, 1);
    expect(completed.mean).toBeGreaterThan(prior.mean);
    expect(missed.mean).toBeLessThan(prior.mean);
  });

  it("returns a valid credible interval", () => {
    const interval = betaCredibleInterval(18, 4);
    expect(interval.low).toBeGreaterThanOrEqual(0);
    expect(interval.high).toBeLessThanOrEqual(1);
    expect(interval.low).toBeLessThan(interval.high);
  });
});
