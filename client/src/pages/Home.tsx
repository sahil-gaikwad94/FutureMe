import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  BarChart3,
  Check,
  ChevronRight,
  CircleHelp,
  Compass,
  Flame,
  Heart,
  LogOut,
  Menu,
  MessageCircle,
  Moon,
  Orbit,
  Plus,
  Radio,
  RefreshCw,
  Send,
  Sparkles,
  Target,
  TrendingUp,
  UserRound,
  WalletCards,
  X,
  Zap,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";

type Domain = "career" | "finance" | "health" | "relationships";
type ProjectionDomain = { domain: Domain; score: number; delta: number; confidence: number; points: Array<{ year: number; value: number; low: number; high: number }>; signal: string };
type Projection = { horizonYears: number; currentAdherence: number; confidence: number; scenarios: Record<string, ProjectionDomain[]>; assumptions: string[] };

const domainMeta: Record<Domain, { label: string; eyebrow: string; icon: typeof Target; color: string; soft: string; copy: string }> = {
  career: { label: "Career & craft", eyebrow: "the work that compounds", icon: Target, color: "#ff9f7a", soft: "rgba(255,159,122,.12)", copy: "Skill depth" },
  finance: { label: "Financial runway", eyebrow: "breathing room", icon: WalletCards, color: "#8be3c3", soft: "rgba(139,227,195,.12)", copy: "Optionality" },
  health: { label: "Body & energy", eyebrow: "the baseline underneath", icon: Zap, color: "#a6b6ff", soft: "rgba(166,182,255,.12)", copy: "Automaticity" },
  relationships: { label: "Relationships", eyebrow: "the people who make it real", icon: Heart, color: "#e8b7ff", soft: "rgba(232,183,255,.12)", copy: "Connection" },
};

const formatPercent = (value: number) => `${Math.round(value)}%`;

function ProjectionChart({ projection, accent = "#ff9f7a" }: { projection?: ProjectionDomain; accent?: string }) {
  const points = projection?.points || [];
  const width = 620;
  const height = 220;
  const x = (year: number) => 18 + (year / Math.max(points[points.length - 1]?.year || 5, 1)) * (width - 36);
  const y = (value: number) => height - 22 - (Math.max(0, Math.min(100, value)) / 100) * (height - 52);
  const line = points.map(point => `${x(point.year)},${y(point.value)}`).join(" ");
  const band = [...points.map(point => `${x(point.year)},${y(point.high)}`), ...points.slice().reverse().map(point => `${x(point.year)},${y(point.low)}`)].join(" ");
  return (
    <div className="relative h-[220px] w-full overflow-hidden rounded-[22px] border border-white/[.08] bg-[#11152a]/70 p-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" role="img" aria-label="Projected trajectory chart">
        <defs>
          <linearGradient id="band-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={accent} stopOpacity=".28" /><stop offset="1" stopColor={accent} stopOpacity=".01" /></linearGradient>
          <filter id="line-glow"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        {[25, 50, 75].map(value => <line key={value} x1="18" x2={width - 18} y1={y(value)} y2={y(value)} stroke="rgba(255,255,255,.08)" strokeDasharray="4 8" />)}
        <polygon points={band} fill="url(#band-gradient)" />
        <polyline points={line} fill="none" stroke={accent} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" filter="url(#line-glow)" />
        {points.map(point => <circle key={point.year} cx={x(point.year)} cy={y(point.value)} r={point.year === points[points.length - 1]?.year ? 6 : 3.5} fill="#0d1020" stroke={accent} strokeWidth="2" />)}
        {points.map(point => <text key={`t-${point.year}`} x={x(point.year)} y={height - 4} textAnchor="middle" fill="rgba(255,255,255,.42)" fontSize="10">{point.year === 0 ? "now" : `yr ${point.year}`}</text>)}
      </svg>
    </div>
  );
}

function DomainCard({ item, scenario }: { item: ProjectionDomain; scenario: string }) {
  const meta = domainMeta[item.domain];
  const Icon = meta.icon;
  return (
    <article className="group relative overflow-hidden rounded-[26px] border border-white/[.08] bg-[#11152a]/80 p-5 transition duration-300 hover:-translate-y-1 hover:border-white/[.16] hover:bg-[#151a33]">
      <div className="absolute -right-8 -top-12 h-32 w-32 rounded-full blur-3xl" style={{ background: meta.color, opacity: .12 }} />
      <div className="relative flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl" style={{ background: meta.soft, color: meta.color }}><Icon size={18} strokeWidth={1.8} /></div>
          <div><p className="text-[10px] uppercase tracking-[.2em] text-white/40">{meta.eyebrow}</p><h3 className="mt-1 text-sm font-medium text-white">{meta.label}</h3></div>
        </div>
        <span className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] uppercase tracking-wider text-white/40">{scenario}</span>
      </div>
      <div className="relative mt-7 flex items-end justify-between">
        <div><p className="text-4xl font-semibold tracking-[-.06em] text-white">{Math.round(item.score)}<span className="ml-1 text-lg text-white/30">/100</span></p><p className="mt-2 text-xs text-white/50">{item.signal}</p></div>
        <div className="text-right"><p className="text-xs font-medium" style={{ color: meta.color }}>+{Math.round(item.delta)} pts</p><p className="mt-1 text-[10px] uppercase tracking-wider text-white/35">{Math.round(item.confidence * 100)}% clarity</p></div>
      </div>
      <div className="mt-5"><ProjectionChart projection={item} accent={meta.color} /></div>
    </article>
  );
}

