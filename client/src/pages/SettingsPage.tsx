/**
 * Settings.
 *
 * Also the onboarding path. `saveProfile` existed from the first commit with no
 * UI caller, which meant the `profiles` table was never written, `horizonYears`
 * was pinned at 5 forever, and onboarding could never complete.
 */

import { PageHeader, Panel, PanelTitle } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { Database, Settings as SettingsIcon, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function SettingsPage() {
  const workspace = trpc.workspace.get.useQuery();
  const agents = trpc.agents.status.useQuery();
  const profile = workspace.data?.profile as any;

  const [values, setValues] = useState<string | null>(null);
  const [context, setContext] = useState<string | null>(null);
  const [horizonYears, setHorizonYears] = useState<string | null>(null);

  const effectiveValues = values ?? profile?.values ?? "";
  const effectiveContext = context ?? profile?.context ?? "";
  const effectiveHorizon = horizonYears ?? String(profile?.horizonYears ?? 5);

  const save = trpc.workspace.saveProfile.useMutation({
    onSuccess: () => {
      toast.success("Profile saved");
      workspace.refetch();
    },
    onError: error => toast.error(error.message || "Could not save the profile"),
  });

  const snapshot = trpc.snapshots.save.useMutation({
    onSuccess: () => toast.success("Snapshot saved"),
    onError: () => toast.error("Could not save a snapshot"),
  });

  const counts = {
    goals: (workspace.data?.goals ?? []).length,
    steps: (workspace.data?.habits ?? []).length,
    checkins: (workspace.data?.checkins ?? []).length,
    journal: (workspace.data?.journal ?? []).length,
    scenarios: (workspace.data?.scenarios ?? []).length,
    snapshots: (workspace.data?.snapshots ?? []).length,
    messages: (workspace.data?.messages ?? []).length,
    reviews: (workspace.data?.reviews ?? []).length,
  };

  return (
    <>
      <PageHeader eyebrow="settings" icon={SettingsIcon} title="Profile and system" description="Your context shapes every projection and every agent reply. Nothing here is shared anywhere." />

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <Panel>
            <PanelTitle icon={ShieldCheck} hint="The agents see this verbatim. It is the difference between advice for you and advice for anyone.">
              About you
            </PanelTitle>
            <div className="space-y-4">
              <label className="block">
                <span className="field-label">What matters to you</span>
                <Textarea
                  value={effectiveValues}
                  onChange={event => setValues(event.target.value)}
                  placeholder="Craft over speed. I would rather be good at one thing than broadly employable."
                  className="mt-1.5 min-h-24 border-white/10 bg-white/[.03] text-white placeholder:text-white/25"
                />
              </label>
              <label className="block">
                <span className="field-label">Your circumstances and constraints</span>
                <Textarea
                  value={effectiveContext}
                  onChange={event => setContext(event.target.value)}
                  placeholder="Full-time job, one child, evenings are the only reliable time. No savings buffer, so income cannot drop."
                  className="mt-1.5 min-h-28 border-white/10 bg-white/[.03] text-white placeholder:text-white/25"
                />
              </label>
              <label className="block">
                <span className="field-label">Projection horizon — {effectiveHorizon} years</span>
                <input
                  type="range"
                  min={1}
                  max={20}
                  step={1}
                  value={Number(effectiveHorizon) || 5}
                  onChange={event => setHorizonYears(event.target.value)}
                  className="mt-2.5 w-full accent-[#ff9f7a]"
                />
              </label>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  className="rounded-full bg-[#ff9f7a] text-[#17101b] hover:bg-[#ffb18e]"
                  disabled={save.isPending || effectiveValues.trim().length < 2 || effectiveContext.trim().length < 2}
                  onClick={() => save.mutate({ values: effectiveValues.trim(), context: effectiveContext.trim(), horizonYears: Number(effectiveHorizon) || 5, onboardingComplete: true })}
                >
                  Save profile
                </Button>
                {profile?.onboardingComplete && <Badge variant="outline" className="border-emerald-300/25 bg-emerald-300/[.07] text-[10px] text-emerald-200">Onboarding complete</Badge>}
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelTitle icon={Database} hint="Everything is stored against your account in Postgres. Deleting a goal cascades to its steps and check-ins.">
              Your data
            </PanelTitle>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {Object.entries(counts).map(([key, value]) => (
                <div key={key} className="rounded-xl border border-white/[.07] bg-white/[.02] p-3">
                  <p className="font-mono text-lg text-white/85">{value}</p>
                  <p className="mt-0.5 text-[10px] uppercase tracking-[.12em] text-white/30">{key}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" className="rounded-full border-white/12 text-white/60 hover:border-[#ffb18e]/50 hover:text-[#ffb18e]" onClick={() => snapshot.mutate()} disabled={snapshot.isPending}>
                Take a trajectory snapshot
              </Button>
              <span className="text-[11px] text-white/30">Snapshots are how you verify the projection actually moved.</span>
            </div>
          </Panel>
        </div>

        <div className="space-y-5">
          <Panel>
            <PanelTitle>System</PanelTitle>
            <div className="space-y-2.5 text-xs">
              <Row label="Persistence" value={workspace.data?.persistence === "postgres" ? "PostgreSQL" : "unavailable"} ok={workspace.data?.persistence === "postgres"} />
              <Row label="Model" value={agents.data?.modelConfigured ? "configured" : "not configured"} ok={Boolean(agents.data?.modelConfigured)} />
              <Row label="Model version" value={workspace.data?.modelVersion ?? "—"} />
              <Row label="Session" value={workspace.data?.isDemo ? "demo (read-only)" : "signed in"} ok={!workspace.data?.isDemo} />
            </div>
          </Panel>

          {agents.data?.modelChain && agents.data.modelChain.length > 0 && (
            <Panel>
              <PanelTitle hint="Tried in order. If the first is rate-limited, the next one runs.">Model fallback chain</PanelTitle>
              <ol className="space-y-1.5">
                {agents.data.modelChain.map((model, index) => (
                  <li key={model} className="flex items-center gap-2 font-mono text-[10px] text-white/50">
                    <span className="w-4 shrink-0 text-white/25">{index + 1}.</span>
                    {model}
                  </li>
                ))}
              </ol>
            </Panel>
          )}

          <Panel>
            <PanelTitle>Limits</PanelTitle>
            <p className="text-xs leading-6 text-white/45">
              Projections are scenario models, not forecasts. Finance and health figures are illustrative and are not
              financial or medical advice. The bands are honest about uncertainty; they are not a promise.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-white/40">{label}</span>
      <span className="flex items-center gap-1.5">
        {ok !== undefined && <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-[#8be3c3]" : "bg-amber-300/70"}`} />}
        <span className="font-mono text-white/75">{value}</span>
      </span>
    </div>
  );
}
