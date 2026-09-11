/**
 * Plan.
 *
 * Creation ran a hardcoded five-item array per domain and wrote `baseline: 0,
 * target: 100` regardless of what the user typed. There was no edit, no delete
 * and no archive — create-only, forever.
 *
 * Here, creation runs the planner agent against the user's real numbers and
 * reports which path produced the plan. Every goal and step is editable,
 * archivable and deletable, and check-ins render as a week grid so a streak is
 * visible rather than implied.
 */

import { PageHeader, Panel, PanelTitle, ProvenanceBadge } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { bottleneckMeta, DOMAIN_LIST, DOMAIN_META, percent, relativeDays, shortDate } from "@/lib/format";
import { weekGrid } from "@/lib/schedule";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Archive, ArrowRight, CalendarClock, Check, ListChecks, Pencil, Plus, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { Domain } from "../../../server/engine/projection";

export default function PlanPage() {
  const workspace = trpc.workspace.get.useQuery();
  const data = workspace.data;
  const goals = (data?.goals ?? []).filter((goal: any) => !goal.archived && goal.status !== "archived");
  const steps = (data?.habits ?? []).filter((habit: any) => !habit.archived);
  const checkins = (data?.checkins ?? []) as any[];

  return (
    <>
      <PageHeader
        eyebrow="plan"
        icon={ListChecks}
        title="Goals and steps"
        description="Every plan is generated against your committed hours and checked against the simulation before it is saved. If the model is unavailable, the fallback plan is built from your own inputs and labelled as such."
      />

      <div className="space-y-5">
        <CreateGoal onDone={() => workspace.refetch()} />

        {goals.length === 0 ? (
          <Panel className="border-dashed">
            <p className="py-10 text-center text-sm text-white/40">No goals yet. The form above runs the planner and builds the first one.</p>
          </Panel>
        ) : (
          goals.map((goal: any) => (
            <GoalCard key={goal.id} goal={goal} steps={steps.filter((step: any) => step.goalId === goal.id)} checkins={checkins} onChanged={() => workspace.refetch()} />
          ))
        )}
      </div>
    </>
  );
}

