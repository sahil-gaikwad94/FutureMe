/**
 * Landing.
 *
 * Signed-out visitors get the premise, an honest account of how the projection
 * works, and a working demo projection they can drive without an account —
 * which is the fastest way to show that the model is a simulation and not a
 * fortune cookie. Signed-in visitors are sent to the app.
 */

import { startLogin } from "@/const";
import { Panel, PanelTitle } from "@/components/AppShell";
import { AdherenceSweepChart, TrajectoryChart } from "@/components/charts/TrajectoryChart";
import { Button } from "@/components/ui/button";
import { DOMAIN_LIST, DOMAIN_META, percent } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { ArrowRight, Compass, Orbit, ShieldCheck, Telescope } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import type { Domain } from "../../../server/engine/projection";

export default function Landing() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();
  const [domain, setDomain] = useState<Domain>("career");
  const [weeklyHours, setWeeklyHours] = useState(6);
  const [adherence, setWeeklyAdherence] = useState(0.7);

  useEffect(() => {
    if (user) setLocation("/app");
  }, [user, setLocation]);

  const whatIf = trpc.projection.whatIf.useQuery({
    domain,
    baseline: domain === "finance" ? 2000 : 35,
    target: domain === "finance" ? 40000 : 90,
    weeklyHours,
    frequency: domain === "health" ? 4 : domain === "relationships" ? 2 : 3,
    adherence,
    horizonYears: 5,
    monthlyContribution: domain === "finance" ? 400 : undefined,
  });

  const sweep = trpc.projection.adherenceSweep.useQuery({
    domain,
    baseline: domain === "finance" ? 2000 : 35,
    target: domain === "finance" ? 40000 : 90,
    weeklyHours,
    frequency: domain === "health" ? 4 : domain === "relationships" ? 2 : 3,
    horizonYears: 5,
    monthlyContribution: domain === "finance" ? 400 : undefined,
  });

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-[#080a16] text-sm text-white/40">Loading…</div>;
  }

  const projected = whatIf.data?.projected;

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#080a16] text-white">
      <div className="pointer-events-none fixed inset-0 -z-0 opacity-70">
        <div className="absolute left-[6%] top-[-12%] h-[480px] w-[480px] rounded-full bg-[#5f6eff]/10 blur-[130px]" />
        <div className="absolute right-[-8%] top-[35%] h-[520px] w-[520px] rounded-full bg-[#ff9f7a]/[.07] blur-[150px]" />
      </div>

      <header className="relative z-20 border-b border-white/[.07] bg-[#080a16]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-[70px] max-w-6xl items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-3">
            <div className="relative flex h-9 w-9 items-center justify-center rounded-2xl border border-[#ffb18e]/40 bg-[#ff9f7a]/10">
              <Orbit size={19} className="text-[#ffb18e]" />
              <span className="absolute h-1.5 w-1.5 rounded-full bg-[#ffcfb8] shadow-[0_0_12px_#ff9f7a]" />
            </div>
            <span className="font-[family-name:var(--font-display)] text-lg tracking-[-.03em]">futureme</span>
          </div>
          <Button onClick={() => startLogin()} size="sm" className="rounded-full bg-[#ff9f7a] px-4 text-xs text-[#17101b] hover:bg-[#ffb18e]">
            Sign in with Google
          </Button>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-6xl space-y-10 px-5 py-12 sm:px-8 lg:py-16">
        <section className="max-w-3xl">
          <p className="flex items-center gap-2 text-[10px] uppercase tracking-[.22em] text-[#ffb18e]">
            <Telescope size={13} /> a private observatory
          </p>
          <h1 className="mt-5 font-[family-name:var(--font-display)] text-4xl leading-[1.02] tracking-[-.055em] sm:text-6xl">
            See where you are <em className="text-[#ffb18e]">actually</em> heading.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-white/55">
            FutureMe turns one real goal and the check-ins you actually do into a five-year simulation — with the
            uncertainty shown, not hidden. Then it tells you what is blocking it: consistency, hours, money, or the
            target itself.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button onClick={() => startLogin()} className="rounded-full bg-[#ff9f7a] px-6 text-sm font-semibold text-[#17101b] hover:bg-[#ffb18e]">
              Start with one goal <ArrowRight size={16} />
            </Button>
            <a href="#try" className="rounded-full border border-white/12 px-5 py-2.5 text-sm text-white/60 hover:border-[#ffb18e]/50 hover:text-[#ffb18e]">
              Try the simulation
            </a>
          </div>
        </section>

        <section id="try" className="scroll-mt-24">
          <Panel>
            <PanelTitle icon={Compass} hint="No account needed. This is the same engine the app runs, on the same assumptions.">
              Drive the projection yourself
            </PanelTitle>

            <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
              <div className="space-y-5">
                <div>
                  <span className="field-label">Domain</span>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    {DOMAIN_LIST.map(item => (
                      <button
                        key={item}
                        onClick={() => setDomain(item)}
                        className={`rounded-xl border px-3 py-2 text-xs transition-colors ${
                          domain === item ? "border-[#ffb18e]/50 bg-[#ff9f7a]/10 text-[#ffb18e]" : "border-white/10 text-white/45 hover:text-white/80"
                        }`}
                      >
                        {DOMAIN_META[item].short}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="block">
                  <span className="field-label">Hours per week — {weeklyHours}h</span>
                  <input type="range" min={0} max={20} step={1} value={weeklyHours} onChange={event => setWeeklyHours(Number(event.target.value))} className="mt-3 w-full accent-[#ff9f7a]" />
                </label>

                <label className="block">
                  <span className="field-label">Consistency — {percent(adherence)}</span>
                  <input type="range" min={0.1} max={1} step={0.05} value={adherence} onChange={event => setWeeklyAdherence(Number(event.target.value))} className="mt-3 w-full accent-[#ff9f7a]" />
                </label>

                {projected && (
                  <div className="space-y-2 rounded-2xl border border-white/[.07] bg-white/[.02] p-4 text-xs">
                    <Row label="Chance of hitting the target" value={percent(projected.probabilityOfTarget)} />
                    <Row label="At flawless consistency" value={percent(projected.probabilityAtFullAdherence)} />
                    <Row label="Consistency for even odds" value={percent(projected.requiredAdherence)} />
                    <Row label="Binding constraint" value={projected.bottleneck} />
                    {typeof projected.requiredMonthlyContribution === "number" && <Row label="Contribution needed" value={`$${Math.round(projected.requiredMonthlyContribution)}/mo`} />}
                  </div>
                )}
              </div>

              <div className="min-w-0 space-y-6">
                {projected ? (
                  <>
                    <div>
                      <p className="mb-2 text-[10px] uppercase tracking-[.18em] text-white/35">Attainment over five years · 10th to 90th percentile</p>
                      <TrajectoryChart projection={projected} />
                    </div>
                    <div>
                      <p className="mb-2 text-[10px] uppercase tracking-[.18em] text-white/35">What more consistency would be worth</p>
                      {sweep.data && <AdherenceSweepChart points={sweep.data.points} current={adherence} />}
                    </div>
                  </>
                ) : (
                  <div className="flex h-[420px] items-center justify-center text-sm text-white/30">Simulating…</div>
                )}
              </div>
            </div>

            {projected && (
              <div className="mt-6 rounded-2xl border border-white/[.07] bg-white/[.02] p-4">
                <p className="text-[10px] uppercase tracking-[.18em] text-white/35">Assumptions this run is built on</p>
                <ul className="mt-2.5 space-y-1.5">
                  {projected.assumptions.map((assumption, index) => (
                    <li key={index} className="flex gap-2 text-xs leading-5 text-white/45">
                      <span className="text-[#ffb18e]/60">·</span>
                      {assumption}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>
        </section>

        <section className="grid gap-5 md:grid-cols-3">
          {[
            {
              icon: Telescope,
              title: "A real simulation",
              body: "400 seeded futures per domain, sampled from a Beta posterior over your consistency. Bands are the 10th to 90th percentile — not decoration around a single guess.",
            },
            {
              icon: Compass,
              title: "It names the blocker",
              body: "The engine re-runs with one lever relaxed at a time to find what is actually binding: consistency, weekly hours, monthly money, the deadline, or the target.",
            },
            {
              icon: ShieldCheck,
              title: "Nothing is invented",
              body: "Agents are given a numbered fact sheet of computed values and told to cite it. When no model is reachable, the reply is built from your numbers and says so.",
            },
          ].map(item => (
            <Panel key={item.title}>
              <item.icon size={18} className="text-[#ffb18e]" />
              <h3 className="mt-3.5 text-base font-semibold tracking-tight text-white">{item.title}</h3>
              <p className="mt-2 text-xs leading-6 text-white/45">{item.body}</p>
            </Panel>
          ))}
        </section>

        <footer className="border-t border-white/[.07] pt-6 text-[10px] uppercase tracking-[.16em] text-white/25">
          <p>futureme · projections are scenario models, not forecasts. Finance and health figures are illustrative, not advice.</p>
        </footer>
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-white/40">{label}</span>
      <span className="font-mono text-white/85">{value}</span>
    </div>
  );
}
