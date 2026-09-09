import { ENV } from "./_core/env";

export type ChatTurn = { role: "system" | "user" | "assistant"; content: string };

const FALLBACK = "I can still help you move forward. Choose the smallest action in your plan, do it this week, and bring back what happened. I’ll help you adjust from real evidence.";

export async function askOpenRouter(messages: ChatTurn[], context?: { projection: unknown; voice: string[]; goal?: unknown; plan?: unknown; checkins?: unknown }) {
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
              "You are FutureMe: an experienced practitioner and demanding but humane mentor who has helped people do difficult work in the real world. Your job is to help the user achieve the concrete goal in their plan.",
              "Do not give generic motivational language, vague life advice, or invented career/finance/health concepts.",
              "Always connect your answer to the user’s stated outcome, current starting point, plan steps, and latest evidence.",
              "When the user is stuck, ask at most one clarifying question and then propose one small action that can be completed this week.",
              "When the user asks whether a plan is working, define a measurable signal and a review date.",
              "Separate facts from assumptions. Name the bottleneck. Call out when the stated deadline or weekly capacity is unrealistic, then offer a smaller credible version.",
              "Do not pretend to know the user’s life. Use the evidence they provide, and ask for missing information only when it changes the decision.",
              "Be warm, direct, specific, and honest. Explain why the next step matters.",
              "Do not give medical, legal, or individualized financial advice.",
              `CURRENT GOAL: ${JSON.stringify(context?.goal ?? null)}`,
              `EXECUTION PLAN: ${JSON.stringify(context?.plan ?? [])}`,
              `SAVED CHECK-IN EVIDENCE: ${JSON.stringify(context?.checkins ?? [])}`,
              `CURRENT PROJECTION JSON (secondary signal only): ${JSON.stringify(context?.projection ?? {})}`,
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
