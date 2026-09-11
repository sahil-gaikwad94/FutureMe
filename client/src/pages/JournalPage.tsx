/**
 * Journal.
 *
 * Journal entries were written to the database by the onboarding path and never
 * surfaced. They are the only place a user's own vocabulary appears, which is
 * exactly what the agents need to avoid giving advice that would apply to
 * anyone.
 *
 * Theme extraction is lexical rather than model-driven: it must work with no API
 * key configured, and the words a person returns to unaided are the signal — a
 * paraphrase of them is not.
 */

import { PageHeader, Panel, PanelTitle } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { shortDate } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { BookOpen, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function JournalPage() {
  const [content, setContent] = useState("");
  const workspace = trpc.workspace.get.useQuery();
  const insights = trpc.journal.insights.useQuery();

  const create = trpc.journal.create.useMutation({
    onSuccess: result => {
      if (!result.saved) {
        toast.error("Could not save that entry");
        return;
      }
      setContent("");
      toast.success(result.themes.length > 0 ? `Saved · themes: ${result.themes.join(", ")}` : "Saved");
      workspace.refetch();
      insights.refetch();
    },
    onError: () => toast.error("Sign in to keep a journal"),
  });

  const remove = trpc.journal.delete.useMutation({
    onSuccess: () => {
      toast.success("Entry deleted");
      workspace.refetch();
      insights.refetch();
    },
  });

  const entries = (workspace.data?.journal ?? []) as any[];

  return (
    <>
      <PageHeader
        eyebrow="journal"
        icon={BookOpen}
        title="What you noticed"
        description="Free text with no structure imposed. The mentor reads recent entries as context, and recurring vocabulary is extracted so patterns become visible without a model summarising them away."
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="space-y-5">
          <Panel>
            <Textarea
              value={content}
              onChange={event => setContent(event.target.value)}
              placeholder="What happened this week? What was harder than you expected, and what did you avoid?"
              className="min-h-32 resize-y border-white/10 bg-white/[.03] text-sm text-white placeholder:text-white/25"
            />
            <div className="mt-3 flex items-center justify-between">
              <p className="text-[11px] text-white/30">{content.trim().length} characters</p>
              <Button
                size="sm"
                className="rounded-full bg-[#ff9f7a] text-[#17101b] hover:bg-[#ffb18e]"
                disabled={create.isPending || content.trim().length < 2}
                onClick={() => create.mutate({ content: content.trim() })}
              >
                Save entry
              </Button>
            </div>
          </Panel>

          {entries.length === 0 ? (
            <Panel className="border-dashed">
              <p className="py-10 text-center text-sm text-white/40">Nothing written yet. One honest paragraph a week is enough for the patterns to show.</p>
            </Panel>
          ) : (
            entries.map((entry: any) => (
              <Panel key={entry.id}>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[10px] uppercase tracking-[.18em] text-white/30">{shortDate(entry.createdAt)}</p>
                  <button
                    onClick={() => { if (window.confirm("Delete this entry?")) remove.mutate({ entryId: entry.id }); }}
                    className="rounded-lg p-1.5 text-white/25 hover:text-rose-200"
                    aria-label="Delete entry"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-white/70">{entry.content}</p>
                {entry.tags && (
                  <div className="mt-3">
                    <Badge variant="outline" className="border-white/10 bg-white/[.03] font-mono text-[9px] text-white/40">
                      {entry.tags}
                    </Badge>
                  </div>
                )}
              </Panel>
            ))
          )}
        </div>

        <div className="space-y-5">
          <Panel>
            <PanelTitle hint="Words you returned to at least twice, across every entry.">Recurring language</PanelTitle>
            {insights.data?.themes?.length ? (
              <div className="space-y-2">
                {insights.data.themes.map((theme: any) => (
                  <div key={theme.token} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 truncate text-xs text-white/65">{theme.token}</span>
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-white/[.07]">
                      <div className="h-full rounded-full bg-[#ffb18e]/70" style={{ width: `${Math.min(100, (theme.count / insights.data.themes[0].count) * 100)}%` }} />
                    </div>
                    <span className="w-6 shrink-0 text-right font-mono text-[10px] text-white/35">{theme.count}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs leading-5 text-white/35">
                {insights.data?.entries ? "No word has repeated yet. Write more and the vocabulary you actually reach for will surface." : "No entries yet."}
              </p>
            )}
          </Panel>

          <Panel>
            <PanelTitle>Why this matters</PanelTitle>
            <p className="text-xs leading-6 text-white/45">
              The agents are told not to invent anything about your circumstances. Recurring language is the cheapest
              honest signal of what you are actually dealing with — and unlike a model summary, it cannot quietly change
              what you said.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}
