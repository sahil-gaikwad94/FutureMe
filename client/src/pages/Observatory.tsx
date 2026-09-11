/**
 * Observatory.
 *
 * This page did not exist. The projection engine — the reason the product is
 * called an observatory — shipped with no visual surface and no callers.
 *
 * Three things live here: the five-year distribution per domain, a what-if lab
 * that re-simulates without writing anything, and a snapshot timeline that shows
 * whether the projection has actually improved as evidence accumulated.
 */

import { PageHeader, Panel, PanelTitle } from "@/components/AppShell";
import { AdherenceSweepChart, ScenarioCompareChart, SnapshotTimelineChart, TrajectoryChart } from "@/components/charts/TrajectoryChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { bottleneckMeta, DOMAIN_LIST, DOMAIN_META, domainValue, money, percent, score } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Bookmark, GitCompare, Layers, Save, Telescope } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { Domain } from "../../../server/engine/projection";

export default function Observatory() {
  const workspace = trpc.workspace.get.useQuery();
  const data = workspace.data;
  const projection = data?.projection;
  const goals = (data?.goals ?? []).filter((goal: any) => !goal.archived && goal.status !== "archived");

  const snapshots = trpc.snapshots.timeline.useQuery();
  const compare = trpc.scenarios.compare.useQuery();

  const createScenario = trpc.scenarios.create.useMutation({
    onSuccess: () => {
      toast.success("Scenario saved and snapshotted");
      compare.refetch();
      snapshots.refetch();
    },
    onError: () => toast.error("Could not save the scenario"),
  });
  const saveSnapshot = trpc.snapshots.save.useMutation({
    onSuccess: () => {
      toast.success("Snapshot saved");
      snapshots.refetch();
    },
    onError: () => toast.error("Could not save a snapshot"),
  });

  const [scenarioName, setScenarioName] = useState("");

  const domainsWithGoals = useMemo(
    () => (projection?.scenarios?.realistic ?? []).map((item: any) => item.domain as Domain),
    [projection],
  );
  const [active, setActive] = useState<Domain | null>(null);
  const activeDomain = active ?? domainsWithGoals[0] ?? "career";
  const activeProjection = (projection?.scenarios?.realistic ?? []).find((item: any) => item.domain === activeDomain);

  if (workspace.isLoading) return <div className="py-20 text-center text-sm text-white/35">Simulating your trajectory…</div>;

  return (
    <>
      <PageHeader
        eyebrow="observatory"
        icon={Telescope}
        title="Where this is heading"
        description="400 simulated futures per domain, sampled from a Beta posterior over your measured consistency. The band is the 10th to 90th percentile — eight of ten simulated outcomes land inside it."
        action={
          <Button size="sm" variant="outline" className="rounded-full border-white/12 text-white/70 hover:border-[#ffb18e]/50 hover:text-[#ffb18e]" onClick={() => saveSnapshot.mutate()} disabled={saveSnapshot.isPending}>
            <Save size={14} /> Snapshot now
          </Button>
        }
      />

      {!projection || domainsWithGoals.length === 0 ? (
        <Panel className="border-dashed">
          <p className="py-10 text-center text-sm text-white/40">
            No goals yet, so there is nothing to simulate. Create one on the Plan page and the projection appears here.
          </p>
        </Panel>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Composite" value={score(projection.composite)} suffix="/100" hint={`${percent(projection.confidence)} confidence`} />
            <Metric label="Horizon" value={`${projection.horizonYears}`} suffix="yrs" hint={`${projection.paths} paths per domain`} />
            <Metric label="Consistency" value={percent(projection.currentAdherence)} hint="measured, recency-weighted" />
            <Metric label="Model" value={projection.modelVersion} hint="seeded, reproducible" />
          </div>

          <Tabs value={activeDomain} onValueChange={value => setActive(value as Domain)} className="w-full">
            <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-2xl border border-white/[.07] bg-white/[.02] p-1">
              {domainsWithGoals.map(domain => (
                <TabsTrigger key={domain} value={domain} className="rounded-xl px-3.5 py-2 text-xs data-[state=active]:bg-white/[.08] data-[state=active]:text-white">
                  {DOMAIN_META[domain].label}
                </TabsTrigger>
              ))}
            </TabsList>

            {domainsWithGoals.map(domain => (
              <TabsContent key={domain} value={domain} className="mt-4">
                <DomainDetail
                  projection={(projection.scenarios.realistic as any[]).find(item => item.domain === domain)}
                  pessimistic={(projection.scenarios.pessimistic as any[]).find(item => item.domain === domain)}
                  optimistic={(projection.scenarios.optimistic as any[]).find(item => item.domain === domain)}
                  goal={goals.find((goal: any) => goal.domain === domain)}
                />
              </TabsContent>
            ))}
          </Tabs>

          <div className="grid gap-5 lg:grid-cols-2">
            <Panel>
              <PanelTitle icon={Bookmark} hint="A saved scenario is a snapshot of what you believed then, not a live recomputation.">
                Save this trajectory as a scenario
              </PanelTitle>
              <div className="flex gap-2">
                <Input
                  value={scenarioName}
                  onChange={event => setScenarioName(event.target.value)}
                  placeholder="e.g. Current pace, October baseline"
                  className="border-white/10 bg-white/[.03] text-sm text-white placeholder:text-white/25"
                />
                <Button
                  size="sm"
                  className="shrink-0 rounded-full bg-[#ff9f7a] text-[#17101b] hover:bg-[#ffb18e]"
                  disabled={createScenario.isPending || scenarioName.trim().length < 2}
                  onClick={() => createScenario.mutate({ name: scenarioName.trim(), adherenceOverride: Math.min(1, Math.max(0.05, projection.currentAdherence)) })}
                >
                  Save
                </Button>
              </div>
            </Panel>

            <Panel>
              <PanelTitle icon={Layers} hint="Has the projection moved as evidence accumulated? This is the only real validation the model gets.">
                Trajectory over time
              </PanelTitle>
              {snapshots.data?.points && snapshots.data.points.length > 1 ? (
                <SnapshotTimelineChart points={snapshots.data.points} />
              ) : (
                <p className="text-xs leading-5 text-white/35">
                  {snapshots.data?.points?.length === 1
                    ? "One snapshot so far. Take another in a week or two and the trend line appears."
                    : "No snapshots yet. Take one now and another after a fortnight of check-ins to see whether the projection actually moved."}
                </p>
              )}
            </Panel>
          </div>

          {compare.data?.scenarios && compare.data.scenarios.length > 0 && (
            <Panel>
              <PanelTitle icon={GitCompare} hint="Saved scenarios against the live projection, on the same attainment scale.">
                Scenario comparison
              </PanelTitle>
              <ScenarioCompareChart live={compare.data.live} scenarios={compare.data.scenarios} />
            </Panel>
          )}

          <WhatIfLab defaultDomain={activeDomain} />
        </div>
      )}
    </>
  );
}

