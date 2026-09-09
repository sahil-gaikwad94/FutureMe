import { ENV } from "./_core/env";

export type ChatTurn = { role: "system" | "user" | "assistant"; content: string };

const FALLBACK = "I can still help you think this through. The projection engine is available, but the reflective model is taking a pause right now. Try asking me to compare two paths or look at one domain at a time.";

export async function askOpenRouter(messages: ChatTurn[], context?: { projection: unknown; voice: string[] }) {
  if (!ENV.openRouterApiKey) return FALLBACK;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18_000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ENV.openRouterApiKey}`,
        "Content-Type": "application/json",
        ...(ENV.openRouterSiteUrl ? { "HTTP-Referer": ENV.openRouterSiteUrl } : {}),
        ...(ENV.openRouterSiteName ? { "X-Title": ENV.openRouterSiteName } : {}),
      },
      body: JSON.stringify({
        model: ENV.openRouterModel,
        temperature: 0.72,
        max_tokens: 650,
        messages: [
          {
            role: "system",
            content: [
              "You are FutureMe, a grounded future-self advisor.",
              "Never invent trajectory numbers, goals, habits, dates, or outcomes. The projection JSON is the ground truth; narrate it, do not replace it.",
              "Be warm, direct, specific, and psychologically realistic. Give one practical next step.",
              "Do not give medical, legal, or individualized financial advice.",
              `CURRENT PROJECTION JSON: ${JSON.stringify(context?.projection ?? {})}`,
              `USER VOICE NOTES: ${context?.voice?.join(" | ") || "No voice notes yet."}`,
            ].join("\n\n"),
          },
          ...messages.slice(-10),
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[OpenRouter] upstream status ${response.status}`);
      return FALLBACK;
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() || FALLBACK;
  } catch (error) {
    console.warn("[OpenRouter] request failed", error instanceof Error ? error.message : "unknown error");
    return FALLBACK;
  } finally {
    clearTimeout(timeout);
  }
}
