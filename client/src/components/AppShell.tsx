/**
 * Application shell.
 *
 * Replaces the template's DashboardLayout, which shipped a sidebar reading
 * "Page 1" and "Page 2" pointing at /some-path. Navigation here is derived from
 * the real route table, and the active route drives both the desktop rail and
 * the mobile bar from one source of truth.
 */

import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import {
  BookOpen,
  ClipboardCheck,
  Compass,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MessageCircle,
  Orbit,
  Settings,
  Telescope,
} from "lucide-react";
import type { ComponentType } from "react";
import { Link, useLocation } from "wouter";

export type NavItem = {
  path: string;
  label: string;
  icon: ComponentType<{ className?: string; size?: number }>;
  hint: string;
};

export const NAV_ITEMS: NavItem[] = [
  { path: "/app", label: "Today", icon: LayoutDashboard, hint: "Where things stand and what to do next" },
  { path: "/app/observatory", label: "Observatory", icon: Telescope, hint: "The five-year projection and what-if lab" },
  { path: "/app/plan", label: "Plan", icon: ListChecks, hint: "Goals, steps and check-ins" },
  { path: "/app/mentor", label: "Mentor", icon: MessageCircle, hint: "Grounded coaching, critic and review" },
  { path: "/app/review", label: "Review", icon: ClipboardCheck, hint: "Weekly assessment from your evidence" },
  { path: "/app/journal", label: "Journal", icon: BookOpen, hint: "What you noticed, in your own words" },
  { path: "/app/settings", label: "Settings", icon: Settings, hint: "Profile, horizon and data" },
];

function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[#ffb18e]/40 bg-[#ff9f7a]/10">
        <Orbit size={17} className="text-[#ffb18e]" />
        <span className="absolute h-1.5 w-1.5 rounded-full bg-[#ffcfb8] shadow-[0_0_10px_#ff9f7a]" />
      </div>
      {!compact && <span className="font-[family-name:var(--font-display)] text-base tracking-[-.03em] text-white">futureme</span>}
    </div>
  );
}

/**
 * Shown when a reply or plan came from the deterministic path rather than a
 * model. The whole point is that the user is never left guessing whether an
 * answer was reasoned from their data or invented.
 */
