/**
 * Streaming coach client.
 *
 * Opens the SSE endpoint and appends deltas as they arrive. If the stream cannot
 * be established at all — a proxy that will not hold the connection, an auth
 * rejection, a network error — it falls back to the non-streaming tRPC mutation
 * so the user still gets an answer. The fallback is silent to the user but
 * visible in the returned metadata, because "the model is down" and "the model
 * is slow" need different messages.
 */

import { useCallback, useRef, useState } from "react";
import { trpc } from "./trpc";

export type CoachMode = "coach" | "critic" | "celebrate";

export type StreamState = {
  streaming: boolean;
  /** Text accumulated so far for the in-flight reply. */
  buffer: string;
  source: "model" | "deterministic" | null;
  model?: string;
  degradedReason?: string;
  groundedOn: string[];
  error?: string;
  /** True when SSE failed and the tRPC mutation produced the reply. */
  usedFallback: boolean;
};

const INITIAL: StreamState = {
  streaming: false,
  buffer: "",
  source: null,
  groundedOn: [],
  usedFallback: false,
};

export function useCoachStream() {
  const [state, setState] = useState<StreamState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  const chat = trpc.agents.chat.useMutation();

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(current => ({ ...current, streaming: false }));
  }, []);

  /**
   * Send a message. Returns the completed assistant reply so the caller can
   * commit it to its own message list in one place.
   */
  const send = useCallback(
    async (input: {
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      mode: CoachMode;
      adherenceOverride?: number;
    }): Promise<{ content: string; source: "model" | "deterministic"; model?: string; degradedReason?: string; groundedOn: string[]; usedFallback: boolean }> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ ...INITIAL, streaming: true, buffer: "" });

      let buffer = "";
      let source: "model" | "deterministic" | null = null;
      let model: string | undefined;
      let degradedReason: string | undefined;
      let groundedOn: string[] = [];

      const commit = () =>
        setState(current => ({ ...current, buffer, source, model, degradedReason, groundedOn }));

      try {
        const response = await fetch("/api/agents/coach/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ messages: input.messages, mode: input.mode, adherenceOverride: input.adherenceOverride }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`stream unavailable (${response.status})`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let raw = "";
        let currentEvent = "message";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
          const frames = raw.split("\n\n");
          raw = frames.pop() ?? "";

          for (const frame of frames) {
            let eventName = currentEvent;
            const dataLines: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
            }
            if (dataLines.length === 0) continue;
            let payload: any;
            try {
              payload = JSON.parse(dataLines.join("\n"));
            } catch {
              continue;
            }
            if (eventName === "delta" && typeof payload?.text === "string") {
              buffer += payload.text;
              commit();
            } else if (eventName === "done") {
              source = payload?.source ?? "deterministic";
              model = payload?.model;
              degradedReason = payload?.degradedReason;
              groundedOn = payload?.groundedOn ?? [];
            } else if (eventName === "error") {
              degradedReason = payload?.message;
            }
          }
        }

        if (!buffer) throw new Error("stream produced no content");
        setState({ streaming: false, buffer, source: source ?? "model", model, degradedReason, groundedOn, usedFallback: false });
        return { content: buffer, source: source ?? "model", model, degradedReason, groundedOn, usedFallback: false };
      } catch (error) {
        if (controller.signal.aborted) {
          setState(current => ({ ...current, streaming: false }));
          return { content: buffer, source: "deterministic", groundedOn: [], usedFallback: false };
        }

        // SSE is not available; use the tRPC mutation. Same grounding, same
        // provenance, no token-by-token rendering.
        try {
          const result = await chat.mutateAsync({ messages: input.messages, mode: input.mode, adherenceOverride: input.adherenceOverride });
          setState({
            streaming: false,
            buffer: result.response,
            source: result.source,
            model: result.model,
            degradedReason: result.degradedReason,
            groundedOn: result.groundedOn ?? [],
            usedFallback: true,
          });
          return {
            content: result.response,
            source: result.source,
            model: result.model,
            degradedReason: result.degradedReason,
            groundedOn: result.groundedOn ?? [],
            usedFallback: true,
          };
        } catch (fallbackError) {
          const message = fallbackError instanceof Error ? fallbackError.message : "unknown error";
          setState({ ...INITIAL, error: message });
          return { content: "", source: "deterministic", degradedReason: message, groundedOn: [], usedFallback: true };
        }
      }
    },
    [chat],
  );

  return { ...state, send, cancel, pending: chat.isPending };
}