function CreateGoal({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: "",
    outcome: "",
    currentState: "",
    deadline: "",
    domain: "career" as Domain,
    weeklyHours: "5",
    baseline: "",
    target: "",
    monthlyContribution: "",
  });

  const create = trpc.goals.create.useMutation({
    onSuccess: result => {
      if (!result.saved) {
        toast.error("Could not save the goal. Is the database connected?");
        return;
      }
      setOpen(false);
      toast.success(result.source === "model" ? "Plan generated" : "Plan built from your inputs");
      onDone();
    },
    onError: error => toast.error(error.message || "Could not create the goal"),
  });

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(current => ({ ...current, [key]: event.target.value }));

  const submit = () => {
    if (form.title.trim().length < 3 || form.outcome.trim().length < 3 || form.currentState.trim().length < 3) {
      toast("Give the goal a title, an outcome, and an honest starting point.");
      return;
    }
    create.mutate({
      title: form.title.trim(),
      outcome: form.outcome.trim(),
      currentState: form.currentState.trim(),
      deadline: form.deadline.trim(),
      domain: form.domain,
      weeklyHours: Number(form.weeklyHours) || 1,
      ...(form.baseline ? { baseline: Number(form.baseline) } : {}),
      ...(form.target ? { target: Number(form.target) } : {}),
      ...(form.monthlyContribution ? { monthlyContribution: Number(form.monthlyContribution) } : {}),
    });
  };

  const isFinance = form.domain === "finance";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="rounded-full bg-[#ff9f7a] px-5 text-sm font-semibold text-[#17101b] hover:bg-[#ffb18e]">
          <Plus size={15} /> New goal
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[88vh] overflow-y-auto border-white/10 bg-[#0e1223] text-white sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-[family-name:var(--font-display)] tracking-[-.04em]">Start with one real goal</DialogTitle>
          <DialogDescription className="text-white/45">
            The planner reads these answers, checks them against the simulation, and builds steps that fit the hours you
            actually have.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <label className="sm:col-span-2">
            <span className="field-label">What is the goal?</span>
            <Input value={form.title} onChange={set("title")} placeholder="Get my first backend engineering role" className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
          </label>
          <label className="sm:col-span-2">
            <span className="field-label">What would success look like?</span>
            <Input value={form.outcome} onChange={set("outcome")} placeholder="Three final-round interviews and one offer" className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
          </label>
          <label>
            <span className="field-label">Area</span>
            <select value={form.domain} onChange={set("domain")} className="field-input mt-1.5">
              {DOMAIN_LIST.map(item => (
                <option key={item} value={item}>
                  {DOMAIN_META[item].label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">Target date</span>
            <Input value={form.deadline} onChange={set("deadline")} placeholder="June 2027" className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
          </label>
          <label className="sm:col-span-2">
            <span className="field-label">Where are you starting from? Be honest — this is what the plan is built against.</span>
            <Textarea value={form.currentState} onChange={set("currentState")} placeholder="Two years of self-taught work, one abandoned project, no professional experience, applying sporadically." className="mt-1.5 min-h-24 border-white/10 bg-white/[.03] text-white placeholder:text-white/25" />
          </label>
          <label>
            <span className="field-label">Hours per week you can really give</span>
            <Input type="number" min={0.5} max={60} step={0.5} value={form.weeklyHours} onChange={set("weeklyHours")} className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
          </label>
          {isFinance ? (
            <label>
              <span className="field-label">Monthly contribution</span>
              <Input type="number" min={0} value={form.monthlyContribution} onChange={set("monthlyContribution")} placeholder="400" className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
            </label>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <label>
                <span className="field-label">Now (0–100)</span>
                <Input type="number" min={0} max={100} value={form.baseline} onChange={set("baseline")} placeholder="30" className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
              </label>
              <label>
                <span className="field-label">Target (0–100)</span>
                <Input type="number" min={0} max={100} value={form.target} onChange={set("target")} placeholder="90" className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
              </label>
            </div>
          )}
          {isFinance && (
            <div className="grid grid-cols-2 gap-3 sm:col-span-2">
              <label>
                <span className="field-label">Current balance</span>
                <Input type="number" min={0} value={form.baseline} onChange={set("baseline")} placeholder="2000" className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
              </label>
              <label>
                <span className="field-label">Target balance</span>
                <Input type="number" min={0} value={form.target} onChange={set("target")} placeholder="40000" className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
              </label>
            </div>
          )}
        </div>

        {create.data?.saved && create.data.feasibility && (
          <div className="rounded-2xl border border-white/[.07] bg-white/[.02] p-4">
            <p className="text-[10px] uppercase tracking-[.18em] text-white/35">Feasibility check</p>
            <p className="mt-2 text-sm leading-6 text-white/70">{create.data.feasibility.reasoning}</p>
            <p className="mt-2 font-mono text-xs text-white/45">
              {percent(create.data.feasibility.probabilityOfTarget)} to target · binding constraint: {create.data.feasibility.bottleneck}
            </p>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} className="text-white/50 hover:text-white">
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending} className="rounded-full bg-[#ff9f7a] text-[#17101b] hover:bg-[#ffb18e]">
            {create.isPending ? (
              <>
                <RefreshCw size={15} className="animate-spin" /> Planning…
              </>
            ) : (
              <>
                <Sparkles size={15} /> Build the plan
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GoalCard({ goal, steps, checkins, onChanged }: { goal: any; steps: any[]; checkins: any[]; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const details = (goal.details ?? {}) as Record<string, any>;
  const projection = trpc.workspace.get.useQuery().data?.projection;
  const projected = (projection?.scenarios?.realistic ?? []).find((item: any) => item.domain === goal.domain);
  const constraint = bottleneckMeta(projected?.bottleneck ?? "unknown");

  const archive = trpc.goals.archive.useMutation({ onSuccess: () => { toast.success("Goal archived"); onChanged(); } });
  const remove = trpc.goals.delete.useMutation({ onSuccess: () => { toast.success("Goal deleted"); onChanged(); } });
  const replan = trpc.goals.replan.useMutation({
    onSuccess: result => {
      toast.success(result.source === "model" ? "Plan regenerated" : "Plan rebuilt from your inputs");
      onChanged();
    },
    onError: () => toast.error("Could not regenerate the plan"),
  });

  const update = trpc.goals.update.useMutation({
    onSuccess: () => {
      toast.success("Goal updated");
      setEditing(false);
      onChanged();
    },
  });

  const [draft, setDraft] = useState({
    title: goal.title,
    weeklyHours: String(goal.weeklyHours ?? 4),
    deadline: String(details.deadlineText ?? ""),
    baseline: String(goal.baseline ?? 0),
    target: String(goal.target ?? 100),
    outcome: String(details.outcome ?? ""),
    currentState: String(details.currentState ?? ""),
    monthlyContribution: details.monthlyContribution !== undefined ? String(details.monthlyContribution) : "",
  });

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-white/12 bg-white/[.03] text-white/55">
              {DOMAIN_META[goal.domain as Domain].label}
            </Badge>
            <Badge variant="outline" className={cn("border", constraint.tone === "good" ? "border-emerald-300/25 bg-emerald-300/[.07] text-emerald-200" : constraint.tone === "warn" ? "border-amber-300/25 bg-amber-300/[.07] text-amber-200" : "border-rose-300/25 bg-rose-300/[.07] text-rose-200")}>
              {constraint.label}
            </Badge>
            {details.plannedBy && <ProvenanceBadge source={details.plannedBy === "deterministic" ? "deterministic" : "model"} model={details.plannedBy} />}
          </div>
          <h2 className="mt-3 font-[family-name:var(--font-display)] text-2xl leading-tight tracking-[-.04em] text-white">{goal.title}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/50">
            <span className="text-white/30">Outcome: </span>
            {details.outcome || "not stated"}
          </p>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/35">
            <span className="inline-flex items-center gap-1.5">
              <CalendarClock size={12} /> {details.deadlineText || (goal.targetDate ? shortDate(goal.targetDate) : "no date")}
              {goal.targetDate && ` · ${relativeDays(daysUntil(goal.targetDate))}`}
            </span>
            <span>{goal.weeklyHours}h/week committed</span>
            {projected && <span>{percent(projected.probabilityOfTarget)} simulated chance</span>}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-1.5">
          <IconAction label="Regenerate plan" onClick={() => replan.mutate({ goalId: goal.id })} disabled={replan.isPending}>
            {replan.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Sparkles size={14} />}
          </IconAction>
          <IconAction label="Edit" onClick={() => setEditing(true)}>
            <Pencil size={14} />
          </IconAction>
          <IconAction label="Archive" onClick={() => archive.mutate({ goalId: goal.id, archived: true })} disabled={archive.isPending}>
            <Archive size={14} />
          </IconAction>
          <IconAction label="Delete" danger onClick={() => { if (window.confirm("Delete this goal, its steps and all check-ins? This cannot be undone.")) remove.mutate({ goalId: goal.id }); }} disabled={remove.isPending}>
            <Trash2 size={14} />
          </IconAction>
        </div>
      </div>

      {editing && (
        <div className="mt-5 grid gap-3 rounded-2xl border border-white/[.07] bg-white/[.02] p-4 sm:grid-cols-2">
          <label className="sm:col-span-2">
            <span className="field-label">Title</span>
            <Input value={draft.title} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
          </label>
          <label>
            <span className="field-label">Hours per week</span>
            <Input type="number" min={0.5} max={60} step={0.5} value={draft.weeklyHours} onChange={event => setDraft(current => ({ ...current, weeklyHours: event.target.value }))} className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
          </label>
          <label>
            <span className="field-label">Target date</span>
            <Input value={draft.deadline} onChange={event => setDraft(current => ({ ...current, deadline: event.target.value }))} className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
          </label>
          <label>
            <span className="field-label">Baseline</span>
            <Input type="number" value={draft.baseline} onChange={event => setDraft(current => ({ ...current, baseline: event.target.value }))} className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
          </label>
          <label>
            <span className="field-label">Target</span>
            <Input type="number" value={draft.target} onChange={event => setDraft(current => ({ ...current, target: event.target.value }))} className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
          </label>
          {goal.domain === "finance" && (
            <label>
              <span className="field-label">Monthly contribution</span>
              <Input type="number" min={0} value={draft.monthlyContribution} onChange={event => setDraft(current => ({ ...current, monthlyContribution: event.target.value }))} className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
            </label>
          )}
          <label className="sm:col-span-2">
            <span className="field-label">Outcome</span>
            <Textarea value={draft.outcome} onChange={event => setDraft(current => ({ ...current, outcome: event.target.value }))} className="mt-1.5 min-h-16 border-white/10 bg-white/[.03] text-white" />
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <Button
              size="sm"
              className="rounded-full bg-[#ff9f7a] text-[#17101b] hover:bg-[#ffb18e]"
              disabled={update.isPending}
              onClick={() =>
                update.mutate({
                  goalId: goal.id,
                  title: draft.title,
                  weeklyHours: Number(draft.weeklyHours) || 1,
                  deadline: draft.deadline,
                  baseline: Number(draft.baseline) || 0,
                  target: Number(draft.target) || 100,
                  outcome: draft.outcome,
                  currentState: draft.currentState || undefined,
                  ...(draft.monthlyContribution ? { monthlyContribution: Number(draft.monthlyContribution) } : {}),
                })
              }
            >
              Save changes
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} className="text-white/50 hover:text-white">
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="mt-6 border-t border-white/[.07] pt-5">
        <div className="mb-3.5 flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-[.2em] text-white/35">Steps · {steps.length}</p>
          <AddStep goalId={goal.id} domain={goal.domain} onDone={onChanged} />
        </div>

        {steps.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-white/12 p-5 text-center text-sm text-white/35">No steps. Add one, or regenerate the plan.</p>
        ) : (
          <div className="space-y-2.5">
            {steps.map((step: any) => (
              <StepRow key={step.id} step={step} checkins={checkins.filter((item: any) => item.habitId === step.id)} onChanged={onChanged} />
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

function StepRow({ step, checkins, onChanged }: { step: any; checkins: any[]; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState({ title: step.title, weeklyFrequency: String(step.weeklyFrequency), minutesPerSession: String(step.minutesPerSession) });

  const record = trpc.checkins.record.useMutation({
    onSuccess: result => {
      toast.success(result.updated ? "Today updated" : "Recorded");
      onChanged();
    },
    onError: () => toast.error("Could not record that"),
  });
  const update = trpc.steps.update.useMutation({ onSuccess: () => { toast.success("Step updated"); setEditing(false); onChanged(); } });
  const remove = trpc.steps.delete.useMutation({ onSuccess: () => { toast.success("Step deleted"); onChanged(); } });

  const grid = weekGrid(step.id, checkins);
  const doneToday = checkins.some((item: any) => new Date(item.checkinDate).toDateString() === new Date().toDateString());

  return (
    <div className="rounded-2xl border border-white/[.07] bg-white/[.02] p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-5 text-white/85">{step.title}</p>
          <p className="mt-1 text-[11px] text-white/35">
            {step.weeklyFrequency}×/week · {step.minutesPerSession} min · consistency {percent(Number(step.adherencePrior) || 0)} · streak {step.currentStreak}
            {step.longestStreak > 0 && ` · best ${step.longestStreak}`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex gap-1" aria-label="Last seven days">
            {grid.map(day => (
              <span
                key={day.key}
                title={day.key}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-md border text-[9px]",
                  day.completed === true
                    ? "border-[#8be3c3]/40 bg-[#8be3c3]/20 text-[#8be3c3]"
                    : day.completed === false
                      ? "border-rose-300/25 bg-rose-300/10 text-rose-200/60"
                      : "border-white/10 text-white/25",
                )}
              >
                {day.label}
              </span>
            ))}
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={() => record.mutate({ stepId: step.id, completed: true, checkinDate: new Date(), note: note || undefined })}
              disabled={record.isPending || doneToday}
              className={cn("rounded-full px-3 py-1.5 text-[11px] disabled:opacity-40", doneToday ? "border border-white/10 text-white/35" : "bg-[#8be3c3]/15 text-[#8be3c3] hover:bg-[#8be3c3]/25")}
            >
              {doneToday ? "Logged" : "Done"}
            </button>
            <button onClick={() => setEditing(current => !current)} className="rounded-full border border-white/12 p-1.5 text-white/40 hover:text-white" aria-label="Edit step">
              <Pencil size={13} />
            </button>
            <button
              onClick={() => { if (window.confirm("Delete this step and its check-ins?")) remove.mutate({ stepId: step.id }); }}
              className="rounded-full border border-white/12 p-1.5 text-white/40 hover:border-rose-300/40 hover:text-rose-200"
              aria-label="Delete step"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      </div>

      {!doneToday && (
        <Input value={note} onChange={event => setNote(event.target.value)} placeholder="What happened? One sentence — the mentor reads this." className="mt-2.5 h-9 border-white/[.07] bg-white/[.02] text-xs text-white placeholder:text-white/25" />
      )}

      {editing && (
        <div className="mt-3 grid gap-2.5 border-t border-white/[.07] pt-3 sm:grid-cols-[1fr_110px_110px_auto]">
          <Input value={draft.title} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} className="h-9 border-white/10 bg-white/[.03] text-xs text-white" />
          <Input type="number" min={0.5} max={14} step={0.5} value={draft.weeklyFrequency} onChange={event => setDraft(current => ({ ...current, weeklyFrequency: event.target.value }))} className="h-9 border-white/10 bg-white/[.03] text-xs text-white" />
          <Input type="number" min={5} max={240} step={5} value={draft.minutesPerSession} onChange={event => setDraft(current => ({ ...current, minutesPerSession: event.target.value }))} className="h-9 border-white/10 bg-white/[.03] text-xs text-white" />
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" className="h-9 px-3 text-white/70 hover:text-white" onClick={() => update.mutate({ stepId: step.id, title: draft.title, weeklyFrequency: Number(draft.weeklyFrequency) || 1, minutesPerSession: Number(draft.minutesPerSession) || 15 })}>
              <Check size={14} />
            </Button>
            <Button size="sm" variant="ghost" className="h-9 px-3 text-white/40 hover:text-white" onClick={() => setEditing(false)}>
              <X size={14} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddStep({ goalId, domain, onDone }: { goalId: number; domain: Domain; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: "", weeklyFrequency: "2", minutesPerSession: "30" });
  const create = trpc.steps.create.useMutation({
    onSuccess: result => {
      if (!result.saved) {
        toast.error("Could not add the step");
        return;
      }
      setOpen(false);
      setForm({ title: "", weeklyFrequency: "2", minutesPerSession: "30" });
      toast.success("Step added");
      onDone();
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="inline-flex items-center gap-1.5 rounded-full border border-white/12 px-3 py-1.5 text-[11px] text-white/50 hover:border-[#ffb18e]/50 hover:text-[#ffb18e]">
          <Plus size={12} /> Add step
        </button>
      </DialogTrigger>
      <DialogContent className="border-white/10 bg-[#0e1223] text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a step</DialogTitle>
          <DialogDescription className="text-white/45">Make it observable. "Send the email", not "network more".</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <label className="block">
            <span className="field-label">Step</span>
            <Input value={form.title} onChange={event => setForm(current => ({ ...current, title: event.target.value }))} className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="field-label">Times per week</span>
              <Input type="number" min={0.5} max={14} step={0.5} value={form.weeklyFrequency} onChange={event => setForm(current => ({ ...current, weeklyFrequency: event.target.value }))} className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
            </label>
            <label>
              <span className="field-label">Minutes</span>
              <Input type="number" min={5} max={240} step={5} value={form.minutesPerSession} onChange={event => setForm(current => ({ ...current, minutesPerSession: event.target.value }))} className="mt-1.5 border-white/10 bg-white/[.03] text-white" />
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => create.mutate({ goalId, domain, title: form.title.trim(), weeklyFrequency: Number(form.weeklyFrequency) || 1, minutesPerSession: Number(form.minutesPerSession) || 30 })}
            disabled={create.isPending || form.title.trim().length < 3}
            className="rounded-full bg-[#ff9f7a] text-[#17101b] hover:bg-[#ffb18e]"
          >
            Add step <ArrowRight size={14} />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IconAction({ children, label, onClick, disabled, danger }: { children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn("rounded-full border border-white/12 p-2 text-white/45 transition-colors hover:text-white disabled:opacity-40", danger && "hover:border-rose-300/40 hover:text-rose-200")}
    >
      {children}
    </button>
  );
}

function daysUntil(date: Date | string): number {
  const target = typeof date === "string" ? new Date(date) : date;
  return Math.round((target.getTime() - Date.now()) / 86_400_000);
}
