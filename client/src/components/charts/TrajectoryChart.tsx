/**
 * Trajectory charts.
 *
 * The projection engine existed from the first commit and was never drawn — the
 * whole "five-year observatory" premise had no visual surface. These render the
 * simulated distribution rather than a single line, because the honest thing to
 * show about a five-year projection is how wide the uncertainty actually is.
 */

import { useMemo } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Domain, DomainProjection } from "../../../../server/engine/projection";
import { DOMAIN_META, domainValue, money, percent } from "../../lib/format";

const axisStyle = { fontSize: 11, fill: "rgba(255,255,255,.4)" };
const gridStroke = "rgba(255,255,255,.07)";

function tooltipShell({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-[#0b0e1d]/95 px-3 py-2 text-xs shadow-2xl backdrop-blur">
      <p className="mb-1.5 font-medium text-white/80">{label}</p>
      {payload.map((entry: any, index: number) => (
        <p key={index} className="flex items-center gap-2 text-white/60">
          <span className="h-2 w-2 rounded-full" style={{ background: entry.color ?? entry.fill }} />
          <span>{entry.name}</span>
          <span className="ml-auto font-mono text-white/85">{formatter ? formatter(entry.value, entry) : entry.value}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * Five-year band chart for one domain.
 *
 * Draws the 10th–90th percentile as a filled band with the median through the
 * middle, so the reader sees the spread and not just a prediction. The target
 * line is drawn at 100 because every domain is plotted as attainment — progress
 * toward its own target — which is what makes four different units comparable.
 */
export function TrajectoryChart({ projection, height = 220 }: { projection: DomainProjection; height?: number }) {
  const meta = DOMAIN_META[projection.domain];
  const data = useMemo(
    () =>
      projection.points.map(point => ({
        year: point.year === 0 ? "Now" : `Y${point.year}`,
        median: Number(point.value.toFixed(1)),
        low: Number(point.low.toFixed(1)),
        high: Number(point.high.toFixed(1)),
        band: [Number(point.low.toFixed(1)), Number(point.high.toFixed(1))],
        raw: point.raw,
        rawLow: point.rawLow,
        rawHigh: point.rawHigh,
      })),
    [projection],
  );

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
        <defs>
          <linearGradient id={`band-${projection.domain}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={meta.color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={meta.color} stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={gridStroke} vertical={false} />
        <XAxis dataKey="year" tick={axisStyle} axisLine={false} tickLine={false} />
        <YAxis domain={[0, 100]} tick={axisStyle} axisLine={false} tickLine={false} width={44} />
        <Tooltip
          content={
            <TooltipFormatter
              formatter={(value: number, entry: any) =>
                entry?.dataKey === "median" && projection.domain === "finance"
                  ? money(entry.payload.raw)
                  : `${value.toFixed(0)}%`
              }
            />
          }
        />
        <ReferenceLine y={100} stroke="rgba(255,255,255,.28)" strokeDasharray="4 4" label={{ value: "target", position: "right", fill: "rgba(255,255,255,.4)", fontSize: 10 }} />
        <Area type="monotone" dataKey="band" stroke="none" fill={`url(#band-${projection.domain})`} name="10th–90th percentile" isAnimationActive={false} />
        <Line type="monotone" dataKey="median" stroke={meta.color} strokeWidth={2} dot={{ r: 2.5, fill: meta.color, strokeWidth: 0 }} name="Median path" isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function TooltipFormatter(props: any) {
  return tooltipShell(props);
}

/**
 * Probability of reaching the target as consistency varies.
 *
 * This is the chart that makes the model actionable: it shows the user where on
 * the consistency curve they currently sit and what moving up it is worth.
 */
export function AdherenceSweepChart({
  points,
  current,
  height = 200,
}: {
  points: Array<{ adherence: number; probabilityOfTarget: number; attainment: number }>;
  current: number;
  height?: number;
}) {
  const data = points.map(point => ({
    adherence: `${Math.round(point.adherence * 100)}%`,
    probability: Number((point.probabilityOfTarget * 100).toFixed(0)),
    attainment: Number(point.attainment.toFixed(0)),
    raw: point.adherence,
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
        <CartesianGrid stroke={gridStroke} vertical={false} />
        <XAxis dataKey="adherence" tick={axisStyle} axisLine={false} tickLine={false} />
        <YAxis domain={[0, 100]} tick={axisStyle} axisLine={false} tickLine={false} width={44} unit="%" />
        <Tooltip content={<TooltipFormatter formatter={(value: number) => `${value}%`} />} />
        <ReferenceLine y={50} stroke="rgba(255,255,255,.2)" strokeDasharray="4 4" />
        <ReferenceLine
          x={`${Math.round(current * 100)}%`}
          stroke="var(--chart-1)"
          strokeDasharray="3 3"
          label={{ value: "you", position: "top", fill: "var(--chart-1)", fontSize: 10 }}
        />
        <Bar dataKey="probability" name="Chance of hitting the target" radius={[4, 4, 0, 0]} isAnimationActive={false}>
          {data.map((entry, index) => (
            <Cell key={index} fill={entry.probability >= 50 ? "var(--chart-2)" : entry.probability >= 25 ? "var(--chart-1)" : "var(--destructive)"} fillOpacity={0.75} />
          ))}
        </Bar>
        <Line type="monotone" dataKey="attainment" name="Projected attainment" stroke="var(--chart-3)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Composite trajectory over time, from saved snapshots. */
export function SnapshotTimelineChart({ points, height = 180 }: { points: Array<{ at: Date | string; composite: number; adherence: number }>; height?: number }) {
  const data = points.map(point => ({
    at: new Date(point.at).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
    composite: Number(point.composite.toFixed(1)),
    adherence: Number((point.adherence * 100).toFixed(0)),
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
        <CartesianGrid stroke={gridStroke} vertical={false} />
        <XAxis dataKey="at" tick={axisStyle} axisLine={false} tickLine={false} />
        <YAxis domain={[0, 100]} tick={axisStyle} axisLine={false} tickLine={false} width={44} />
        <Tooltip content={<TooltipFormatter />} />
        <Line type="monotone" dataKey="composite" name="Composite trajectory" stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
        <Line type="monotone" dataKey="adherence" name="Measured consistency" stroke="var(--chart-2)" strokeWidth={2} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Side-by-side scenario comparison. */
export function ScenarioCompareChart({
  live,
  scenarios,
  height = 220,
}: {
  live: { composite: number; domains: Array<{ domain: Domain; score: number; probabilityOfTarget: number }> };
  scenarios: Array<{ id: number; name: string; adherenceOverride: number | null; composite: number; domains: Array<{ domain: Domain; score: number; probabilityOfTarget: number }> }>;
  height?: number;
}) {
  const data = useMemo(() => {
    const domains = live.domains.map(item => item.domain);
    return domains.map(domain => {
      const row: Record<string, any> = {
        domain: DOMAIN_META[domain].short,
        Now: Number((live.domains.find(item => item.domain === domain)?.score ?? 0).toFixed(0)),
      };
      for (const scenario of scenarios) {
        row[scenario.name] = Number((scenario.domains.find(item => item.domain === domain)?.score ?? 0).toFixed(0));
      }
      return row;
    });
  }, [live, scenarios]);

  const palette = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
  const keys = ["Now", ...scenarios.map(scenario => scenario.name)];

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
        <CartesianGrid stroke={gridStroke} vertical={false} />
        <XAxis dataKey="domain" tick={axisStyle} axisLine={false} tickLine={false} />
        <YAxis domain={[0, 100]} tick={axisStyle} axisLine={false} tickLine={false} width={44} />
        <Tooltip content={<TooltipFormatter formatter={(value: number) => `${value}`} />} cursor={{ fill: "rgba(255,255,255,.04)" }} />
        {keys.map((key, index) => (
          <Bar key={key} dataKey={key} fill={palette[index % palette.length]} fillOpacity={index === 0 ? 0.95 : 0.55} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Compact radial-style breakdown of attainment across domains. */
export function DomainBars({ domains }: { domains: Array<{ domain: Domain; score: number; probabilityOfTarget: number }> }) {
  return (
    <div className="space-y-3">
      {domains.map(item => {
        const meta = DOMAIN_META[item.domain];
        return (
          <div key={item.domain}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="text-xs text-white/60">{meta.label}</span>
              <span className="font-mono text-xs text-white/80">
                {item.score.toFixed(0)}
                <span className="ml-2 text-white/40">{percent(item.probabilityOfTarget)}</span>
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[.07]">
              <div className="h-full rounded-full" style={{ width: `${Math.max(2, item.score)}%`, background: meta.color, opacity: 0.85 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