function Wordmark() { return <div className="flex items-center gap-3"><div className="relative flex h-9 w-9 items-center justify-center rounded-2xl border border-[#ffb18e]/40 bg-[#ff9f7a]/10"><Orbit size={19} className="text-[#ffb18e]" /><span className="absolute h-1.5 w-1.5 rounded-full bg-[#ffcfb8] shadow-[0_0_12px_#ff9f7a]" /></div><span className="font-[family-name:var(--font-display)] text-lg tracking-[-.03em] text-white">futureme</span></div>; }

function OnboardingCard({ onClose, isAuthenticated }: { onClose: () => void; isAuthenticated: boolean }) {
  const [values, setValues] = useState("");
  const [context, setContext] = useState("");
  const save = trpc.workspace.saveProfile.useMutation({ onSuccess: () => { toast.success("Your first projection is ready"); onClose(); }, onError: () => { toast.error("Sign in to save your profile"); startLogin(); } });
  const handleSave = () => { if (!isAuthenticated) { toast("Sign in with Google to save your starting point"); startLogin(); return; } save.mutate({ values, context, horizonYears: 5, onboardingComplete: true }); };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#050713]/80 p-4 backdrop-blur-md"><div className="w-full max-w-xl rounded-[32px] border border-white/10 bg-[#11152a] p-7 shadow-2xl shadow-black/40 sm:p-9"><div className="flex items-start justify-between"><div><p className="text-[10px] uppercase tracking-[.24em] text-[#ffb18e]">A small beginning</p><h2 className="mt-3 font-[family-name:var(--font-display)] text-3xl tracking-[-.04em] text-white">Tell your future self<br /><em className="text-[#ffb18e]">what matters now.</em></h2></div><button onClick={onClose} className="rounded-full p-2 text-white/40 hover:bg-white/5 hover:text-white" aria-label="Close"><X size={18} /></button></div><div className="mt-8 space-y-5"><label className="block"><span className="mb-2 block text-xs uppercase tracking-[.16em] text-white/45">What do you value?</span><Textarea value={values} onChange={event => setValues(event.target.value)} placeholder="Craft, freedom, being there for my people…" className="min-h-24 border-white/10 bg-white/[.04] text-white placeholder:text-white/25" /></label><label className="block"><span className="mb-2 block text-xs uppercase tracking-[.16em] text-white/45">What season are you in?</span><Textarea value={context} onChange={event => setContext(event.target.value)} placeholder="A few honest lines about your work, energy, or life right now…" className="min-h-24 border-white/10 bg-white/[.04] text-white placeholder:text-white/25" /></label></div><div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><Button variant="ghost" onClick={onClose} className="text-white/55 hover:bg-white/5 hover:text-white">Maybe later</Button><Button onClick={handleSave} disabled={values.length < 2 || context.length < 2 || save.isPending} className="bg-[#ff9f7a] text-[#17101b] hover:bg-[#ffb18e]">{isAuthenticated ? "Save my starting point" : "Sign in to continue"} <ArrowUpRight size={16} /></Button></div></div></div>;
}

