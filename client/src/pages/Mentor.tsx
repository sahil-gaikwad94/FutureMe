/**
 * Mentor.
 *
 * Three fixes over the previous chat. History is now read back from the database
 * instead of restarting from a canned greeting on every load. Replies stream
 * token by token rather than appearing after an 18-second block. And every reply
 * carries provenance — which model produced it, or that it was reasoned
 * deterministically from the user's own numbers when no model was reachable.
 *
 * The fact pack the agents are constrained to is viewable here, which is the
 * difference between "trust the AI" and being able to check it.
 */

import { PageHeader, Panel, ProvenanceBadge } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { percent, timeAgo } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { useCoachStream, type CoachMode } from "@/lib/useCoachStream";
import { cn } from "@/lib/utils";
import { Eye, EyeOff, MessageCircle, Send, Sparkles, Trash2, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { toast } from "sonner";

type Message = {
  role: "user" | "assistant";
  content: string;
  source?: "model" | "deterministic";
  model?: string;
  degradedReason?: string;
  groundedOn?: string[];
  at?: string;
};

const MODES: Array<{ id: CoachMode; label: string; hint: string }> = [
  { id: "coach", label: "Coach", hint: "Name the blocker, give one next action" },
  { id: "critic", label: "Critic", hint: "Argue the plan will fail, using your evidence" },
  { id: "celebrate", label: "Mark progress", hint: "Say what actually changed, and why" },
];

const PROMPTS: Record<CoachMode, string[]> = {
  coach: ["What should I do this week?", "I'm stuck — help me pick the next step.", "Is this plan working?", "What am I avoiding?"],
  critic: ["Tell me why this plan will fail.", "Which step will I skip first?", "What am I being dishonest about?", "Give me the smaller version that survives a bad week."],
  celebrate: ["What has actually improved?", "What made the good week work?", "What should I protect?"],
};

export default function Mentor() {
  const [mode, setMode] = useState<CoachMode>("coach");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [showFacts, setShowFacts] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const stream = useCoachStream();
  const scrollRef = useRef<HTMLDivElement>(null);

  const history = trpc.agents.history.useQuery({ limit: 50 });
  const facts = trpc.agents.factPack.useQuery(undefined, { enabled: showFacts });
  const status = trpc.agents.status.useQuery();
  const workspace = trpc.workspace.get.useQuery();

  const clear = trpc.agents.clearHistory.useMutation({
    onSuccess: () => {
      setMessages([]);
      toast.success("Conversation cleared");
      history.refetch();
    },
  });

  // Rehydrate. The previous implementation fetched stored messages and threw
  // them away, so every refresh restarted the conversation.
  useEffect(() => {
    if (hydrated || !history.data) return;
    setHydrated(true);
    setMessages(
      history.data.messages.map((message: any) => ({
        role: message.role,
        content: message.content,
        source: message.meta?.fallback ? "deterministic" : message.role === "assistant" ? "model" : undefined,
        model: message.meta?.model,
        groundedOn: message.meta?.groundedOn,
        at: message.createdAt,
      })),
    );
  }, [history.data, hydrated]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, stream.buffer]);

  const send = async (value = input) => {
    const content = value.trim();
    if (!content || stream.streaming) return;
    setInput("");

    const next: Message[] = [...messages, { role: "user", content }];
    setMessages(next);

    const reply = await stream.send({
      messages: next.filter(message => message.content.trim()).slice(-12).map(message => ({ role: message.role, content: message.content })),
      mode,
    });

    if (reply.content) {
      setMessages(current => [
        ...current,
        { role: "assistant", content: reply.content, source: reply.source, model: reply.model, degradedReason: reply.degradedReason, groundedOn: reply.groundedOn },
      ]);
      history.refetch();
      workspace.refetch();
    } else if (reply.degradedReason) {
      toast.error(reply.degradedReason);
    }
  };

  const projection = workspace.data?.projection;

  return (
    <>
      <PageHeader
        eyebrow="mentor"
        icon={MessageCircle}
        title="Talk it through"
        description="The agents are given a numbered fact sheet of computed values and instructed to cite it. They cannot see anything that is not on it, and every reply tells you which path produced it."
        action={
          <>
            <Button size="sm" variant="outline" className="rounded-full border-white/12 text-white/60 hover:border-[#ffb18e]/50 hover:text-[#ffb18e]" onClick={() => setShowFacts(current => !current)}>
              {showFacts ? <EyeOff size={14} /> : <Eye size={14} />} Fact pack
            </Button>
            <Button size="sm" variant="outline" className="rounded-full border-white/12 text-white/60 hover:border-rose-300/40 hover:text-rose-200" onClick={() => clear.mutate()} disabled={clear.isPending || messages.length === 0}>
              <Trash2 size={14} /> Clear
            </Button>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <Panel className="flex h-[calc(100vh-230px)] min-h-[520px] flex-col p-0">
          {/* Mode selector */}
          <div className="flex flex-wrap gap-1.5 border-b border-white/[.07] p-3">
            {MODES.map(item => (
              <button
                key={item.id}
                onClick={() => setMode(item.id)}
                title={item.hint}
                className={cn("rounded-full px-3.5 py-1.5 text-xs transition-colors", mode === item.id ? "bg-[#ff9f7a]/15 text-[#ffb18e]" : "text-white/40 hover:bg-white/[.04] hover:text-white/75")}
              >
                {item.label}
              </button>
            ))}
            {status.data && (
              <span className="ml-auto self-center font-mono text-[10px] text-white/25">
                {status.data.modelConfigured ? status.data.modelChain[0] : "no model key · deterministic mode"}
              </span>
            )}
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
            {messages.length === 0 && !stream.streaming && (
              <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
                <Sparkles size={26} className="text-white/15" />
                <p className="max-w-md text-sm leading-6 text-white/40">
                  {MODES.find(item => item.id === mode)?.hint}. It can see your goal, your steps, your measured
                  consistency and your check-in notes — and nothing else.
                </p>
                <div className="flex max-w-lg flex-wrap justify-center gap-2">
                  {PROMPTS[mode].map(prompt => (
                    <button key={prompt} onClick={() => send(prompt)} className="rounded-full border border-white/10 px-3.5 py-1.5 text-[11px] text-white/45 hover:border-[#ffb18e]/50 hover:text-[#ffb18e]">
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message, index) => (
              <Bubble key={index} message={message} />
            ))}

            {stream.streaming && (
              <div className="flex justify-start">
                <div className="max-w-[88%] rounded-2xl bg-white/[.06] px-4 py-3">
                  {stream.buffer ? (
                    <Markdown>{stream.buffer}</Markdown>
                  ) : (
                    <span className="typing-dots">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-white/[.07] p-3">
            <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-white/[.03] p-2">
              <Textarea
                value={input}
                onChange={event => setInput(event.target.value)}
                onKeyDown={event => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
                placeholder="I'm stuck on…"
                className="min-h-10 flex-1 resize-none border-0 bg-transparent text-sm text-white shadow-none focus-visible:ring-0"
              />
              <Button onClick={() => send()} disabled={!input.trim() || stream.streaming} size="icon" className="h-9 w-9 shrink-0 rounded-xl bg-[#ff9f7a] text-[#19111b] hover:bg-[#ffb18e]">
                <Send size={15} />
              </Button>
            </div>
            <div className="mt-2 flex gap-2 overflow-x-auto pb-0.5">
              {PROMPTS[mode].map(prompt => (
                <button key={prompt} onClick={() => send(prompt)} disabled={stream.streaming} className="whitespace-nowrap rounded-full border border-white/10 px-3 py-1.5 text-[10px] text-white/40 hover:border-[#ffb18e]/50 hover:text-[#ffb18e] disabled:opacity-40">
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        </Panel>

        <div className="space-y-5">
          {showFacts && (
            <Panel>
              <p className="text-[10px] uppercase tracking-[.2em] text-white/35">What the agents can see</p>
              <p className="mt-1.5 text-[11px] leading-5 text-white/30">
                This exact text is the system context. Anything not on it, they are instructed not to assert.
              </p>
              <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-2xl border border-white/[.07] bg-black/25 p-3 font-mono text-[10px] leading-4 text-white/55">
                {facts.data?.rendered ?? "Loading…"}
              </pre>
            </Panel>
          )}

          <Panel>
            <p className="text-[10px] uppercase tracking-[.2em] text-white/35">Agents available</p>
            <ul className="mt-3 space-y-3">
              {(status.data?.agents ?? []).map(agent => (
                <li key={agent.id}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-white/75">{agent.name}</span>
                    <Badge variant="outline" className="border-white/10 bg-white/[.03] font-mono text-[9px] text-white/40">
                      {status.data?.modelConfigured ? "model + fallback" : "fallback only"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-white/35">{agent.purpose}</p>
                </li>
              ))}
            </ul>
          </Panel>

          {projection && (
            <Panel>
              <p className="text-[10px] uppercase tracking-[.2em] text-white/35">Grounding snapshot</p>
              <div className="mt-3 space-y-2 text-xs">
                <Row label="Composite" value={`${projection.composite.toFixed(0)}/100`} />
                <Row label="Confidence" value={percent(projection.confidence)} />
                <Row label="Consistency" value={percent(projection.currentAdherence)} />
                <Row label="Model" value={projection.modelVersion} />
              </div>
              <p className="mt-3 text-[11px] leading-4 text-white/30">
                Every reply cites the fact ids it used. Hover a provenance badge to see why a deterministic answer was
                given.
              </p>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

function Bubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] whitespace-pre-wrap rounded-2xl bg-[#ff9f7a] px-4 py-3 text-sm leading-6 text-[#19111b]">{message.content}</div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%]">
        <div className="rounded-2xl bg-white/[.06] px-4 py-3">
          <Markdown>{message.content}</Markdown>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 px-1">
          <ProvenanceBadge source={message.source} model={message.model} degradedReason={message.degradedReason} />
          {message.groundedOn && message.groundedOn.length > 0 && (
            <span className="font-mono text-[9px] text-white/25">cited: {message.groundedOn.join(", ")}</span>
          )}
          {message.at && <span className="text-[9px] text-white/20">{timeAgo(message.at)}</span>}
        </div>
        {message.degradedReason && <p className="mt-1 px-1 text-[10px] leading-4 text-amber-200/50">{message.degradedReason}</p>}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-white/40">{label}</span>
      <span className="font-mono text-white/80">{value}</span>
    </div>
  );
}

export { Zap };
