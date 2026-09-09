export const MODEL_VERSION = "v1.0";

export type Domain = "career" | "finance" | "health" | "relationships";
export type ScenarioKey = "pessimistic" | "realistic" | "optimistic";

export type ProjectionInput = {
  domain: Domain;
  baseline: number;
  target: number;
  weeklyHours: number;
  frequency: number;
  adherence: number;
  horizonYears: number;
  seed?: number;
};

export type DomainPoint = {
  year: number;
  value: number;
  low: number;
  high: number;
};

export type DomainProjection = {
  domain: Domain;
  score: number;
  delta: number;
  confidence: number;
  points: DomainPoint[];
  signal: string;
};

export type Projection = {
  modelVersion: string;
  horizonYears: number;
  scenarios: Record<ScenarioKey, DomainProjection[]>;
  currentAdherence: number;
  confidence: number;
  assumptions: string[];
};

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const seeded = (seed: number) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

export function betaMean(alpha: number, beta: number) {
  return alpha / Math.max(alpha + beta, 1);
}

export function betaCredibleInterval(alpha: number, beta: number) {
  const mean = betaMean(alpha, beta);
  const sample = Math.sqrt((mean * (1 - mean)) / Math.max(alpha + beta + 1, 1));
  return { low: clamp(mean - 1.96 * sample, 0, 1), high: clamp(mean + 1.96 * sample, 0, 1) };
}

export function updateBayesianConsistency(alpha: number, beta: number, completed: number, attempted: number) {
  const safeAttempted = Math.max(0, Math.round(attempted));
  const safeCompleted = clamp(Math.round(completed), 0, safeAttempted);
  return { alpha: alpha + safeCompleted, beta: beta + (safeAttempted - safeCompleted), mean: betaMean(alpha + safeCompleted, beta + safeAttempted - safeCompleted) };
}

function logistic(start: number, capacity: number, rate: number, year: number) {
  const normalized = clamp(start, 0, 100) / 100;
  const k = Math.max(0.05, rate);
  const midpoint = Math.log(Math.max((1 - normalized) / Math.max(normalized, 0.01), 0.01)) / -k;
  const value = capacity / (1 + Math.exp(-k * (year - midpoint)));
  return clamp(value);
}

function financeValue(start: number, contribution: number, annualReturn: number, adherence: number, year: number) {
  const monthlyRate = Math.pow(1 + annualReturn, 1 / 12) - 1;
  const months = year * 12;
  const monthlyContribution = contribution * clamp(adherence);
  if (Math.abs(monthlyRate) < 0.00001) return start + monthlyContribution * months;
  return start * Math.pow(1 + monthlyRate, months) + monthlyContribution * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);
}

function domainScore(input: ProjectionInput, adherence: number, year: number) {
  const effort = clamp(input.weeklyHours * 2.2 + input.frequency * 4);
  switch (input.domain) {
    case "career":
      return logistic(input.baseline, Math.max(input.target, 100), 0.48 * clamp(adherence) + effort / 1000, year);
    case "finance": {
      const start = Math.max(0, input.baseline);
      const amount = financeValue(start, Math.max(10, input.target), 0.07, adherence, year);
      const scale = Math.max(start + Math.max(10, input.target) * input.horizonYears * 4, 100);
      return clamp((amount / scale) * 100);
    }
    case "health": {
      const automaticity = 1 - Math.exp(-0.32 * input.frequency * clamp(adherence) * year);
      return clamp(input.baseline + (input.target - input.baseline) * automaticity);
    }
    case "relationships": {
      const connection = 1 - Math.exp(-0.18 * Math.max(1, input.frequency) * clamp(adherence) * year);
      return clamp(input.baseline + (input.target - input.baseline) * connection);
    }
  }
}

function defaultInput(domain: Domain, index: number): ProjectionInput {
  const base: Record<Domain, ProjectionInput> = {
    career: { domain, baseline: 38, target: 92, weeklyHours: 6, frequency: 4, adherence: 0.75, horizonYears: 5 },
    finance: { domain, baseline: 18, target: 850, weeklyHours: 1, frequency: 1, adherence: 0.68, horizonYears: 5 },
    health: { domain, baseline: 42, target: 86, weeklyHours: 3, frequency: 4, adherence: 0.72, horizonYears: 5 },
    relationships: { domain, baseline: 48, target: 84, weeklyHours: 2, frequency: 2, adherence: 0.64, horizonYears: 5 },
  };
  return { ...base[domain], seed: index + 1 };
}

export function projectDomain(input: ProjectionInput, adherence = input.adherence): DomainProjection {
  const points: DomainPoint[] = [];
  const horizon = Math.max(1, Math.round(input.horizonYears));
  const confidence = clamp(0.36 + adherence * 0.52, 0.2, 0.95);
  for (let year = 0; year <= horizon; year++) {
    const value = year === 0 ? clamp(input.baseline) : domainScore(input, adherence, year);
    const width = Math.max(3, (1 - confidence) * 22 + (year / horizon) * 2);
    const noise = (seeded((input.seed || 1) + year) - 0.5) * 2;
    points.push({ year, value, low: clamp(value - width + noise), high: clamp(value + width + noise) });
  }
  const score = points[points.length - 1]?.value || 0;
  return { domain: input.domain, score, delta: score - input.baseline, confidence, points, signal: signalFor(input.domain, score, input.baseline) };
}

function signalFor(domain: Domain, score: number, baseline: number) {
  const delta = score - baseline;
  if (delta > 28) return domain === "finance" ? "Compounding visibly" : "A meaningful leap";
  if (delta > 14) return "Building quiet momentum";
  return "Needs a smaller next step";
}

export function buildProjection(inputs: Partial<Record<Domain, ProjectionInput>> = {}, horizonYears = 5, adherenceOverride?: number): Projection {
  const domains: Domain[] = ["career", "finance", "health", "relationships"];
  const assumptions = ["Five-year horizon", "Bands show illustrative uncertainty, not certainty", "Consistency is updated from check-ins"];
  const scenarios: Record<ScenarioKey, DomainProjection[]> = { pessimistic: [], realistic: [], optimistic: [] };
  const rates: Record<ScenarioKey, number> = { pessimistic: 0.6, realistic: 0.85, optimistic: 1 };
  for (const [key, rate] of Object.entries(rates) as [ScenarioKey, number][]) {
    scenarios[key] = domains.map((domain, index) => {
      const input = { ...defaultInput(domain, index), ...(inputs[domain] || {}), horizonYears };
      const adherence = adherenceOverride ?? input.adherence;
      return projectDomain(input, clamp(adherence * rate, 0.05, 1));
    });
  }
  const realistic = scenarios.realistic;
  const currentAdherence = adherenceOverride ?? realistic.reduce((sum, item) => sum + (inputs[item.domain]?.adherence ?? defaultInput(item.domain, 0).adherence), 0) / domains.length;
  return { modelVersion: MODEL_VERSION, horizonYears, scenarios, currentAdherence, confidence: clamp(0.36 + currentAdherence * 0.52, 0.2, 0.95), assumptions };
}