export default function Home() {
  const { user, logout } = useAuth();
  const workspaceQuery = trpc.workspace.get.useQuery();
  const workspace = workspaceQuery.data as any;
  const projection = workspace?.projection as Projection | undefined;
  const [activeNav, setActiveNav] = useState("Overview");
  const navTargets = { Overview: "projection", Scenarios: "scenarios", "Check-in": "check-in", "Future self": "future-self" } as const;
  const scrollToSection = (id: string) => { document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const [adherence, setAdherence] = useState(85);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [scenarioName, setScenarioName] = useState("A little more consistent");
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<Array<{ role: "user" | "assistant"; content: string; typing?: boolean }>>([{ role: "assistant", content: "You’re not behind. You’re at the part where small, repeated choices begin to look like a life. What should we look at together?" }]);
  const [isTyping, setIsTyping] = useState(false);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const utils = trpc.useUtils();
  const scenarioProjectionQuery = trpc.workspace.projection.useQuery({ adherenceOverride: adherence / 100, horizonYears: 5 });
  const scenarioProjection = (scenarioProjectionQuery.data || projection) as Projection | undefined;
  const saveScenario = trpc.workspace.createScenario.useMutation({ onSuccess: () => toast.success("Scenario saved to your observatory"), onError: () => toast.error("Sign in to save scenarios") });
  const checkIn = trpc.workspace.checkIn.useMutation({ onSuccess: result => { toast.success(result.duplicate ? "That check-in is already in the archive" : "Check-in recorded — projection updated"); utils.workspace.get.invalidate(); }, onError: () => toast.error("Could not record that check-in") });
  const animateAssistant = (content: string) => { setIsTyping(true); setChatMessages(items => [...items, { role: "assistant", content: "", typing: true }]); let cursor = 0; const timer = window.setInterval(() => { cursor = Math.min(content.length, cursor + Math.max(2, Math.ceil(content.length / 70))); const visible = content.slice(0, cursor); setChatMessages(items => items.map((item, index) => index === items.length - 1 ? { ...item, content: visible, typing: cursor < content.length } : item)); if (cursor >= content.length) { window.clearInterval(timer); setIsTyping(false); } }, 24); };
  const sendChat = trpc.workspace.chat.useMutation({ onSuccess: data => animateAssistant(data.response), onError: () => animateAssistant("The projection is still here. I could not reach the reflection layer just now — try again in a moment.") });
  const realistic = scenarioProjection?.scenarios?.realistic || [];
  const optimistic = projection?.scenarios?.optimistic || [];
  const overall = useMemo(() => realistic.length ? Math.round(realistic.reduce((sum, item) => sum + item.score, 0) / realistic.length) : 68, [realistic]);
  const futureYear = new Date().getFullYear() + 5;

  const sendMessage = (content: string) => {
    if (!content || sendChat.isPending || isTyping) return;
    setChatMessages(items => [...items, { role: "user", content }]);
    setChatInput("");
    if (user) sendChat.mutate({ messages: [...chatMessages, { role: "user", content }] });
    else window.setTimeout(() => animateAssistant("Sign in and I’ll carry this question into your own projection. For now, move the consistency dial — you can watch the answer change."), 420);
  };
  const handleSend = () => sendMessage(chatInput.trim());
  const askPrompt = (prompt: string) => { scrollToSection("future-self"); setChatInput(prompt); window.setTimeout(() => sendMessage(prompt), 80); };

  if (workspaceQuery.isLoading) return <div className="min-h-screen bg-[#080a16] p-8 text-white/60"><div className="mx-auto max-w-7xl animate-pulse">Loading your observatory…</div></div>;
  return <div className="min-h-screen overflow-x-hidden bg-[#080a16] text-white selection:bg-[#ff9f7a]/30">
    <div className="pointer-events-none fixed inset-0 -z-0 opacity-70"><div className="absolute left-[6%] top-[-12%] h-[480px] w-[480px] rounded-full bg-[#5f6eff]/10 blur-[120px]" /><div className="absolute right-[-8%] top-[35%] h-[520px] w-[520px] rounded-full bg-[#ff9f7a]/[.07] blur-[140px]" /><div className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,.12)_1px,transparent_1px)] [background-size:34px_34px] opacity-[.045]" /></div>
    <header className="relative z-20 border-b border-white/[.07] bg-[#080a16]/75 backdrop-blur-xl"><div className="mx-auto flex h-[74px] max-w-[1480px] items-center justify-between px-5 sm:px-8 lg:px-12"><Wordmark /><nav className="hidden items-center gap-1 lg:flex">{["Overview", "Scenarios", "Check-in", "Future self"].map(item => <button key={item} onClick={() => { setActiveNav(item); scrollToSection(navTargets[item as keyof typeof navTargets]); }} className={`rounded-full px-4 py-2 text-xs transition ${activeNav === item ? "bg-white/10 text-white" : "text-white/42 hover:bg-white/5 hover:text-white"}`}>{item}</button>)}</nav><div className="flex items-center gap-2">{user ? <div className="hidden items-center gap-3 border-l border-white/10 pl-4 sm:flex"><div className="text-right"><p className="text-xs text-white/80">{user.name || "Your observatory"}</p><p className="text-[10px] text-white/35">{user.email || "signed in"}</p></div><button onClick={() => logout()} className="rounded-full p-2 text-white/35 hover:bg-white/5 hover:text-white" aria-label="Sign out"><LogOut size={15} /></button></div> : <Button onClick={() => startLogin()} size="sm" className="hidden rounded-full bg-[#ff9f7a] px-4 text-xs font-medium text-[#17101b] hover:bg-[#ffb18e] sm:flex">Sign in with Google <ArrowUpRight size={14} /></Button>}<button className="rounded-full p-2 text-white/65 hover:bg-white/5 lg:hidden" onClick={() => setMobileMenu(!mobileMenu)} aria-label="Open menu"><Menu size={19} /></button></div></div>{mobileMenu && <div className="border-t border-white/[.07] bg-[#0b0e1d] px-5 py-3 lg:hidden">{["Overview", "Scenarios", "Check-in", "Future self"].map(item => <button key={item} onClick={() => { setActiveNav(item); setMobileMenu(false); scrollToSection(navTargets[item as keyof typeof navTargets]); }} className="block w-full py-3 text-left text-sm text-white/70">{item}</button>)}</div>}</header>
    <main id="projection" className="relative z-10 mx-auto max-w-[1480px] px-5 py-8 sm:px-8 lg:px-12 lg:py-12">
      <section className="grid gap-5 lg:grid-cols-[1.35fr_.65fr]">
        <div className="relative min-h-[365px] overflow-hidden rounded-[32px] border border-white/[.09] bg-[#101426] p-7 sm:p-10"><div className="absolute right-[-8%] top-[-18%] h-[360px] w-[360px] rounded-full border border-[#ff9f7a]/15 shadow-[0_0_120px_rgba(255,159,122,.12)]" /><div className="absolute right-[8%] top-[11%] h-[210px] w-[210px] rounded-full border border-[#a6b6ff]/10" /><div className="absolute bottom-[-30%] left-[31%] h-[240px] w-[480px] rounded-full bg-[#ff9f7a]/[.07] blur-[80px]" /><div className="relative flex h-full flex-col justify-between"><div className="flex items-center gap-2 text-[10px] uppercase tracking-[.22em] text-[#ffb18e]"><Radio size={12} className="animate-pulse" /> your trajectory, in focus</div><div className="mt-16 max-w-[610px]"><p className="font-[family-name:var(--font-display)] text-[clamp(2.5rem,5vw,5.3rem)] leading-[.93] tracking-[-.07em] text-white">The life you’re<br /><em className="text-[#ffb18e]">already rehearsing.</em></p><p className="mt-6 max-w-[460px] text-sm leading-6 text-white/48">A five-year projection built from the things you say matter — and the patterns you actually repeat.</p></div><div className="mt-9 flex flex-wrap items-center gap-3"><Button onClick={() => setShowOnboarding(true)} className="rounded-full bg-white px-5 text-xs font-semibold text-[#101426] hover:bg-[#fff4ec]"><Sparkles size={14} className="mr-1.5" /> Refine my projection</Button><button onClick={() => { setActiveNav("Future self"); scrollToSection("future-self"); window.setTimeout(() => chatInputRef.current?.focus(), 500); }} className="group flex items-center gap-2 rounded-full px-3 py-2 text-xs text-white/55 hover:text-white">Talk to future me <ChevronRight size={14} className="transition group-hover:translate-x-1" /></button></div></div></div>
        <div className="flex min-h-[365px] flex-col justify-between rounded-[32px] border border-white/[.09] bg-[#171a30] p-7 sm:p-8"><div className="flex items-start justify-between"><div><p className="text-[10px] uppercase tracking-[.22em] text-white/38">realistic signal</p><p className="mt-4 text-6xl font-semibold tracking-[-.08em] text-white">{overall}<span className="ml-1 text-2xl text-white/25">/100</span></p></div><div className="rounded-2xl bg-[#8be3c3]/10 p-3 text-[#8be3c3]"><TrendingUp size={20} /></div></div><div><div className="flex items-center justify-between text-xs"><span className="text-white/48">clarity of this projection</span><span className="text-[#8be3c3]">{formatPercent((projection?.confidence || .71) * 100)}</span></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[.07]"><div className="h-full rounded-full bg-gradient-to-r from-[#8be3c3] to-[#a6b6ff]" style={{ width: `${(projection?.confidence || .71) * 100}%` }} /></div><p className="mt-5 text-xs leading-5 text-white/38">Every check-in narrows the distance between a hopeful guess and a useful signal.</p></div><div className="flex items-end justify-between border-t border-white/[.08] pt-5"><div><p className="text-[10px] uppercase tracking-[.16em] text-white/30">projected horizon</p><p className="mt-1 text-sm text-white/80">{futureYear} <span className="text-white/30">· five years out</span></p></div><Orbit size={28} className="text-[#ff9f7a]/50" /></div></div>
      </section>
      <section className="mt-12"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><div className="flex items-center gap-2 text-[10px] uppercase tracking-[.22em] text-white/35"><Compass size={13} /> four dimensions of a life</div><h2 className="mt-3 font-[family-name:var(--font-display)] text-3xl tracking-[-.05em] text-white sm:text-4xl">Where your momentum <em className="text-[#ffb18e]">lands.</em></h2></div><div className="flex items-center gap-2 text-xs text-white/35"><span className="h-2 w-2 rounded-full bg-[#8be3c3]" /> realistic path <button className="rounded-full p-1.5 hover:bg-white/5" aria-label="About projections"><CircleHelp size={14} /></button></div></div><div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">{realistic.map(item => <DomainCard key={item.domain} item={item} scenario="realistic" />)}</div></section>
      <section id="scenarios" className="mt-16 grid gap-5 xl:grid-cols-[1fr_.95fr]">
        <div className="rounded-[30px] border border-white/[.09] bg-[#101426] p-6 sm:p-8"><div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start"><div><p className="flex items-center gap-2 text-[10px] uppercase tracking-[.22em] text-[#a6b6ff]"><RefreshCw size={12} /> live what-if lab</p><h2 className="mt-3 font-[family-name:var(--font-display)] text-3xl tracking-[-.05em] text-white">What if you stayed<br /><em className="text-[#a6b6ff]">a little more consistent?</em></h2></div><div className="rounded-2xl border border-white/10 bg-white/[.04] px-4 py-3 text-right"><p className="text-[10px] uppercase tracking-wider text-white/35">adherence</p><p className="mt-1 text-2xl font-semibold text-white">{adherence}%</p></div></div><div className="mt-8"><div className="flex items-center justify-between text-xs text-white/40"><span>drifting</span><span>showing up</span></div><Slider value={[adherence]} onValueChange={value => setAdherence(value[0] || 85)} min={40} max={100} step={1} className="mt-4" aria-label="Consistency slider" /><div className="mt-5 flex justify-between text-[10px] uppercase tracking-wider text-white/25"><span>60% · pessimistic</span><span>85% · realistic</span><span>100% · optimistic</span></div></div><div className="mt-8 border-t border-white/[.08] pt-6"><div className="flex items-center justify-between"><div><p className="text-xs text-white/45">At {adherence}% consistency, your biggest lift is</p><p className="mt-2 text-sm font-medium text-white">{scenarioProjection?.scenarios?.realistic?.sort((a, b) => b.delta - a.delta)[0]?.domain ? domainMeta[scenarioProjection.scenarios.realistic.slice().sort((a, b) => b.delta - a.delta)[0].domain].label : "Career & craft"}</p></div><p className="text-xl font-semibold text-[#a6b6ff]">+{Math.round((scenarioProjection?.scenarios?.realistic?.slice().sort((a, b) => b.delta - a.delta)[0]?.delta || 22) - (realistic.slice().sort((a, b) => b.delta - a.delta)[0]?.delta || 0))} pts</p></div><div className="mt-5 flex gap-3"><input value={scenarioName} onChange={event => setScenarioName(event.target.value)} className="min-w-0 flex-1 rounded-full border border-white/10 bg-white/[.04] px-4 py-2.5 text-xs text-white outline-none placeholder:text-white/25 focus:border-[#a6b6ff]/60" aria-label="Scenario name" /><Button onClick={() => user ? saveScenario.mutate({ name: scenarioName, adherenceOverride: adherence / 100, assumptions: { adherence } }) : toast("Sign in to save this path")} size="sm" className="rounded-full bg-[#a6b6ff] text-[#11152a] hover:bg-[#bac6ff]"><Plus size={14} /> Save path</Button></div></div></div>
        <div id="check-in" className="rounded-[30px] border border-white/[.09] bg-[#171a30] p-6 sm:p-8"><div className="flex items-start justify-between"><div><p className="flex items-center gap-2 text-[10px] uppercase tracking-[.22em] text-[#e8b7ff]"><Flame size={12} /> the next honest step</p><h2 className="mt-3 max-w-[330px] font-[family-name:var(--font-display)] text-3xl tracking-[-.05em] text-white">Make it <em className="text-[#e8b7ff]">easy to return.</em></h2></div><div className="rounded-2xl bg-[#e8b7ff]/10 p-3 text-[#e8b7ff]"><Check size={20} /></div></div><p className="mt-7 max-w-[400px] text-sm leading-6 text-white/45">Your future self does not need a personality transplant. They need a version of today that is easier to repeat.</p><div className="mt-8 space-y-3">{(workspace?.habits || []).slice(0, 3).map((habit: any, index: number) => <div key={habit.id || index} className="flex items-center justify-between rounded-2xl border border-white/[.07] bg-white/[.03] p-3.5"><div className="flex items-center gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/[.06] text-white/55"><span className="text-xs">0{index + 1}</span></div><div><p className="text-xs text-white/80">{habit.title}</p><p className="mt-1 text-[10px] text-white/30">{habit.weeklyFrequency} times this week</p></div></div><button onClick={() => user ? checkIn.mutate({ habitId: Number(habit.id), completed: true, checkinDate: new Date() }) : toast("Sign in to record check-ins")} className="rounded-full border border-white/10 px-3 py-1.5 text-[10px] text-white/50 transition hover:border-[#8be3c3]/50 hover:text-[#8be3c3]">Check in</button></div>)}</div><button onClick={() => { setActiveNav("Check-in"); scrollToSection("check-in"); }} className="mt-6 flex items-center gap-1 text-xs text-white/40 transition hover:text-white">See all check-ins <ChevronRight size={14} /></button></div>
      </section>
      <section id="future-self" className="mt-16 grid gap-5 xl:grid-cols-[.82fr_1.18fr] scroll-mt-24">
        <div className="rounded-[30px] border border-white/[.09] bg-[#0e1223] p-6 sm:p-8"><div className="flex items-center justify-between"><div><p className="flex items-center gap-2 text-[10px] uppercase tracking-[.22em] text-[#ffb18e]"><MessageCircle size={12} /> future self correspondence</p><h2 className="mt-3 font-[family-name:var(--font-display)] text-3xl tracking-[-.05em] text-white">Ask from <em className="text-[#ffb18e]">here.</em></h2></div><div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#ffb18e]/20 bg-[#ff9f7a]/10 text-[#ffb18e]"><UserRound size={17} /></div></div><div className="mt-7 max-h-[255px] space-y-4 overflow-y-auto pr-1">{chatMessages.map((message, index) => <div key={index} className={`flex gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}><div className={`max-w-[86%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-xs leading-5 ${message.role === "user" ? "bg-[#ff9f7a] text-[#19111b]" : "bg-white/[.06] text-white/70"}`}>{message.typing && !message.content ? <span className="typing-dots"><i /><i /><i /></span> : message.content}</div></div>)}</div><div className="mt-5 flex items-end gap-2 rounded-2xl border border-white/10 bg-white/[.03] p-2"><Textarea ref={chatInputRef} value={chatInput} onChange={event => setChatInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); handleSend(); } }} placeholder="What would future you want you to notice?" className="min-h-11 resize-none border-0 bg-transparent text-xs text-white shadow-none focus-visible:ring-0" /><Button onClick={handleSend} disabled={!chatInput.trim() || sendChat.isPending} size="icon" className="h-9 w-9 shrink-0 rounded-xl bg-[#ff9f7a] text-[#19111b] hover:bg-[#ffb18e]"><Send size={15} /></Button></div><div className="mt-3 flex gap-2 overflow-x-auto pb-1">{["What am I underestimating?", "Compare my two paths", "What matters this week?"] .map(prompt => <button key={prompt} onClick={() => askPrompt(prompt)} className="whitespace-nowrap rounded-full border border-white/10 px-3 py-1.5 text-[10px] text-white/42 hover:border-white/20 hover:text-white/70">{prompt}</button>)}</div></div>
        <div className="relative overflow-hidden rounded-[30px] border border-white/[.09] bg-gradient-to-br from-[#1b1c38] to-[#101425] p-6 sm:p-8"><div className="absolute right-[-10%] top-[-25%] h-72 w-72 rounded-full border border-[#a6b6ff]/20" /><div className="absolute right-[6%] top-[12%] h-48 w-48 rounded-full border border-[#a6b6ff]/10" /><div className="relative flex h-full flex-col justify-between"><div><p className="text-[10px] uppercase tracking-[.22em] text-[#a6b6ff]">your trajectory archive</p><h2 className="mt-3 max-w-[440px] font-[family-name:var(--font-display)] text-3xl tracking-[-.05em] text-white sm:text-4xl">A future is not a<br /><em className="text-[#a6b6ff]">prediction. It’s a practice.</em></h2><p className="mt-5 max-w-[440px] text-sm leading-6 text-white/45">The model gets more useful every time you come back with evidence. Your next check-in is the smallest vote you can cast.</p></div><div className="mt-10 grid grid-cols-3 gap-3"><div className="rounded-2xl border border-white/10 bg-black/10 p-4"><p className="text-2xl font-semibold text-white">03</p><p className="mt-1 text-[10px] uppercase tracking-wider text-white/35">active habits</p></div><div className="rounded-2xl border border-white/10 bg-black/10 p-4"><p className="text-2xl font-semibold text-white">05</p><p className="mt-1 text-[10px] uppercase tracking-wider text-white/35">year horizon</p></div><div className="rounded-2xl border border-white/10 bg-black/10 p-4"><p className="text-2xl font-semibold text-white">{Math.round((projection?.confidence || .71) * 100)}%</p><p className="mt-1 text-[10px] uppercase tracking-wider text-white/35">clarity</p></div></div></div></div>
      </section>
      <footer className="mt-20 flex flex-col justify-between gap-4 border-t border-white/[.07] py-7 text-[10px] uppercase tracking-[.16em] text-white/25 sm:flex-row"><span>FutureMe · a private observatory</span><span>Projections are illustrative, not promises.</span></footer>
    </main>
    {!user && <button onClick={() => startLogin()} className="fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-full border border-[#ffb18e]/30 bg-[#171a30]/90 px-4 py-3 text-xs text-[#ffcfb8] shadow-2xl shadow-black/30 backdrop-blur hover:bg-[#242846] sm:hidden"><UserRound size={14} /> Sign in</button>}
    {showOnboarding && <OnboardingCard isAuthenticated={Boolean(user)} onClose={() => setShowOnboarding(false)} />}
  </div>;
}