function DomainDetail({ projection, pessimistic, optimistic, goal }: { projection: any; pessimistic: any; optimistic: any; goal: any }) {
  if (!projection) return null;
  const meta = DOMAIN_META[projection.domain as Domain];
  const constraint = bottleneckMeta(projection.bottleneck);

  return (
    <div className="space-y-5">
      <Panel>
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="font-[family-name:var(--font-display)] text-2xl tracking-[-.04em] text-white">{meta.label}</h3>
            {goal && <p className="mt-1.5 text-sm text-white/45">{goal.title}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn("border", constraint.tone === "good" ? "border-emerald-300/25 bg-emerald-300/[.07] text-emerald-200" : constraint.tone === "warn" ? "border-amber-300/25 bg-amber-300/[.07] text-amber-200" : "border-rose-300/25 bg-rose-300/[.07] text-rose-200")}>
              {constraint.label}
            </Badge>
            <Badge variant="outline" className="border-white/12 bg-white/[.03] text-white/55">
              {percent(projection.probabilityOfTarget)} to target
            </Badge>
          </div>
        </div>

        <TrajectoryChart projection={projection} height={250} />

        <div className="mt-5 grid gap-3 border-t border-white/[.07] pt-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Now" value={domainValue(projection.domain, projection.points[0].raw)} hint={`${score(projection.points[0].value)}/100 attainment`} />
          <Stat label="Pessimistic" value={score(pessimistic?.score ?? 0)} suffix="/100" hint="10th percentile" />
          <Stat label="Realistic" value={score(projection.score)} suffix="/100" hint="median path" />
          <Stat label="Optimistic" value={score(optimistic?.score ?? 0)} suffix="/100" hint="90th percentile" />
        </div>

        <div className="mt-5 grid gap-3 border-t border-white/[.07] pt-5 sm:grid-cols-3">
          <Stat label="Chance of the target" value={percent(projection.probabilityOfTarget)} hint={`judged at year ${projection.evaluatedAtYear}`} />
          <Stat label="At flawless consistency" value={percent(projection.probabilityAtFullAdherence)} hint={projection.feasible ? "reachable by consistency alone" : "not reachable by consistency alone"} />
          <Stat label="Consistency for even odds" value={projection.feasible ? percent(projection.requiredAdherence) : "—"} hint={projection.evidenceCount === 0 ? "no check-in evidence yet" : `${projection.evidenceCount} check-ins`} />
        </div>

        {typeof projection.requiredMonthlyContribution === "number" && projection.requiredMonthlyContribution > 0 && (
          <p className="mt-4 rounded-2xl border border-white/[.07] bg-white/[.02] p-3.5 text-xs leading-5 text-white/50">
            Funding this target needs about <span className="font-mono text-white/80">{money(projection.requiredMonthlyContribution)}/month</span> over the
            runway. Below that, the gap is arithmetic rather than behavioural.
          </p>
        )}

        <div className="mt-4">
          <p className="text-[10px] uppercase tracking-[.18em] text-white/30">Assumptions this projection rests on</p>
          <ul className="mt-2.5 space-y-1.5">
            {projection.assumptions.map((assumption: string, index: number) => (
              <li key={index} className="flex gap-2 text-xs leading-5 text-white/45">
                <span className="text-[#ffb18e]/50">·</span>
                {assumption}
              </li>
            ))}
          </ul>
        </div>
      </Panel>
    </div>
  );
}

