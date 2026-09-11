/**
 * HTTP end-to-end tests.
 *
 * The router tests above call procedures directly. These go through a real
 * socket: Express, body parsing, the tRPC HTTP adapter, the auth middleware and
 * the SSE stream. That covers the parts a procedure call cannot — status codes,
 * content types, cookie and bearer handling, and whether the stream actually
 * flushes frames instead of buffering a whole reply.
 *
 * Authentication is a genuine session token minted by the app's own signer and
 * sent as a Bearer header, so the real `authenticateRequest` path runs.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createApp } from "./_core";
import { sdk } from "./_core/sdk";
import * as db from "./db";
import { createTestDb, seedUser, type TestDb } from "./test/db";

let harness: TestDb;
let server: Server;
let baseUrl: string;
let token: string;
let userId: number;

const goalInput = {
  title: "Get a backend engineering role",
  outcome: "Three final-round interviews by June 2027",
  currentState: "Self-taught, building side projects, no professional experience",
  deadline: "June 2027",
  domain: "career",
  weeklyHours: 6,
  baseline: 30,
  target: 90,
};

async function listen(): Promise<string> {
  const app = createApp({ staticAssets: false });
  server = await new Promise<Server>(resolve => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** tRPC GET queries encode input as a superjson batch in the `input` param. */
function queryUrl(path: string, input?: unknown) {
  const url = new URL(`${baseUrl}/api/trpc/${path}`);
  if (input !== undefined) {
    url.searchParams.set("input", JSON.stringify({ json: input }));
  }
  return url.toString();
}

beforeAll(() => {
  // The signer needs a secret; the default is fine for a local socket test.
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = "test-session-secret";
});

beforeEach(async () => {
  harness = createTestDb();
  db.setDbForTests(harness.db);
  const user = await seedUser(harness.db);
  userId = user.id;
  token = await sdk.createSessionToken(user.openId, { name: "Test User" });
  baseUrl = await listen();
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.setDbForTests(null);
});

/** Built lazily: `token` is only known once beforeEach has run. */
const auth = () => ({ Authorization: `Bearer ${token}` });

describe("GET /healthz", () => {
  it("answers 200 with the service identity", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("futureme");
    expect(body.timestamp).toBeTruthy();
  });

  it("reports configuration state without leaking the secrets", async () => {
    const body = await (await fetch(`${baseUrl}/healthz`)).json();
    expect(["configured", "unconfigured"]).toContain(body.database);
    expect(JSON.stringify(body)).not.toContain(process.env.JWT_SECRET ?? "__none__");
  });
});

describe("tRPC over HTTP", () => {
  it("serves a public query with no session", async () => {
    const response = await fetch(queryUrl("health"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.data.json.ok).toBe(true);
  });

  it("returns the signed-in user for auth.me with a bearer token", async () => {
    const response = await fetch(queryUrl("auth.me"), { headers: auth() });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.data.json.id).toBe(userId);
  });

  it("returns null for auth.me with no session rather than an error", async () => {
    const body = await (await fetch(queryUrl("auth.me"))).json();
    expect(body.result.data.json).toBeNull();
  });

  it("rejects a forged token", async () => {
    const response = await fetch(queryUrl("auth.me"), { headers: { Authorization: "Bearer not-a-real-token" } });
    const body = await response.json();
    expect(body.result.data.json).toBeNull();
  });

  it("rejects a protected mutation with no session", async () => {
    const response = await fetch(`${baseUrl}/api/trpc/goals.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: goalInput }),
    });
    // The tRPC Express adapter maps UNAUTHORIZED onto the HTTP status.
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.json.data.code).toBe("UNAUTHORIZED");
    expect((await harness.db.select().from(db.goals)).length).toBe(0);
  });

  it("creates a goal over HTTP and persists it", async () => {
    const response = await fetch(`${baseUrl}/api/trpc/goals.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ json: goalInput }),
    });
    const body = await response.json();
    expect(body.result.data.json.saved).toBe(true);
    expect((await harness.db.select().from(db.goals)).length).toBe(1);
  });

  it("returns a validation error for a malformed payload", async () => {
    const response = await fetch(`${baseUrl}/api/trpc/goals.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ json: { ...goalInput, title: "x" } }),
    });
    const body = await response.json();
    expect(body.error.json.data.code).toBe("BAD_REQUEST");
    expect((await harness.db.select().from(db.goals)).length).toBe(0);
  });

  it("serves the signed-out demo workspace for the landing page", async () => {
    const body = await (await fetch(queryUrl("workspace.get"))).json();
    expect(body.result.data.json.isDemo).toBe(true);
  });
});

describe("POST /api/agents/coach/stream", () => {
  it("requires a session", async () => {
    const response = await fetch(`${baseUrl}/api/agents/coach/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Am I on track?" }], mode: "coach" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a malformed body before authenticating anything expensive", async () => {
    const response = await fetch(`${baseUrl}/api/agents/coach/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ messages: [], mode: "coach" }),
    });
    expect(response.status).toBe(400);
  });

  it("streams frames and terminates with a done event", async () => {
    await fetch(`${baseUrl}/api/trpc/goals.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ json: goalInput }),
    });

    const response = await fetch(`${baseUrl}/api/agents/coach/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ messages: [{ role: "user", content: "Am I on track?" }], mode: "coach" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const text = await response.text();
    const events = [...text.matchAll(/event: (\w+)/g)].map(match => match[1]);
    expect(events.length).toBeGreaterThan(1);
    expect(events[events.length - 1]).toBe("done");

    // With no model key configured the stream must still deliver a real answer
    // rather than an error frame — that is the whole point of the fallback.
    const deltas = [...text.matchAll(/data: (.*)/g)].map(match => match[1]).filter(Boolean);
    const joined = deltas.join("");
    expect(joined.length).toBeGreaterThan(20);
    expect(text).toContain('"source":"deterministic"');
  });

  it("persists the exchange so a reload restores the conversation", async () => {
    await fetch(`${baseUrl}/api/trpc/goals.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ json: goalInput }),
    });
    const response = await fetch(`${baseUrl}/api/agents/coach/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ messages: [{ role: "user", content: "Am I on track?" }], mode: "coach" }),
    });
    await response.text();

    const rows = await harness.db.select().from(db.chatMessages);
    expect(rows.length).toBe(2);
    expect(rows.some((row: any) => row.role === "user")).toBe(true);
    expect(rows.some((row: any) => row.role === "assistant")).toBe(true);
  });
});

describe("routing", () => {
  it("does not expose a stack trace on an unknown API path", async () => {
    const response = await fetch(`${baseUrl}/api/trpc/does.not.exist`);
    const body = await response.json();
    expect(body.error).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("at Object.");
  });
});
