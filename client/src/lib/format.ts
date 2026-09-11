/** Shared client-side formatting and small view helpers. */

import type { Domain } from "../../../server/engine/projection";

export const DOMAIN_META: Record<Domain, { label: string; short: string; color: string }> = {
  career: { label: "Work and learning", short: "Career", color: "var(--chart-1)" },
  finance: { label: "Money", short: "Money", color: "var(--chart-2)" },
  health: { label: "Health", short: "Health", color: "var(--chart-3)" },
  relationships: { label: "Relationships", short: "People", color: "var(--chart-4)" },
};

export const DOMAIN_LIST = Object.keys(DOMAIN_META) as Domain[];

export function percent(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function score(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

export function money(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(2)}M`;
  if (absolute >= 10_000) return `${sign}$${(absolute / 1000).toFixed(1)}k`;
  if (absolute >= 1000) return `${sign}$${absolute.toFixed(0)}`;
  return `${sign}$${absolute.toFixed(0)}`;
}

/** Domain-aware number formatting: money for finance, points elsewhere. */
export function domainValue(domain: Domain, value: number): string {
  return domain === "finance" ? money(value) : value.toFixed(0);
}

export function relativeDays(days: number | null | undefined): string {
  if (days === null || days === undefined) return "no date";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 0) return days < 31 ? `in ${days} days` : days < 365 ? `in ${Math.round(days / 30)} months` : `in ${(days / 365).toFixed(1)} years`;
  const past = Math.abs(days);
  return past < 31 ? `${past} days ago` : past < 365 ? `${Math.round(past / 30)} months ago` : `${(past / 365).toFixed(1)} years ago`;
}

export function shortDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function timeAgo(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86_400 * 7) return `${Math.floor(seconds / 86_400)}d ago`;
  return shortDate(date);
}

/** Bottleneck → the copy that explains it without jargon. */
export const BOTTLENECK_COPY: Record<string, { label: string; hint: string; tone: "good" | "warn" | "bad" }> = {
  none: { label: "On track", hint: "Nothing structural is blocking this. The risk is drift, not feasibility.", tone: "good" },
  consistency: { label: "Consistency", hint: "The plan works if it runs. Delivery is the variable.", tone: "warn" },
  effort: { label: "Weekly time", hint: "The committed hours cannot reach this target at any level of consistency.", tone: "bad" },
  funding: { label: "Monthly money", hint: "The contribution rate does not fund the target. Discipline cannot close this.", tone: "bad" },
  time: { label: "Deadline", hint: "The runway is too short for the required pace.", tone: "bad" },
  target: { label: "The target itself", hint: "Out of reach on these constraints. Shrink it or change a constraint.", tone: "bad" },
  unknown: { label: "Unknown", hint: "Not enough evidence to say.", tone: "warn" },
};

export function bottleneckMeta(key: string) {
  return BOTTLENECK_COPY[key] ?? BOTTLENECK_COPY.unknown;
}

export const toneClasses: Record<"good" | "warn" | "bad", string> = {
  good: "border-emerald-300/25 bg-emerald-300/10 text-emerald-200",
  warn: "border-amber-300/25 bg-amber-300/10 text-amber-200",
  bad: "border-rose-300/25 bg-rose-300/10 text-rose-200",
};
