/**
 * LLM client.
 *
 * The adapter this replaces made one request to one model and returned a
 * hardcoded sentence on any failure. These tests pin the behaviours that make a
 * degraded reply distinguishable from a real one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete, extractJson, LLMError, modelChain, stream } from "./llm";

const originalKey = process.env.OPENROUTER_API_KEY;
const originalModel = process.env.OPENROUTER_MODEL;
const originalModels = process.env.OPENROUTER_MODELS;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function completion(text: string) {
  return jsonResponse({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
}

beforeEach(() => {
  vi.resetModules();
  process.env.OPENROUTER_API_KEY = "vitest-key";
  process.env.OPENROUTER_MODEL = "primary/model";
  process.env.OPENROUTER_MODELS = "";
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.OPENROUTER_MODEL;
  else process.env.OPENROUTER_MODEL = originalModel;
  if (originalModels === undefined) delete process.env.OPENROUTER_MODELS;
  else process.env.OPENROUTER_MODELS = originalModels;
});

describe("model chain", () => {
  it("tries the configured model first and keeps a catch-all last", () => {
    expect(modelChain()).toEqual(["primary/model", "openrouter/free"]);
  });

  it("honours an explicit fallback list without duplicating", async () => {
    process.env.OPENROUTER_MODELS = "fallback/one, primary/model ,fallback/two";
    const { modelChain: chain } = await import("./llm");
    expect(chain()).toEqual(["primary/model", "fallback/one", "fallback/two", "openrouter/free"]);
  });
});

describe("complete", () => {
  it("throws a typed unconfigured error rather than pretending to answer", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const { complete: run } = await import("./llm");
    await expect(run({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ kind: "unconfigured" });
    process.env.OPENROUTER_API_KEY = "vitest-key";
  });

  it("returns the text, the model that served it, and usage", async () => {
    const fetchImpl = vi.fn(async () => completion("the answer"));
    const result = await complete({ messages: [{ role: "user", content: "hi" }] }, { fetchImpl });
    expect(result.text).toBe("the answer");
    expect(result.model).toBe("primary/model");
    expect(result.attempts).toBe(1);
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 20 });
  });

  it("sends the referer and title headers when configured", async () => {
    process.env.OPENROUTER_SITE_URL = "https://example.com";
    const { complete: run } = await import("./llm");
    // eslint-disable-next-line -- re-read below
    const fetchImpl = vi.fn(async () => completion("ok"));
    await run({ messages: [{ role: "user", content: "hi" }] }, { fetchImpl });
    const headers = (fetchImpl.mock.calls[0][1].headers ?? {}) as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://example.com");
    delete process.env.OPENROUTER_SITE_URL;
  });

  it("requests JSON mode when asked", async () => {
    const fetchImpl = vi.fn(async () => completion("{}"));
    await complete({ messages: [{ role: "user", content: "hi" }], json: true }, { fetchImpl });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body)).response_format).toEqual({ type: "json_object" });
  });

  it("retries a 429 and succeeds on the next attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(completion("recovered"));
    const result = await complete({ messages: [{ role: "user", content: "hi" }] }, { fetchImpl });
    expect(result.text).toBe("recovered");
    expect(result.attempts).toBe(2);
  });

  it("retries an empty completion instead of returning blank advice", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "   " } }] }))
      .mockResolvedValueOnce(completion("real answer"));
    const result = await complete({ messages: [{ role: "user", content: "hi" }] }, { fetchImpl });
    expect(result.text).toBe("real answer");
  });

  it("falls through to the next model when the primary is exhausted", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model;
      return model === "primary/model" ? new Response("down", { status: 503 }) : completion("from fallback");
    });
    const result = await complete({ messages: [{ role: "user", content: "hi" }] }, { fetchImpl, maxAttempts: 1 });
    expect(result.text).toBe("from fallback");
    expect(result.model).toBe("openrouter/free");
  });

  it("does not retry an auth failure across the whole chain", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad key", { status: 401 }));
    await expect(complete({ messages: [{ role: "user", content: "hi" }] }, { fetchImpl })).rejects.toMatchObject({ kind: "auth" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a timeout as a typed error", async () => {
    const fetchImpl = vi.fn(() => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("aborted")), 50)));
    await expect(
      complete({ messages: [{ role: "user", content: "hi" }] }, { fetchImpl, attemptTimeoutMs: 5, maxAttempts: 1 }),
    ).rejects.toBeInstanceOf(LLMError);
  });

  it("reports every failed attempt through the onAttempt hook", async () => {
    const onAttempt = vi.fn();
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    await expect(complete({ messages: [{ role: "user", content: "hi" }] }, { fetchImpl, maxAttempts: 1, onAttempt })).rejects.toBeInstanceOf(LLMError);
    expect(onAttempt).toHaveBeenCalledTimes(2); // one per model in the chain
  });
});

describe("extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("unwraps a code fence", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("finds the object inside surrounding prose", () => {
    expect(extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it("repairs a trailing comma", () => {
    expect(extractJson('{"a":1,}')).toEqual({ a: 1 });
  });

  it("repairs smart quotes", () => {
    expect(extractJson('{“a”:“b”}')).toEqual({ a: "b" });
  });

  it("returns null rather than throwing when nothing parseable is present", () => {
    expect(extractJson("I cannot help with that.")).toBeNull();
    expect(extractJson("")).toBeNull();
  });
});

describe("stream", () => {
  function sseResponse(frames: string[]) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  it("yields deltas in order and returns the model on completion", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
      ]),
    );
    const chunks: string[] = [];
    const generator = stream({ messages: [{ role: "user", content: "hi" }] }, { fetchImpl });
    let done: any;
    for (;;) {
      const next = await generator.next();
      if (next.done) {
        done = next.value;
        break;
      }
      chunks.push(next.value.delta);
    }
    expect(chunks.join("")).toBe("Hello");
    expect(done.model).toBe("primary/model");
  });

  it("throws rather than silently yielding nothing when the provider errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const generator = stream({ messages: [{ role: "user", content: "hi" }] }, { fetchImpl });
    await expect(generator.next()).rejects.toBeInstanceOf(LLMError);
  });
});
