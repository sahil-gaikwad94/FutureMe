/**
 * Weekly review.
 *
 * Nothing closed the loop before: check-ins accumulated and the plan never
 * changed in response. A step could sit dead for six months and still be shown
 * as step three of five.
 *
 * The review agent reads the evidence window, computes the metrics itself, and
 * proposes plan edits. Applying them is explicit and shown as a diff — the agent
 * never silently rewrites the user's plan.
 */

import { PageHeader, Panel, PanelTitle, ProvenanceBadge } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { percent, timeAgo } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { Check, ClipboardCheck, Minus, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function ReviewPage() {
  const [windowDays, setWindowDays] = useState(14);
  const [applyPlan, setApplyPlan] = useState(false);
  const workspace = trpc.workspace.get.useQuery();
  const reviews = trpc.agents.reviews.useQuery();

  const generate = trpc.agents.review.useMutation({
    onSuccess: result => {
      toast.success(result.source === "model" ? "Review generated" : "Review computed from your check-ins");
      reviews.refetch();
      workspace.refetch();
    },
    onError: error => toast.error(error.message || "Could not generate the review"),
  });

  const latest = generate.data;
  const hasEvidence = (workspace.data?.checkins ?? []).length > 0;

  return (
    <>
      <PageHeader
        eyebrow="review"
        icon={ClipboardCheck}
        title="What actually happened"
        description="The review is judged against the evidence, not the intention. Metrics are computed and stored alongside the narrative, so a summary can always be checked against the numbers that produced it."
        action={
          <Button size="sm" className="rounded-full bg-[#ff9f7a] text-[#17101b] hover:bg-[#ffb18e]" onClick={() => generate.mutate({ windowDays, applyPlan })} disabled={generate.isPending}>
            {generate.isPending ? <RefreshCw size={14} className="animate-spin" /> : <ClipboardCheck size={14} />} Run review
          </Button>
        }
      />

      {!hasEvidence && (
        <Panel className="mb-5 border-amber-300/20 bg-amber-300/[.04]">
          <p className="text-sm leading-6 text-amber-100/70">
            No check-ins recorded yet, so this review can only describe an empty window. Log a few sessions first — the
            assessment is only as good as the record.
          </p>
        </Panel>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="space-y-5">
          {latest ? (
            <>
              <Panel>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[10px] uppercase tracking-[.2em] text-white/35">Assessment · last {windowDays} days</p>
                  <ProvenanceBadge source={latest.source} model={latest.model} degradedReason={latest.degradedReason} />
                </div>
                <p className="text-sm leading-7 text-white/75">{latest.review.summary}</p>
                {latest.degradedReason && <p className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-3 text-[11px] leading-5 text-amber-100/70">{latest.degradedReason}</p>}
              </Panel>

              <div className="grid gap-5 md:grid-cols-2">
                <Panel>
                  <PanelTitle icon={Check}>What worked</PanelTitle>
                  {latest.review.wins.length === 0 ? (
                    <p className="text-sm text-white/35">Nothing cleared the bar this window. That is a finding, not an oversight.</p>
                  ) : (
                    <ul className="space-y-2.5">
                      {latest.review.wins.map((win, index) => (
                        <li key={index} className="flex gap-2.5 text-xs leading-5 text-white/60">
                          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#8be3c3]" />
                          {win}
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>

                <Panel>
                  <PanelTitle icon={Minus}>What stalled</PanelTitle>
                  {latest.review.stalls.length === 0 ? (
                    <p className="text-sm text-white/35">No step has gone quiet past its own cadence.</p>
                  ) : (
                    <ul className="space-y-2.5">
                      {latest.review.stalls.map((stall, index) => (
                        <li key={index} className="flex gap-2.5 text-xs leading-5 text-white/60">
                          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-300/70" />
                          {stall}
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              </div>

              <Panel>
                <PanelTitle icon={Plus} hint="Each of these fits inside your committed weekly hours.">
                  What to change
                </PanelTitle>
                <ul className="space-y-2.5">
                  {latest.review.changes.map((change, index) => (
                    <li key={index} className="rounded-2xl border border-white/[.07] bg-white/[.02] p-3.5 text-xs leading-5 text-white/65">
                      {change}
                    </li>
                  ))}
                </ul>

                <div className="mt-5 border-t border-white/[.07] pt-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-[10px] uppercase tracking-[.2em] text-white/35">Revised plan · {latest.review.nextActions.length} steps</p>
                    <label className="flex items-center gap-2.5 text-xs text-white/50">
                      <Switch checked={applyPlan} onCheckedChange={setApplyPlan} />
                      Apply to my plan when I run the review
                    </label>
                  </div>
                  <ul className="mt-3 space-y-2">
                    {latest.review.nextActions.map((action, index) => (
                      <li key={index} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[.07] bg-white/[.02] px-3.5 py-2.5">
                        <span className="min-w-0 flex-1 text-xs text-white/70">{action.title}</span>
                        <span className="shrink-0 font-mono text-[10px] text-white/35">
                          {action.weeklyFrequency}×/wk · {action.minutesPerSession}m
                        </span>
                      </li>
                    ))}
                  </ul>
                  {latest.applied && (
                    <p className="mt-3 text-[11px] leading-4 text-white/40">
                      Applied: {latest.applied.retired.length} step{latest.applied.retired.length === 1 ? "" : "s"} retired,{" "}
                      {latest.applied.created.length} added.
                    </p>
                  )}
                </div>
              </Panel>
            </>
          ) : (
            <Panel className="border-dashed">
              <p className="py-12 text-center text-sm text-white/40">No review yet. Run one to see what the last {windowDays} days of evidence say.</p>
            </Panel>
          )}
        </div>

        <div className="space-y-5">
          <Panel>
            <PanelTitle>Window</PanelTitle>
            <div className="flex gap-1.5">
              {[7, 14, 30].map(days => (
                <button
                  key={days}
                  onClick={() => setWindowDays(days)}
                  className={`flex-1 rounded-xl border px-3 py-2 text-xs ${windowDays === days ? "border-[#ffb18e]/50 bg-[#ff9f7a]/10 text-[#ffb18e]" : "border-white/10 text-white/45 hover:text-white/80"}`}
                >
                  {days}d
                </button>
              ))}
            </div>
          </Panel>

          {latest?.metrics && (
            <Panel>
              <PanelTitle hint="Computed, not asked for. Stored with the review so the narrative can be audited.">Metrics</PanelTitle>
              <div className="space-y-1.5">
                {Object.entries(latest.metrics).map(([key, value]) => (
                  <div key={key} className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="text-white/35">{key.replace(/([A-Z])/g, " $1").toLowerCase()}</span>
                    <span className="font-mono text-white/75">{typeof value === "number" && key.toLowerCase().includes("rate") ? percent(value) : String(value)}</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          <Panel>
            <PanelTitle>Previous reviews</PanelTitle>
            {reviews.data?.reviews?.length ? (
              <ul className="space-y-3">
                {reviews.data.reviews.slice(0, 8).map((review: any) => (
                  <li key={review.id} className="border-b border-white/[.06] pb-3 last:border-0 last:pb-0">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline" className="border-white/10 bg-white/[.03] font-mono text-[9px] text-white/40">
                        {review.agent}
                      </Badge>
                      <span className="text-[10px] text-white/25">{timeAgo(review.createdAt)}</span>
                    </div>
                    <p className="mt-1.5 line-clamp-3 text-[11px] leading-5 text-white/50">{review.summary}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs leading-5 text-white/35">None yet. Stored reviews let you see how the assessment changed as evidence built up.</p>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
