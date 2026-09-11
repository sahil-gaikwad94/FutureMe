# FutureMe — Engineering Diagnosis

Audited at commit `66cb6d8`. Baseline: `pnpm check` clean, `pnpm test` 7/7 green.
**Every failure below is a design/wiring failure, not a compile error** — which is exactly
why the deployed site looks alive and behaves dead.

## Critical

| # | Finding | Evidence |
|---|---|---|
| C1 | **There are no agents.** "Build my plan" runs a hardcoded 5-item string array per domain. Zero LLM involvement, identical output for every user, every goal, forever. | `routers.ts` `createGoalPlan` → `const playbooks: Record<Domain, Array<...>>` |
| C2 | **The projection engine — the entire stated vision — is never rendered.** No chart, no band, no five-year view anywhere in the UI. | `grep -o "trpc\.[a-z.]*\.use[A-Za-z]*" client/src` → only `auth.me`, `auth.logout`, `workspace.get`, `workspace.createGoalPlan`, `workspace.chat`, `workspace.checkIn`. `workspace.projection` has **zero** callers. |
| C3 | **Goal numbers are discarded.** `createGoalPlan` writes `baseline: 0, target: 100` as literals. `weeklyHours` and the deadline are buried in a `notes` JSON string. The projection therefore computes against constants. | `routers.ts`: `.values({ userId, domain, title, baseline: 0, target: 100, notes })` |
| C4 | **Chat is fed raw DB rows.** `goal: workspace.goals[0]`, `plan: workspace.habits`, `checkins: workspace.checkins` are `JSON.stringify`'d into the system prompt — including `userId`, `createdAt`, `betaAlpha`. Token bloat, and the model has to reverse-engineer the schema. | `routers.ts` `chat` → `askOpenRouter(...)`; `openrouter.ts` system prompt |
| C5 | **The "bullshit response" is a literal constant.** One sentence, returned with HTTP 200 and indistinguishable from real advice. | `openrouter.ts`: `const FALLBACK = "I can still help you move forward..."` |
| C6 | **Chat history never rehydrates.** `workspace.get` fetches 20 stored messages; `Mentor` ignores them and seeds local state with a canned intro. Refresh = amnesia. | `Home.tsx`: `useState([{ role: "assistant", content: "I'm your practical mentor..." }])` |
| C7 | **`adherenceOverride` in chat throws away the user's workspace.** `buildProjection({}, ...)` uses built-in defaults instead of the user's goals/habits. | `routers.ts` `chat` |

## Broken by omission (built, wired to nothing)

`saveProfile`, `addGoal`, `addHabit`, `addJournal`, `createScenario`, `saveSnapshot`,
`workspace.projection` — **all exist server-side and have zero client callers.**

Consequences:
- `profiles` is never written → `workspace.profile` is always `null` → `horizonYears` is pinned to 5 forever and onboarding cannot complete.
- `scenarios` and `trajectory_snapshots` tables stay permanently empty.
- There is no edit or delete path for anything. Create-only, forever.

## Model integrity

| # | Finding | Evidence |
|---|---|---|
| M1 | **"Monte Carlo" is a sine hash.** `seeded(seed) = fract(sin(seed*12.9898)*43758.5453)`, used as a ±1 offset. Band width is `(1 - confidence) * 22 + (year/horizon)*2` — a cosmetic gradient, not a distribution. | `projection.ts` `seeded()`, `projectDomain()` |
| M2 | **No probability of target.** The one number that would make a five-year projection honest — P(hit the goal) — is not computed. | `projection.ts` |
| M3 | **Confidence ignores evidence volume.** `0.36 + adherence*0.52`. Zero check-ins and 500 check-ins at the same adherence produce identical confidence. | `projection.ts` |
| M4 | **Progress bar is a magic constant.** `progress = Math.min(100, completed * 12)`. Nine check-ins and you are at 100%, regardless of plan size. | `Home.tsx` |
| M5 | **`workspaceProjection` reads one habit per domain**, not the aggregate, and defaults finance `target` to 86 (not currency). | `routers.ts` `workspaceProjection` |

## Infrastructure

| # | Finding |
|---|---|
| I1 | No retry, no model fallback chain. Free OpenRouter models 429 constantly; one 429 = the fallback sentence. |
| I2 | No streaming. 18s hard timeout with no user feedback. |
| I3 | No structured output or validation for any agent. |
| I4 | `server/_core/llm.ts` (454 lines, retries, JSON-schema support) targets `BUILT_IN_FORGE_API_URL`, which is unset on Render — dead weight, and the reason OpenRouter got hand-rolled badly. |
| I5 | Dead template scaffolding shipped to production: `DashboardLayout.tsx` renders a sidebar of "Page 1" / "Page 2" → `/some-path`; `ComponentShowcase.tsx` (1437 lines) demos a `trpc.ai.chat` router that does not exist; `AIChatBox`, `ManusDialog`, `Map` are unreferenced. |
| I6 | `Home.tsx` is a 66-line file with single lines exceeding 3,000 characters — the whole app inlined into JSX attributes. Unreviewable and unextensible. |
| I7 | `checkIn` selects *all* rows for a habit and filters in JS to detect a duplicate day, while the unique index is on the full timestamp. |
