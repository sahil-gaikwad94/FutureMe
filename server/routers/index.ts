/**
 * tRPC root.
 *
 * Split by concern so each surface can be read on its own. `system` and `health`
 * stay public for the Render health check; anything that writes is protected.
 */

import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "../_core/cookies";
import { systemRouter } from "../_core/systemRouter";
import { publicProcedure, router } from "../_core/trpc";
import { MODEL_VERSION } from "../engine/projection";
import { agentsRouter, journalRouter } from "./agents";
import { checkinsRouter, goalsRouter, stepsRouter } from "./goals";
import { projectionRouter, scenariosRouter, snapshotsRouter, workspaceRouter } from "./workspace";

export const appRouter = router({
  system: systemRouter,

  health: publicProcedure.query(() => ({
    ok: true,
    service: "futureme",
    modelVersion: MODEL_VERSION,
    timestamp: new Date().toISOString(),
  })),

  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  workspace: workspaceRouter,
  projection: projectionRouter,
  goals: goalsRouter,
  steps: stepsRouter,
  checkins: checkinsRouter,
  scenarios: scenariosRouter,
  snapshots: snapshotsRouter,
  agents: agentsRouter,
  journal: journalRouter,
});

export type AppRouter = typeof appRouter;
export { z };
