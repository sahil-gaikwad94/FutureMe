import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { registerAgentStream } from "../routes/stream";
import { closeDb } from "../db";
import { ENV } from "./env";

async function isPortAvailable(port: number) {
  return new Promise<boolean>(resolve => {
    const server = net.createServer();
    server.listen(port, () => server.close(() => resolve(true)));
    server.on("error", () => resolve(false));
  });
}

/**
 * Build the Express app without binding a port.
 *
 * Kept separate from `startServer` so the HTTP surface — the health check, the
 * tRPC adapter and the SSE stream — can be exercised end to end in tests against
 * a real socket, rather than only through the tRPC caller.
 */
export function createApp(options: { staticAssets?: boolean } = {}): ReturnType<typeof express> {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ limit: "2mb", extended: true }));

  app.get("/healthz", (_req, res) =>
    res.status(200).json({
      ok: true,
      service: "futureme",
      database: ENV.databaseUrl ? "configured" : "unconfigured",
      model: ENV.openRouterApiKey ? "configured" : "unconfigured",
      timestamp: new Date().toISOString(),
    }),
  );

  registerStorageProxy(app);
  registerOAuthRoutes(app);
  registerAgentStream(app);
  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));

  if (options.staticAssets !== false) serveStatic(app);

  return app;
}

async function startServer() {
  const app = createApp({ staticAssets: false });
  const server = createServer(app);

  if (process.env.NODE_ENV === "development") await setupVite(app, server);
  else serveStatic(app);

  const preferredPort = Number(process.env.PORT || 3000);
  const port = process.env.NODE_ENV === "production" ? preferredPort : await isPortAvailable(preferredPort) ? preferredPort : preferredPort + 1;
  server.listen(port, "0.0.0.0", () => console.log(`FutureMe listening on port ${port}`));

  // Render sends SIGTERM on deploy. Draining in-flight requests and closing the
  // pool avoids the "connection terminated" errors that otherwise surface as
  // random 500s during a redeploy.
  const shutdown = (signal: string) => {
    console.log(`[Server] ${signal} received, draining`);
    server.close(async () => {
      await closeDb().catch(() => undefined);
      process.exit(0);
    });
    // Do not hang forever if a connection refuses to close.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Importing this module must not bind a port: the HTTP tests build the same app
// through createApp() and listen on an ephemeral one. Vitest sets VITEST=true.
if (!process.env.VITEST) {
  startServer().catch(error => {
    console.error("[Server] Failed to start", error);
    process.exitCode = 1;
  });
}
