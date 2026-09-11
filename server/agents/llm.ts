/**
 * OpenRouter client.
 *
 * The previous adapter made a single request to a single model and, on any
 * failure at all — 429, timeout, malformed JSON, empty completion — returned
 * one hardcoded sentence with a 200 status. That is the direct source of the
 * "bullshit responses" complaint: the user could not distinguish real advice
 * from a failure state, and free-tier rate limits hit constantly.
 *
 * This client fixes that by:
 *   - trying a chain of models, so one unavailable provider is not fatal;
 *   - retrying transient failures with backoff that honours Retry-After;
 *   - surfacing a typed error, so callers can degrade deliberately and say so;
 *   - extracting and repairing JSON, so structured agents survive a model that
 *     wraps its answer in prose or a code fence;
 *   - supporting token streaming for the chat surface.
 */

import { ENV } from "../_core/env";

export type ChatRole = "system" | "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

export type LLMErrorKind =
  | "unconfigured"
  | "rate_limited"
  | "auth"
  | "timeout"
  | "upstream"
  | "empty"
  | "aborted";

export class LLMError extends Error {
  kind: LLMErrorKind;
  status?: number;
  attempts: number;

  constructor(kind: LLMErrorKind, message: string, options: { status?: number; attempts?: number } = {}) {
    super(message);
    this.name = "LLMError";
    this.kind = kind;
    this.status = options.status;
    this.attempts = options.attempts ?? 0;
  }
}

export type CompletionRequest = {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a JSON object. Still parsed defensively. */
  json?: boolean;
  signal?: AbortSignal;
};

export type CompletionResult = {
  text: string;
  model: string;
  finishReason: string | null;
  latencyMs: number;
  attempts: number;
  usage?: { promptTokens: number; completionTokens: number };
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Model fallback chain. The configured model comes first; `openrouter/free`
 * last as a catch-all. Specific model names are deliberately not hardcoded —
 * provider catalogues change and a stale name silently breaks every agent.
 */
export function modelChain(): string[] {
  const configured = ENV.openRouterModel || "openrouter/free";
  const extra = (ENV.openRouterModels || "")
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean);
  return Array.from(new Set([configured, ...extra, "openrouter/free"]));
}

function classifyStatus(status: number): LLMErrorKind {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  return "upstream";
}

