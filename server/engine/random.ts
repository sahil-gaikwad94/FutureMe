/**
 * Deterministic sampling primitives for the projection engine.
 *
 * Every projection must be reproducible: the same inputs always produce the
 * same bands, so a user can compare this week's trajectory against last week's
 * snapshot and trust the difference is real. We therefore seed a PRNG from a
 * stable hash of the inputs rather than touching Math.random().
 */

/** mulberry32 — small, fast, well-distributed 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash, used to derive stable seeds from user ids + inputs. */
export function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Standard normal via Box–Muller, consuming two uniforms per draw. */
export function makeGaussian(random: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = random() * 2 - 1;
      v = random() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const multiplier = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * multiplier;
    return u * multiplier;
  };
}

function gammaShapeGreaterThanOne(random: () => number, gaussian: () => number, shape: number): number {
  // Marsaglia & Tsang's method.
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    let v = 0;
    do {
      x = gaussian();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Gamma(shape, 1) sample. Shape <= 0 returns 0 rather than looping forever. */
export function sampleGamma(random: () => number, gaussian: () => number, shape: number): number {
  if (shape <= 0) return 0;
  if (shape < 1) {
    const boost = Math.pow(random(), 1 / shape);
    return gammaShapeGreaterThanOne(random, gaussian, shape + 1) * boost;
  }
  return gammaShapeGreaterThanOne(random, gaussian, shape);
}

/**
 * Beta(alpha, beta) sample — the distribution over "true adherence" implied by
 * a Bayesian posterior. This is what makes the bands honest: a habit with 2
 * check-ins has a genuinely wide Beta, so its trajectory fans out; the same
 * adherence estimate backed by 200 check-ins stays tight.
 */
export function sampleBeta(random: () => number, gaussian: () => number, alpha: number, beta: number): number {
  const a = Math.max(1e-6, alpha);
  const b = Math.max(1e-6, beta);
  const x = sampleGamma(random, gaussian, a);
  const y = sampleGamma(random, gaussian, b);
  const total = x + y;
  if (total <= 0) return a / (a + b);
  return x / total;
}

/** Empirical percentile from a sorted-agnostic numeric array. */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * clamp01(q);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