export function ProvenanceBadge({ source, model, degradedReason }: { source?: "model" | "deterministic" | null; model?: string; degradedReason?: string }) {
  if (!source) return null;
  if (source === "model") {
    return (
      <Badge variant="outline" className="border-emerald-300/25 bg-emerald-300/[.07] font-mono text-[9px] tracking-normal text-emerald-200/80">
        {model ? `model · ${model.split("/").pop()}` : "model"}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      title={degradedReason}
      className="cursor-help border-amber-300/25 bg-amber-300/[.07] font-mono text-[9px] tracking-normal text-amber-200/80"
    >
      computed from your data
    </Badge>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const agents = trpc.agents.status.useQuery();

  const isActive = (path: string) => (path === "/app" ? location === "/app" : location.startsWith(path));

  return (
    <div className="min-h-screen bg-[#080a16] text-white">
      <div className="pointer-events-none fixed inset-0 -z-0 opacity-60">
        <div className="absolute left-[4%] top-[-14%] h-[460px] w-[460px] rounded-full bg-[#5f6eff]/10 blur-[130px]" />
        <div className="absolute right-[-10%] top-[40%] h-[480px] w-[480px] rounded-full bg-[#ff9f7a]/[.06] blur-[150px]" />
      </div>

      <div className="relative z-10 flex min-h-screen">
        {/* Desktop rail */}
        <aside className="sticky top-0 hidden h-screen w-[236px] shrink-0 flex-col border-r border-white/[.07] bg-[#080a16]/70 px-3 py-5 backdrop-blur-xl lg:flex">
          <div className="px-2">
            <Wordmark />
          </div>

          <nav className="mt-7 flex-1 space-y-0.5">
            {NAV_ITEMS.map(item => {
              const active = isActive(item.path);
              return (
                <Link key={item.path} href={item.path}>
                  <a
                    className={cn(
                      "group flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13px] transition-colors",
                      active ? "bg-white/[.08] text-white" : "text-white/50 hover:bg-white/[.04] hover:text-white/85",
                    )}
                  >
                    <item.icon size={15} className={active ? "text-[#ffb18e]" : ""} />
                    <span>{item.label}</span>
                  </a>
                </Link>
              );
            })}
          </nav>

          <div className="space-y-3 px-1">
            {agents.data && !agents.data.modelConfigured && (
              <p className="rounded-xl border border-amber-300/20 bg-amber-300/[.06] p-2.5 text-[10px] leading-4 text-amber-200/80">
                No model key on this deployment. Agents still work, reasoning directly from your check-ins.
              </p>
            )}
            <div className="flex items-center gap-2.5 rounded-xl border border-white/[.07] bg-white/[.02] p-2">
              <Avatar className="h-8 w-8 border border-white/10">
                <AvatarFallback className="bg-white/[.06] text-xs text-white/70">{(user?.name ?? "U").charAt(0).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-white/80">{user?.name || "Signed in"}</p>
                <p className="truncate text-[10px] text-white/35">{user?.email || ""}</p>
              </div>
              <button onClick={() => logout()} aria-label="Sign out" className="rounded-lg p-1.5 text-white/35 hover:bg-white/[.06] hover:text-white">
                <LogOut size={14} />
              </button>
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile header */}
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-white/[.07] bg-[#080a16]/85 px-4 backdrop-blur-xl lg:hidden">
            <Wordmark />
            <div className="flex items-center gap-2">
              <Link href="/app/settings">
                <a className="rounded-lg p-2 text-white/45 hover:text-white" aria-label="Settings">
                  <Settings size={16} />
                </a>
              </Link>
              <button onClick={() => logout()} className="rounded-lg p-2 text-white/45 hover:text-white" aria-label="Sign out">
                <LogOut size={16} />
              </button>
            </div>
          </header>

          <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-5 sm:px-6 lg:px-8 lg:pb-10 lg:pt-8">{children}</main>

          {/* Mobile bar */}
          <nav className="fixed bottom-0 left-0 right-0 z-30 flex items-stretch justify-around border-t border-white/[.07] bg-[#080a16]/95 backdrop-blur-xl lg:hidden">
            {NAV_ITEMS.slice(0, 5).map(item => {
              const active = isActive(item.path);
              return (
                <Link key={item.path} href={item.path}>
                  <a className={cn("flex flex-1 flex-col items-center gap-1 px-1 py-2.5 text-[9px]", active ? "text-[#ffb18e]" : "text-white/40")}>
                    <item.icon size={16} />
                    <span>{item.label}</span>
                  </a>
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
  icon: Icon,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: ComponentType<{ size?: number; className?: string }>;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <p className="flex items-center gap-2 text-[10px] uppercase tracking-[.2em] text-[#ffb18e]">
            {Icon && <Icon size={13} />}
            {eyebrow}
          </p>
        )}
        <h1 className="mt-2.5 font-[family-name:var(--font-display)] text-3xl leading-tight tracking-[-.04em] text-white sm:text-4xl">{title}</h1>
        {description && <p className="mt-2.5 max-w-2xl text-sm leading-6 text-white/45">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn("rounded-[26px] border border-white/[.08] bg-[#11152a]/80 p-5 backdrop-blur-sm sm:p-6", className)}>{children}</section>;
}

export function PanelTitle({ children, icon: Icon, hint }: { children: React.ReactNode; icon?: ComponentType<{ size?: number; className?: string }>; hint?: string }) {
  return (
    <div className="mb-4">
      <p className="flex items-center gap-2 text-[10px] uppercase tracking-[.2em] text-white/40">
        {Icon && <Icon size={12} />}
        {children}
      </p>
      {hint && <p className="mt-1.5 text-xs leading-5 text-white/30">{hint}</p>}
    </div>
  );
}

export { Compass };