function isRetryable(kind: LLMErrorKind): boolean {
  return kind === "rate_limited" || kind === "upstream" || kind === "timeout" || kind === "empty";
}

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number.parseFloat(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0 && seconds < 30) return seconds * 1000;
  }
  // Exponential with jitter, capped. Two retries worst case ≈ 1.4s of waiting.
  return Math.min(1500, 250 * 2 ** attempt) + Math.floor(Math.random() * 150);
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${ENV.openRouterApiKey}`,
    "Content-Type": "application/json",
    ...(ENV.openRouterSiteUrl ? { "HTTP-Referer": ENV.openRouterSiteUrl } : {}),
    ...(ENV.openRouterSiteName ? { "X-Title": ENV.openRouterSiteName } : {}),
  };
}

function body(request: CompletionRequest, model: string) {
  return JSON.stringify({
    model,
    messages: request.messages,
    temperature: request.temperature ?? 0.6,
    max_tokens: request.maxTokens ?? 900,
    ...(request.json ? { response_format: { type: "json_object" } } : {}),
  });
}

type ChatChoice = { message?: { content?: string | null }; finish_reason?: string | null };
type ChatResponse = {
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
};

export type LLMClientOptions = {
  fetchImpl?: FetchLike;
  /** Per-attempt timeout. */
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  /** Called with the model that just failed, for logging and telemetry. */
  onAttempt?: (info: { model: string; attempt: number; error?: LLMError }) => void;
};

/**
 * Complete a prompt, walking the model chain and retrying transient failures.
 * Throws LLMError when every option is exhausted — callers decide the fallback.
 */
export async function complete(request: CompletionRequest, options: LLMClientOptions = {}): Promise<CompletionResult> {
  if (!ENV.openRouterApiKey) {
    throw new LLMError("unconfigured", "OPENROUTER_API_KEY is not set");
  }
  const doFetch = options.fetchImpl ?? ((input: string, init: RequestInit) => fetch(input, init));
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 25_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const chain = modelChain();
  const startedAt = Date.now();

  let attempts = 0;
  let lastError: LLMError = new LLMError("upstream", "no attempt made");

  for (let slot = 0; slot < chain.length; slot += 1) {
    const model = chain[slot];
    for (let retry = 0; retry < maxAttempts; retry += 1) {
      if (request.signal?.aborted) throw new LLMError("aborted", "request aborted", { attempts });
      attempts += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
      const onAbort = () => controller.abort();
      request.signal?.addEventListener("abort", onAbort);

      try {
        const response = await doFetch(ENDPOINT, {
          method: "POST",
          headers: headers(),
          body: body(request, model),
          signal: controller.signal,
        });

        if (!response.ok) {
          const kind = classifyStatus(response.status);
          const detail = await response.text().catch(() => "");
          lastError = new LLMError(kind, `upstream ${response.status}: ${detail.slice(0, 200)}`, { status: response.status, attempts });
          options.onAttempt?.({ model, attempt: attempts, error: lastError });
          // Auth failures will not fix themselves on another model.
          if (kind === "auth") throw lastError;
          if (!isRetryable(kind)) break;
          await sleep(retryDelayMs(retry, response.headers.get("retry-after")));
          continue;
        }

        const data = (await response.json()) as ChatResponse;
        const text = (data.choices?.[0]?.message?.content ?? "").trim();
        if (!text) {
          lastError = new LLMError("empty", "provider returned an empty completion", { attempts });
          options.onAttempt?.({ model, attempt: attempts, error: lastError });
          await sleep(retryDelayMs(retry, null));
          continue;
        }

        return {
          text,
          model: model,
          finishReason: data.choices?.[0]?.finish_reason ?? null,
          latencyMs: Date.now() - startedAt,
          attempts,
          usage: data.usage
            ? { promptTokens: data.usage.prompt_tokens ?? 0, completionTokens: data.usage.completion_tokens ?? 0 }
            : undefined,
        };
      } catch (error) {
        if (error instanceof LLMError) throw error;
        const aborted = request.signal?.aborted;
        const kind: LLMErrorKind = aborted ? "aborted" : "timeout";
        lastError = new LLMError(kind, error instanceof Error ? error.message : "request failed", { attempts });
        options.onAttempt?.({ model, attempt: attempts, error: lastError });
        if (aborted) throw lastError;
        await sleep(retryDelayMs(retry, null));
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      }
    }
  }

  throw lastError instanceof LLMError ? lastError : new LLMError("upstream", "exhausted the model chain", { attempts });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Stream a completion as text deltas.
 *
 * Yields nothing and throws LLMError if the stream never starts, so the caller
 * can fall back to a non-streaming path rather than showing an empty bubble.
 */
export async function* stream(
  request: CompletionRequest,
  options: LLMClientOptions = {},
): AsyncGenerator<{ delta: string; model: string }, { model: string; finishReason: string | null }, void> {
  if (!ENV.openRouterApiKey) throw new LLMError("unconfigured", "OPENROUTER_API_KEY is not set");
  const doFetch = options.fetchImpl ?? ((input: string, init: RequestInit) => fetch(input, init));
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 60_000;
  const chain = modelChain();
  let lastError: LLMError = new LLMError("upstream", "no attempt made");

  for (const model of chain) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      const response = await doFetch(ENDPOINT, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          model,
          messages: request.messages,
          temperature: request.temperature ?? 0.6,
          max_tokens: request.maxTokens ?? 900,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        lastError = new LLMError(classifyStatus(response.status), `stream upstream ${response.status}`, { status: response.status });
        if (classifyStatus(response.status) === "auth") throw lastError;
        continue;
      }

      let finishReason: string | null = null;
      let emitted = false;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (parsed.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason;
            if (delta) {
              emitted = true;
              yield { delta, model };
            }
          } catch {
            // A partial JSON frame at a chunk boundary; the next read completes it.
          }
        }
      }

      if (!emitted) {
        lastError = new LLMError("empty", "stream produced no content");
        continue;
      }
      return { model, finishReason };
    } catch (error) {
      if (error instanceof LLMError) throw error;
      lastError = new LLMError(request.signal?.aborted ? "aborted" : "timeout", error instanceof Error ? error.message : "stream failed");
      if (request.signal?.aborted) throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

/**
 * Extract a JSON object from a model response.
 *
 * Models routinely wrap JSON in prose or a code fence, or append a trailing
 * comma. Rather than failing the agent, find the outermost balanced object and
 * repair the common defects. Returns null when nothing parseable is present —
 * callers then use their deterministic path.
 */
export function extractJson(raw: string): unknown | null {
  const text = raw.trim();
  const candidates: string[] = [];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(text);

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function tryParse(candidate: string): unknown | null {
  const attempts = [
    candidate,
    // Trailing commas before a closing brace or bracket.
    candidate.replace(/,(\s*[}\]])/g, "$1"),
    // Smart quotes some models emit.
    candidate.replace(/[“”]/g, '"').replace(/,(\s*[}\]])/g, "$1"),
  ];
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {
      // try the next repair
    }
  }
  return null;
}

/** True when the OpenRouter key is present, so the UI can set expectations. */
export function isConfigured(): boolean {
  return Boolean(ENV.openRouterApiKey);
}
