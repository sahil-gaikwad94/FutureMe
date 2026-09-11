/**
 * Today.
 *
 * The previous home page showed `progress = completed * 12` — nine check-ins and
 * you were at 100% regardless of plan size. Progress here is the plan's own
 * delivery rate, and the page leads with the single binding constraint rather
 * than a decorative score.
 */

import { PageHeader, Panel, PanelTitle, ProvenanceBadge } from "@/components/AppShell";
import { DomainBars, TrajectoryChart } from "@/components/charts/TrajectoryChart";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { bottleneckMeta, DOMAIN_META, percent, relativeDays, score, timeAgo, toneClasses } from "@/lib/format";
import { dueToday } from "@/lib/schedule";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Activity, AlertTriangle, ArrowRight, Check, Compass, Flame, LayoutDashboard, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import type { Domain } from "../../../server/engine/projection";

export default function Overview() {
  const workspace = trpc.workspace.get.useQuery();
  const data = workspace.data;
  const [notes, setNotes] = useState<Record<number, string>>({});

  const checkin = trpc.checkins.record.useMutation({
    onSuccess: result => {
      if (!result.saved) {
        toast.error("Could not save that check-in");
        return;
      }
      toast.success(result.updated ? "Today's check-in updated" : "Evidence recorded");
      workspace.refetch();
    },
    onError: () => toast.error("Sign in to record evidence"),
  });

  const snapshot = trpc.snapshots.save.useMutation({
    onSuccess: () => {
      toast.success("Trajectory snapshot saved");
      workspace.refetch();
    },
    onError: () => toast.error("Could not save a snapshot"),
  });

  if (workspace.isLoading) {
    return <div className="py-20 text-center text-sm text-white/35">Loading your workspace…</div>;
  }

  const goals = (data?.goals ?? []).filter((goal: any) => !goal.archived && goal.status !== "archived");
  const steps = (data?.habits ?? []).filter((habit: any) => !habit.archived);
  const checkins = (data?.checkins ?? []) as any[];
  const projection = data?.projection;
  const primary = goals[0];
  const today = dueToday(steps, checkins);

  const totalDelivered = checkins.filter((item: any) => item.completed).length;
  const expectedWindow = steps.reduce((sum: number, step: any) => sum + Math.round((Number(step.weeklyFrequency) * 28) / 7), 0);

  const constraint = primary
    ? projection?.scenarios?.realistic?.find((item: any) => item.domain === primary.domain)
    : undefined;
  const constraintMeta = bottleneckMeta(constraint?.bottleneck ?? "unknown");

  return (
    <>
      <PageHeader
        eyebrow="today"
        icon={LayoutDashboard}
        title={primary ? primary.title : "Nothing on the board yet"}
        description={
          primary
            ? `${DOMAIN_META[primary.domain as Domain].label} · ${relativeDays(primary.targetDate ? daysUntil(primary.targetDate) : null)} · ${primary.weeklyHours}h committed weekly`
            : "Create one goal and the projection, the plan and the mentor all start working from it."
        }
        action={
          <>
            <Link href="/app/plan">
              <Button variant="outline" size="sm" className="rounded-full border-white/12 text-white/70 hover:border-[#ffb18e]/50 hover:text-[#ffb18e]">
                <Plus size={14} /> New goal
              </Button>
            </Link>
            <Button
              size="sm"
              onClick={() => snapshot.mutate()}
              disabled={snapshot.isPending || !primary}
              className="rounded-full bg-[#ff9f7a] text-[#17101b] hover:bg-[#ffb18e]"
            >
              <Flame size={14} /> Snapshot
            </Button>
          </>
        }
      />

      {data?.isDemo && (
        <div className="mb-5 rounded-2xl border border-white/10 bg-white/[.03] p-4 text-xs leading-5 text-white/45">
          You are looking at a demo workspace. Nothing here is saved — sign in to keep a goal, check-ins and history.
        </div>
      )}

      {!primary ? (
        <Panel className="border-dashed">
          <div className="py-10 text-center">
            <Compass size={22} className="mx-auto text-[#ffb18e]/60" />
            <h2 className="mt-4 font-[family-name:var(--font-display)] text-2xl tracking-[-.04em]">Start with one real goal</h2>
            <p className="mx-auto mt-2.5 max-w-md text-sm leading-6 text-white/45">
              A specific outcome, a date, and an honest starting point. That is enough for the simulation to tell you
              whether it is reachable and what is in the way.
            </p>
            <Link href="/app/plan">
              <Button className="mt-6 rounded-full bg-[#ff9f7a] px-5 text-sm font-semibold text-[#17101b] hover:bg-[#ffb18e]">
                Create a goal <ArrowRight size={15} />
              </Button>
            </Link>
          </div>
        </Panel>
      ) : (
        <div className="space-y-5">
          {/* Headline metrics */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Composite trajectory"
              value={score(projection?.composite ?? 0)}
              suffix="/100"
              hint={`${percent(projection?.confidence ?? 0)} confidence`}
            />
            <Metric
              label="Chance of the target"
              value={percent(constraint?.probabilityOfTarget ?? 0)}
              hint={constraint ? `at flawless consistency: ${percent(constraint.probabilityAtFullAdherence)}` : "—"}
            />
            <Metric label="Consistency measured" value={percent(constraint?.adherenceUsed ?? 0)} hint={`${constraint?.evidenceCount ?? 0} check-ins`} />
            <Metric label="Actions delivered" value={`${totalDelivered}`} suffix={`/ ${expectedWindow}`} hint="against plan, 28 days" />
          </div>

          {/* Binding constraint */}
          <Panel className={cn("border", constraintMeta.tone === "good" ? "border-emerald-300/20" : constraintMeta.tone === "warn" ? "border-amber-300/20" : "border-rose-300/20")}>
            <div className="flex flex-wrap items-start gap-4">
              <div className={cn("rounded-2xl border p-3", toneClasses[constraintMeta.tone])}>
                {constraintMeta.tone === "good" ? <Check size={18} /> : <AlertTriangle size={18} />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] uppercase tracking-[.2em] text-white/35">Binding constraint</p>
                <h2 className="mt-1.5 text-xl font-semibold tracking-tight text-white">{constraintMeta.label}</h2>
                <p className="mt-1.5 max-w-2xl text-sm leading-6 text-white/50">{constraintMeta.hint}</p>
                {constraint && constraint.bottleneck === "consistency" && (
                  <p className="mt-2.5 text-xs text-white/45">
                    Even odds need {percent(constraint.requiredAdherence)} consistency. You are at {percent(constraint.adherenceUsed)} — a
                    gap of {Math.max(0, Math.round((constraint.requiredAdherence - constraint.adherenceUsed) * 100))} points.
                  </p>
                )}
                {constraint?.signal && <p className="mt-2 text-xs italic text-white/35">{constraint.signal}</p>}
              </div>
              <Link href="/app/observatory">
                <Button variant="ghost" size="sm" className="text-white/50 hover:text-white">
                  Explore <ArrowRight size={14} />
                </Button>
              </Link>
            </div>
          </Panel>

          <div className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
            {/* Today's actions */}
            <Panel>
              <PanelTitle icon={Activity} hint="Computed from each step's cadence and your last completion — not the whole plan at once.">
                Due today · {today.length}
              </PanelTitle>

              {today.length === 0 ? (
                <p className="rounded-2xl border border-white/[.07] bg-white/[.02] p-5 text-sm text-white/40">
                  {steps.length === 0 ? "This goal has no steps yet. Add one on the Plan page." : "Nothing is due. Either you are ahead, or every step is already logged for today."}
                </p>
              ) : (
                <div className="space-y-2.5">
                  {today.map(step => (
                    <div key={step.id} className="rounded-2xl border border-white/[.07] bg-white/[.02] p-3.5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm leading-5 text-white/85">{step.title}</p>
                          <p className="mt-1 text-[11px] text-white/35">
                            {step.weeklyFrequency}×/week · {step.minutesPerSession} min · consistency {percent(Number(step.adherencePrior) || 0)} ·
                            streak {step.currentStreak}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-1.5">
                          <button
                            onClick={() => checkin.mutate({ stepId: step.id, completed: true, checkinDate: new Date(), note: notes[step.id] })}
                            disabled={checkin.isPending}
                            className="rounded-full bg-[#8be3c3]/15 px-3 py-1.5 text-[11px] text-[#8be3c3] hover:bg-[#8be3c3]/25 disabled:opacity-50"
                          >
                            Done
                          </button>
                          <button
                            onClick={() => checkin.mutate({ stepId: step.id, completed: false, checkinDate: new Date(), note: notes[step.id] })}
                            disabled={checkin.isPending}
                            className="rounded-full border border-white/12 px-3 py-1.5 text-[11px] text-white/45 hover:border-white/25 hover:text-white/75 disabled:opacity-50"
                          >
                            Missed
                          </button>
                        </div>
                      </div>
                      <Textarea
                        value={notes[step.id] ?? ""}
                        onChange={event => setNotes(current => ({ ...current, [step.id]: event.target.value }))}
                        placeholder="What actually happened? One sentence is enough — this is what the mentor reads."
                        className="mt-2.5 min-h-10 resize-none border-white/[.07] bg-white/[.02] text-xs text-white/80 placeholder:text-white/25"
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-4 flex items-center justify-between border-t border-white/[.07] pt-4">
                <p className="text-[11px] text-white/30">Recording a miss is not a failure. Hiding one makes every projection wrong.</p>
                <Link href="/app/plan">
                  <Button variant="ghost" size="sm" className="text-white/45 hover:text-white">
                    All steps <ArrowRight size={13} />
                  </Button>
                </Link>
              </div>
            </Panel>

            <div className="space-y-5">
              <Panel>
                <PanelTitle icon={Sparkles} hint="Progress toward each goal's own target, and the simulated chance of reaching it.">
                  Domains
                </PanelTitle>
                {projection ? (
                  <DomainBars
                    domains={projection.scenarios.realistic.map((item: any) => ({
                      domain: item.domain,
                      score: item.score,
                      probabilityOfTarget: item.probabilityOfTarget,
                    }))}
                  />
                ) : (
                  <p className="text-sm text-white/35">No projection yet.</p>
                )}
              </Panel>

              {constraint && <Panel>
                <PanelTitle icon={Compass} hint="Median path with the 10th to 90th percentile band.">
                  {DOMAIN_META[primary.domain as Domain].short} trajectory
                </PanelTitle>
                <TrajectoryChart projection={constraint} height={190} />
              </Panel>}
            </div>
          </div>

          <RecentEvidence checkins={checkins} steps={steps} />
        </div>
      )}
    </>
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

function RecentEvidence({ checkins, steps }: { checkins: any[]; steps: any[] }) {
  const noted = checkins.filter((item: any) => item.note && item.note.trim()).slice(0, 6);
  return (
    <Panel>
      <PanelTitle icon={Activity} hint="Your own words. This is what the mentor quotes back at you.">
        Recent evidence
      </PanelTitle>
      {noted.length === 0 ? (
        <p className="text-sm text-white/35">
          Nothing written yet. When you check in, add one sentence about what happened — it is the difference between a
          plan that adapts and one that guesses.
        </p>
      ) : (
        <ul className="space-y-3">
          {noted.map((item: any) => (
            <li key={item.id} className="flex gap-3 text-xs leading-5">
              <span className="mt-0.5 shrink-0 font-mono text-[10px] text-white/25">{new Date(item.checkinDate).toLocaleDateString(undefined, { day: "2-digit", month: "short" })}</span>
              <span className="min-w-0 flex-1 text-white/60">
                <span className="text-white/30">{steps.find((step: any) => step.id === item.habitId)?.title ?? "a step"} · </span>
                “{item.note}”
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function daysUntil(date: Date | string): number {
  const target = typeof date === "string" ? new Date(date) : date;
  return Math.round((target.getTime() - Date.now()) / 86_400_000);
}
