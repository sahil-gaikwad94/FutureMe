import { describe, expect, it } from "vitest";
import {
  attainment,
  buildProjection,
  effortFactor,
  projectDomain,
  requiredMonthlyContribution,
  simulate,
  solveRequiredAdherence,
} from "./projection";

const career = { domain: "career" as const, baseline: 38, target: 92, weeklyHours: 6, frequency: 4, adherence: 0.75, horizonYears: 5 };

describe("projection engine — invariants", () => {
  it("is deterministic for identical inputs, so snapshots are comparable", () => {
    expect(buildProjection({}, 5)).toEqual(buildProjection({}, 5));
  });

  it("produces one point per year plus the present", () => {
    const domain = projectDomain(career);
    expect(domain.points).toHaveLength(6);
    expect(domain.points.map(point => point.year)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("starts at the baseline, in native units", () => {
    const domain = projectDomain(career);
    expect(domain.points[0].raw).toBeCloseTo(38, 6);
    expect(domain.points[0].value).toBeCloseTo(0, 6);
  });

  it("keeps every band ordered and inside 0–100 attainment", () => {
    for (const domain of buildProjection({}, 5).scenarios.realistic) {
      for (const point of domain.points) {
        expect(point.low).toBeGreaterThanOrEqual(0);
        expect(point.high).toBeLessThanOrEqual(100);
        expect(point.low).toBeLessThanOrEqual(point.value);
        expect(point.value).toBeLessThanOrEqual(point.high);
      }
    }
  });

  it("keeps the realistic branch between pessimistic and optimistic", () => {
    const projection = buildProjection({}, 5);
    for (const domain of projection.scenarios.realistic) {
      const low = projection.scenarios.pessimistic.find(item => item.domain === domain.domain)!;
      const high = projection.scenarios.optimistic.find(item => item.domain === domain.domain)!;
      expect(low.score).toBeLessThanOrEqual(domain.score);
      expect(domain.score).toBeLessThanOrEqual(high.score);
    }
  });

  it("reports a probability between 0 and 1", () => {
    for (const domain of buildProjection({}, 5).scenarios.realistic) {
      expect(domain.probabilityOfTarget).toBeGreaterThanOrEqual(0);
      expect(domain.probabilityOfTarget).toBeLessThanOrEqual(1);
    }
  });

  it("only projects domains the user actually has goals in", () => {
    const projection = buildProjection({ health: { ...career, domain: "health" } }, 5);
    expect(projection.scenarios.realistic).toHaveLength(1);
    expect(projection.scenarios.realistic[0].domain).toBe("health");
  });
});

describe("projection engine — calibration", () => {
  it("makes the target more likely as consistency rises", () => {
    const levels = [0.3, 0.5, 0.7, 0.9, 1.0].map(adherence =>
      simulate({ ...career, adherence }, { paths: 800 }).probabilityOfTarget,
    );
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1]);
    }
    expect(levels[levels.length - 1]).toBeGreaterThan(levels[0]);
  });

  it("lands the median on the target at full adherence and full effort", () => {
    // The model's central promise: a plan you can fully fund and fully execute
    // is a coin flip on noise, not a guaranteed miss.
    const result = simulate({ ...career, weeklyHours: 8, adherence: 1 }, { paths: 1200 });
    expect(result.points[5].value).toBeGreaterThan(85);
    expect(result.probabilityOfTarget).toBeGreaterThan(0.2);
  });

  it("treats committed hours as a real lever", () => {
    const starved = simulate({ ...career, weeklyHours: 2, adherence: 0.9 }, { paths: 600 });
    const funded = simulate({ ...career, weeklyHours: 16, adherence: 0.9 }, { paths: 600 });
    expect(funded.points[5].value).toBeGreaterThan(starved.points[5].value + 10);
    expect(funded.probabilityOfTarget).toBeGreaterThan(starved.probabilityOfTarget);
  });

  it("saturates effort rather than scaling it linearly", () => {
    expect(effortFactor("career", 8)).toBeCloseTo(1, 1);
    expect(effortFactor("career", 16)).toBeLessThan(1.25);
    expect(effortFactor("career", 0)).toBeLessThan(0.15);
  });

  it("widens the bands when there is little evidence", () => {
    const thin = simulate({ ...career, alpha: 7, beta: 3 }, { paths: 900 });
    const thick = simulate({ ...career, alpha: 70, beta: 30 }, { paths: 900 });
    expect(thin.spread).toBeGreaterThan(thick.spread);
  });

  it("gives lower confidence to an untested plan than an evidenced one", () => {
    const untested = projectDomain({ ...career, evidenceCount: 0 });
    const evidenced = projectDomain({ ...career, evidenceCount: 120 });
    expect(evidenced.confidence).toBeGreaterThan(untested.confidence + 0.1);
  });
});

