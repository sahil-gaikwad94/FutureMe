/**
 * Server-sent events endpoint for the coach.
 *
 * Streaming is not cosmetic here. The previous implementation blocked for up to
 * 18 seconds and then either rendered a full reply or a single fallback
 * sentence, with nothing in between — long enough that users assumed it was
 * broken. Token streaming makes the wait legible and lets a slow free-tier model
 * feel responsive.
 *
 * Implemented as a plain Express route rather than a tRPC subscription because
 * SSE needs no websocket upgrade, works through the Render proxy, and degrades
 * to the non-streaming tRPC mutation if the client cannot open the stream.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import * as db from "../db";
import { coachStream, extractCitedFacts } from "../agents/coach";
import { buildFactPack } from "../agents/factpack";
import { sdk } from "../_core/sdk";
import { emptyWorkspace, loadWorkspace, projectWorkspace } from "../workspace";

const bodySchema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(6000) })).min(1).max(24),
  mode: z.enum(["coach", "critic", "celebrate"]).default("coach"),
  adherenceOverride: z.number().min(0.05).max(1).optional(),
});

function send(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function registerAgentStream(app: Express): void {
  app.post("/api/agents/coach/stream", async (req: Request, res: Response) => {
    let user = null;
    try {
      user = await sdk.authenticateRequest(req);
    } catch {
      user = null;
    }

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", issues: parsed.error.issues.slice(0, 3) });
      return;
    }
    if (!user) {
      res.status(401).json({ error: "Sign in to stream a coaching reply" });
      return;
    }

    const database = await db.getDb();
    const workspace = database ? ((await loadWorkspace(database, db.tables, user.id)) ?? emptyWorkspace) : emptyWorkspace;
    const bundle = projectWorkspace(workspace, { adherenceOverride: parsed.data.adherenceOverride });
    const factPack = buildFactPack(
      { profile: workspace.profile, goals: workspace.goals, habits: workspace.habits, checkins: workspace.checkins, journal: workspace.journal },
      { composite: bundle.projection.composite, confidence: bundle.projection.confidence, horizonYears: bundle.projection.horizonYears, realistic: bundle.realistic },
    );

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Proxies buffer by default, which would defeat the point of streaming.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    let full = "";
    let source: "model" | "deterministic" = "deterministic";
    let model: string | undefined;
    let degradedReason: string | undefined;

    try {
      for await (const chunk of coachStream({ factPack, messages: parsed.data.messages, mode: parsed.data.mode, signal: controller.signal })) {
        if (chunk.delta) {
          full += chunk.delta;
          send(res, "delta", { text: chunk.delta });
        }
        if (chunk.source === "model") {
          source = "model";
          model = chunk.model ?? model;
        }
        if (chunk.degradedReason) degradedReason = chunk.degradedReason;
        if (chunk.done) break;
      }
    } catch (error) {
      send(res, "error", { message: error instanceof Error ? error.message : "stream failed" });
    }

    if (full && database) {
      const latest = parsed.data.messages[parsed.data.messages.length - 1];
      try {
        await database.insert(db.chatMessages).values([
          // meta is written explicitly on both rows, matching agents.chat. The
          // column has a database default, but this insert sits behind a
          // deliberately forgiving catch — a silent {} would hide a write
          // failure that leaves the conversation unrecoverable on reload.
          { userId: user.id, role: latest.role, content: latest.content, agent: "user", meta: {} },
          {
            userId: user.id,
            role: "assistant",
            content: full,
            agent: parsed.data.mode,
            meta: { model, fallback: source === "deterministic", groundedOn: extractCitedFacts(full) },
          },
        ]);
      } catch (error) {
        // A failed write must not discard a reply the user already read.
        console.warn("[stream] failed to persist chat message", error instanceof Error ? error.message : error);
      }
    }

    send(res, "done", { source, model, degradedReason, groundedOn: extractCitedFacts(full) });
    res.end();
  });
}
