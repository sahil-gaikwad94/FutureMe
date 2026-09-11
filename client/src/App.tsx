/**
 * Route table.
 *
 * The app previously had three routes: `/`, `/404`, and a catch-all. The whole
 * product was one page. Everything under `/app` is now behind the auth gate, and
 * the landing page is what a signed-out visitor gets.
 */

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Orbit } from "lucide-react";
import { lazy, Suspense } from "react";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Landing from "./pages/Landing";
import AuthGate from "./components/AuthGate";
import AppShell from "./components/AppShell";

/**
 * Route-level code splitting.
 *
 * The chart library and markdown renderer are only needed once a user is inside
 * the app, so nothing below is in the landing bundle. Without this the initial
 * download carried recharts and its transitive graph for a page that draws one
 * chart.
 */
const Observatory = lazy(() => import("./pages/Observatory"));
const Overview = lazy(() => import("./pages/Overview"));
const PlanPage = lazy(() => import("./pages/PlanPage"));
const Mentor = lazy(() => import("./pages/Mentor"));
const ReviewPage = lazy(() => import("./pages/ReviewPage"));
const JournalPage = lazy(() => import("./pages/JournalPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

function RouteFallback() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex items-center gap-3 text-sm text-white/35">
        <Orbit size={18} className="animate-spin text-[#ffb18e]/60" />
        Loading…
      </div>
    </div>
  );
}

/** Auth gate + shell + lazy page, so the wrapper is not repeated per route. */
function AppRoute({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <AppShell>
        <Suspense fallback={<RouteFallback />}>{children}</Suspense>
      </AppShell>
    </AuthGate>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/app">
        <AppRoute>
          <Overview />
        </AppRoute>
      </Route>
      <Route path="/app/observatory">
        <AppRoute>
          <Observatory />
        </AppRoute>
      </Route>
      <Route path="/app/plan">
        <AppRoute>
          <PlanPage />
        </AppRoute>
      </Route>
      <Route path="/app/mentor">
        <AppRoute>
          <Mentor />
        </AppRoute>
      </Route>
      <Route path="/app/review">
        <AppRoute>
          <ReviewPage />
        </AppRoute>
      </Route>
      <Route path="/app/journal">
        <AppRoute>
          <JournalPage />
        </AppRoute>
      </Route>
      <Route path="/app/settings">
        <AppRoute>
          <SettingsPage />
        </AppRoute>
      </Route>
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster theme="dark" position="top-right" toastOptions={{ style: { background: "#11152a", border: "1px solid rgba(255,255,255,.1)", color: "#f7f3f0" } }} />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
