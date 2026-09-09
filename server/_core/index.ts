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

async function isPortAvailable(port: number) {
  return new Promise<boolean>(resolve => {
    const server = net.createServer();
    server.listen(port, () => server.close(() => resolve(true)));
    server.on("error", () => resolve(false));
  });
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ limit: "2mb", extended: true }));
  app.get("/healthz", (_req, res) => res.status(200).json({ ok: true, service: "futureme" }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));
  if (process.env.NODE_ENV === "development") await setupVite(app, server);
  else serveStatic(app);

  const preferredPort = Number(process.env.PORT || 3000);
  const port = process.env.NODE_ENV === "production" ? preferredPort : (await isPortAvailable(preferredPort) ? preferredPort : preferredPort + 1);
  server.listen(port, "0.0.0.0", () => console.log(`FutureMe listening on port ${port}`));
}

startServer().catch(error => { console.error("[Server] Failed to start", error); process.exitCode = 1; });
