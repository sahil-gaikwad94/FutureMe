/**
 * Auth gate for the `/app` routes.
 *
 * Deliberately does not auto-redirect. The template's `useAuth` hook would call
 * `startLogin()` from an effect, which mints a one-time OAuth nonce and writes a
 * state cookie — doing that unprompted on every unauthenticated visit both
 * surprises the user and, if it fires more than once, desyncs the cookie from an
 * in-flight login. Here the user chooses.
 */

import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { Button } from "@/components/ui/button";
import { Orbit } from "lucide-react";

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#080a16]">
        <div className="flex items-center gap-3 text-sm text-white/40">
          <Orbit size={18} className="animate-spin text-[#ffb18e]/60" />
          Checking your session…
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#080a16] px-5">
        <div className="w-full max-w-sm rounded-[28px] border border-white/[.08] bg-[#11152a]/80 p-8 text-center backdrop-blur">
          <div className="relative mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-[#ffb18e]/40 bg-[#ff9f7a]/10">
            <Orbit size={22} className="text-[#ffb18e]" />
            <span className="absolute h-1.5 w-1.5 rounded-full bg-[#ffcfb8] shadow-[0_0_12px_#ff9f7a]" />
          </div>
          <h1 className="mt-5 font-[family-name:var(--font-display)] text-2xl tracking-[-.04em] text-white">Sign in to continue</h1>
          <p className="mt-2.5 text-sm leading-6 text-white/45">
            Your goals, check-ins and projection are stored against your account. Nothing is shared anywhere.
          </p>
          <Button onClick={() => startLogin()} className="mt-6 w-full rounded-full bg-[#ff9f7a] text-sm font-semibold text-[#17101b] hover:bg-[#ffb18e]">
            Continue with Google
          </Button>
          <a href="/" className="mt-4 inline-block text-xs text-white/35 hover:text-white/70">
            Back to the overview
          </a>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