describe("projection engine — deadlines", () => {
  it("judges a deadline-bound goal at the deadline, not the horizon", () => {
    // Regression: a 1-year deadline scored at year 5 read as a near-certain
    // success, because five years of extra runway had been quietly granted.
    const short = simulate({ ...career, targetYears: 1, horizonYears: 5 }, { paths: 800 });
    const long = simulate({ ...career, targetYears: 5, horizonYears: 5 }, { paths: 800 });
    expect(short.evaluatedAtYear).toBe(1);
    expect(long.evaluatedAtYear).toBe(5);
    expect(short.probabilityOfTarget).toBeLessThan(long.probabilityOfTarget);
  });

  it("never scores past the horizon", () => {
    const result = simulate({ ...career, targetYears: 99, horizonYears: 5 }, { paths: 200 });
    expect(result.evaluatedAtYear).toBe(5);
  });
});

describe("projection engine — bottleneck diagnosis", () => {
  it("names consistency when consistency is the only thing missing", () => {
    const domain = projectDomain({ ...career, weeklyHours: 12, adherence: 0.9 });
    expect(domain.bottleneck).toBe("consistency");
    expect(domain.feasible).toBe(true);
  });

  it("names weekly time when the hours cannot reach the target", () => {
    const domain = projectDomain({ ...career, weeklyHours: 1.5, adherence: 0.95 });
    expect(domain.bottleneck).toBe("effort");
    expect(domain.feasible).toBe(false);
  });

  it("names funding when a finance goal is underfunded", () => {
    const domain = projectDomain({
      domain: "finance",
      baseline: 2000,
      target: 50000,
      weeklyHours: 1,
      frequency: 1,
      adherence: 0.9,
      horizonYears: 5,
      targetYears: 5,
      monthlyContribution: 100,
    });
    expect(domain.bottleneck).toBe("funding");
  });

  it("reports on track when nothing structural is binding", () => {
    const domain = projectDomain({
      domain: "finance",
      baseline: 2000,
      target: 50000,
      weeklyHours: 1,
      frequency: 1,
      adherence: 0.95,
      horizonYears: 5,
      targetYears: 5,
      monthlyContribution: 1200,
    });
    expect(domain.bottleneck).toBe("none");
    expect(domain.probabilityOfTarget).toBeGreaterThanOrEqual(0.5);
  });

  it("does not claim 'reachable by consistency' when it is not", () => {
    const domain = projectDomain({ ...career, weeklyHours: 1.5, adherence: 0.95 });
    expect(domain.probabilityAtFullAdherence).toBeLessThan(0.5);
    expect(domain.signal).not.toContain("More likely than not");
  });
});

describe("projection engine — finance arithmetic", () => {
  it("solves the contribution that funds the target", () => {
    const input = { domain: "finance" as const, baseline: 2000, target: 50000, weeklyHours: 1, frequency: 1, adherence: 0.9, horizonYears: 5, targetYears: 5 };
    const required = requiredMonthlyContribution(input);
    expect(required).toBeGreaterThan(500);
    expect(required).toBeLessThan(900);

    // Funding exactly the required amount should land close to the target.
    const funded = simulate({ ...input, monthlyContribution: required, adherence: 1 }, { paths: 1200 });
    expect(funded.points[5].raw).toBeGreaterThan(40000);
    expect(funded.points[5].raw).toBeLessThan(62000);
  });

  it("reaches the target with no contribution when the baseline already covers it", () => {
    expect(
      requiredMonthlyContribution({ domain: "finance", baseline: 100000, target: 50000, weeklyHours: 1, frequency: 1, adherence: 0.9, horizonYears: 5, targetYears: 5 }),
    ).toBe(0);
  });

  it("moves the probability with the funding ratio", () => {
    const input = { domain: "finance" as const, baseline: 2000, target: 50000, weeklyHours: 1, frequency: 1, adherence: 0.85, horizonYears: 5, targetYears: 5 };
    const unfunded = simulate({ ...input, monthlyContribution: 0 }, { paths: 800 }).probabilityOfTarget;
    const funded = simulate({ ...input, monthlyContribution: 900 }, { paths: 800 }).probabilityOfTarget;
    expect(funded).toBeGreaterThan(unfunded);
  });
});

describe("projection engine — attainment", () => {
  it("is direction-aware, so reduction goals read correctly", () => {
    const reduce = { domain: "health" as const, baseline: 80, target: 40, weeklyHours: 3, frequency: 4, adherence: 0.8, horizonYears: 5 };
    expect(attainment(reduce, 80)).toBe(0);
    expect(attainment(reduce, 40)).toBe(100);
    expect(attainment(reduce, 60)).toBe(50);
    expect(attainment(reduce, 20)).toBe(100); // overshoot is still success
  });

  it("treats a zero-width goal as already met", () => {
    expect(attainment({ ...career, baseline: 50, target: 50 }, 50)).toBe(100);
  });
});

describe("solveRequiredAdherence", () => {
  it("returns a meaningful interior value when consistency is the lever", () => {
    const required = solveRequiredAdherence({ ...career, weeklyHours: 12, adherence: 0.5 });
    expect(required).toBeGreaterThan(0.5);
    expect(required).toBeLessThan(1);
  });

  it("returns the current adherence when the goal is already more likely than not", () => {
    const required = solveRequiredAdherence({
      domain: "finance",
      baseline: 2000,
      target: 50000,
      weeklyHours: 1,
      frequency: 1,
      adherence: 0.95,
      horizonYears: 5,
      targetYears: 5,
      monthlyContribution: 1200,
    });
    expect(required).toBeCloseTo(0.95, 5);
  });
});