function WhatIfLab({ defaultDomain }: { defaultDomain: Domain }) {
  const workspace = trpc.workspace.get.useQuery();
  const goals = (workspace.data?.goals ?? []).filter((goal: any) => !goal.archived && goal.status !== "archived");

  const [domain, setDomain] = useState<Domain>(defaultDomain);
  const goal = goals.find((item: any) => item.domain === domain);
  const [baseline, setBaseline] = useState<number>(0);
  const [target, setTarget] = useState<number>(0);
  const [weeklyHours, setWeeklyHours] = useState(6);
  const [frequency, setFrequency] = useState(3);
  const [adherence, setAdherence] = useState(0.7);
  const [horizonYears, setHorizonYears] = useState(5);
  const [monthlyContribution, setMonthlyContribution] = useState(300);
  const [seeded, setSeeded] = useState(false);

  // Seed the lab from the real goal the first time one is available, so the
  // starting point is the user's actual plan rather than arbitrary defaults.
  if (!seeded && goal) {
    setSeeded(true);
    setBaseline(Number(goal.baseline));
    setTarget(Number(goal.target));
    setWeeklyHours(Number(goal.weeklyHours) || 6);
    setHorizonYears(Number(workspace.data?.projection?.horizonYears) || 5);
    const details = (goal.details ?? {}) as Record<string, any>;
    if (typeof details.monthlyContribution === "number") setMonthlyContribution(details.monthlyContribution);
  }

  const whatIf = trpc.projection.whatIf.useQuery(
    { domain, baseline, target: target || 1, weeklyHours, frequency, adherence, horizonYears, monthlyContribution: domain === "finance" ? monthlyContribution : undefined },
    { enabled: target > 0 },
  );
  const sweep = trpc.projection.adherenceSweep.useQuery(
    { domain, baseline, target: target || 1, weeklyHours, frequency, horizonYears, monthlyContribution: domain === "finance" ? monthlyContribution : undefined },
    { enabled: target > 0 },
  );

  const projected = whatIf.data?.projected;

  return (
    <Panel>
      <PanelTitle icon={Telescope} hint="Nothing here is written. Change anything and the simulation re-runs against your real numbers.">
        What-if lab
      </PanelTitle>

      <div className="grid gap-6 lg:grid-cols-[290px_1fr]">
        <div className="space-y-4">
          <div>
            <span className="field-label">Domain</span>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              {DOMAIN_LIST.map(item => (
                <button
                  key={item}
                  onClick={() => {
                    setDomain(item);
                    setSeeded(false);
                  }}
                  className={cn("rounded-xl border px-3 py-2 text-xs", domain === item ? "border-[#ffb18e]/50 bg-[#ff9f7a]/10 text-[#ffb18e]" : "border-white/10 text-white/45 hover:text-white/80")}
                >
                  {DOMAIN_META[item].short}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="field-label">Baseline</span>
              <Input type="number" value={baseline} onChange={event => setBaseline(Number(event.target.value))} className="mt-1.5 border-white/10 bg-white/[.03] text-sm text-white" />
            </label>
            <label>
              <span className="field-label">Target</span>
              <Input type="number" value={target} onChange={event => setTarget(Number(event.target.value))} className="mt-1.5 border-white/10 bg-white/[.03] text-sm text-white" />
            </label>
          </div>

          <Slider label="Hours per week" value={weeklyHours} min={0} max={24} step={0.5} onChange={setWeeklyHours} format={value => `${value}h`} />
          <Slider label="Sessions per week" value={frequency} min={0.5} max={14} step={0.5} onChange={setFrequency} format={value => `${value}×`} />
          <Slider label="Consistency" value={adherence} min={0.1} max={1} step={0.05} onChange={setAdherence} format={value => percent(value)} />
          <Slider label="Horizon" value={horizonYears} min={1} max={20} step={1} onChange={setHorizonYears} format={value => `${value}y`} />
          {domain === "finance" && <Slider label="Monthly contribution" value={monthlyContribution} min={0} max={3000} step={25} onChange={setMonthlyContribution} format={value => money(value)} />}
        </div>

        <div className="min-w-0 space-y-6">
          {target <= 0 ? (
            <p className="py-16 text-center text-sm text-white/35">Set a target above zero to simulate.</p>
          ) : projected ? (
            <>
              <TrajectoryChart projection={projected} height={220} />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Chance of target" value={percent(projected.probabilityOfTarget)} />
                <Stat label="Flawless consistency" value={percent(projected.probabilityAtFullAdherence)} />
                <Stat label="Even odds need" value={projected.feasible ? percent(projected.requiredAdherence) : "—"} />
                <Stat label="Binding constraint" value={bottleneckMeta(projected.bottleneck).label} />
              </div>
              {sweep.data && <AdherenceSweepChart points={sweep.data.points} current={adherence} />}
              {typeof whatIf.data?.requiredMonthlyContribution === "number" && whatIf.data.requiredMonthlyContribution > 0 && (
                <p className="rounded-2xl border border-white/[.07] bg-white/[.02] p-3.5 text-xs leading-5 text-white/50">
                  At this target and horizon the required contribution is{" "}
                  <span className="font-mono text-white/80">{money(whatIf.data.requiredMonthlyContribution)}/month</span>. You are modelling{" "}
                  <span className="font-mono text-white/80">{money(monthlyContribution)}/month</span> —{" "}
                  {monthlyContribution >= whatIf.data.requiredMonthlyContribution ? "funded" : `a shortfall of ${money(whatIf.data.requiredMonthlyContribution - monthlyContribution)}`}.
                </p>
              )}
            </>
          ) : (
            <p className="py-16 text-center text-sm text-white/35">Simulating…</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; format: (value: number) => string }) {
  return (
    <label className="block">
      <span className="field-label">
        {label} — <span className="font-mono text-white/70">{format(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} className="mt-2.5 w-full accent-[#ff9f7a]" />
    </label>
  );
}

function Metric({ label, value, suffix, hint }: { label: string; value: string; suffix?: string; hint?: string }) {
  return (
    <div className="rounded-[22px] border border-white/[.08] bg-[#11152a]/70 p-4">
      <p className="text-[10px] uppercase tracking-[.16em] text-white/35">{label}</p>
      <p className="mt-2 font-[family-name:var(--font-display)] text-3xl tracking-[-.05em] text-white">
        {value}
        {suffix && <span className="ml-1 text-base text-white/25">{suffix}</span>}
      </p>
      {hint && <p className="mt-1 text-[11px] text-white/30">{hint}</p>}
    </div>
  );
}

function Stat({ label, value, suffix, hint }: { label: string; value: string; suffix?: string; hint?: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[.16em] text-white/30">{label}</p>
      <p className="mt-1 font-mono text-lg text-white/90">
        {value}
        {suffix && <span className="ml-0.5 text-xs text-white/35">{suffix}</span>}
      </p>
      {hint && <p className="mt-0.5 text-[11px] leading-4 text-white/30">{hint}</p>}
    </div>
  );
}
