# FutureMe

FutureMe is a private observatory for the person you are becoming. It turns goals, habits, and the words you use to describe your life into a transparent five-year projection, then lets you explore alternate paths and talk with a grounded future-self persona.

## What ships

- Deterministic domain projection engine for career, finance, health, and relationships.
- Monte Carlo-style pessimistic, realistic, and optimistic bands with explicit assumptions.
- Bayesian consistency updater for check-ins.
- Persistent PostgreSQL schema for profiles, goals, habits, journal entries, check-ins, scenarios, snapshots, and chat messages.
- Google OAuth login with signed application sessions and CSRF-protected state.
- OpenRouter adapter with configurable free-model routing and a no-AI fallback.
- Responsive, art-directed dashboard with live what-if adherence simulation and grounded chat.

## Local development

```bash
pnpm install
pnpm check
pnpm test
pnpm dev
```

The dashboard includes a safe demo workspace when no user is signed in. To enable real persistence, set `DATABASE_URL` to a PostgreSQL database and run:

```bash
pnpm db:push
```

Copy `.env.example` to `.env` and provide `JWT_SECRET`, `APP_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and (optionally) `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`. OpenRouter is server-side only. Never expose its key through a `VITE_` variable.

## Google OAuth setup

Create a Google Cloud OAuth 2.0 Web application. Add the local authorized origin and this redirect URI:

```text
http://localhost:3000/api/auth/google/callback
```

For Render, use the service URL in `APP_URL` and add:

```text
https://YOUR-SERVICE.onrender.com/api/auth/google/callback
```

Google sign-in starts at `/api/auth/google/start`. State is stored in a short-lived, HTTP-only cookie and compared before exchanging the authorization code.

## OpenRouter

Set `OPENROUTER_API_KEY` and optionally pin a currently available free model in `OPENROUTER_MODEL`. The default is `openrouter/free`, which lets OpenRouter select an available free provider. For reproducible behavior, pin a specific `:free` model after checking the current [OpenRouter free model catalog](https://openrouter.ai/collections/free-models). The product remains usable when the key is absent or a free provider is rate-limited.

## Render Web Service deployment

1. Create a Render PostgreSQL database.
2. Create a Render **Web Service** connected to this GitHub repository and the `main` branch.
3. Use Node as the runtime. Set the build command to `pnpm install --frozen-lockfile && pnpm build` and the start command to `pnpm start`.
4. Add the PostgreSQL `DATABASE_URL` from the Render database, or use Render’s “Add from database” connection variable.
5. Add these environment variables: `NODE_ENV=production`, a long random `JWT_SECRET`, `APP_URL=https://YOUR-SERVICE.onrender.com`, `OAUTH_SERVER_URL=https://api.manus.im`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, and `OPENROUTER_SITE_URL=https://YOUR-SERVICE.onrender.com`. `OAUTH_SERVER_URL` is only for the template’s optional Manus OAuth compatibility layer; Google OAuth is the active sign-in flow.
6. Deploy once, then run the migration as a Render Shell/release step with `pnpm db:push`. The migration is PostgreSQL-specific because Render Postgres is the production target.
7. Add `/healthz` as the Render health check path.
8. Add the exact Render callback URL to Google Cloud Console, redeploy if necessary, and test sign-in, onboarding, a scenario save, a check-in, and a chat message from the live URL.

The server binds to `0.0.0.0` and Render’s `PORT`. The production build serves the Vite output from the same Node process.

## Safety and model limitations

Projection values are illustrative scenario outputs, not guarantees. Finance and health values are model demonstrations, not individualized financial or medical advice. The LLM receives computed projection JSON and user-authored context; it is instructed to narrate computed state rather than invent trajectory facts.
