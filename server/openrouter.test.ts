import { describe, expect, it } from "vitest";
import { askOpenRouter } from "./openrouter";

describe("OpenRouter adapter", () => {
  it("returns a useful fallback when no API key is configured", async () => {
    const response = await askOpenRouter([{ role: "user", content: "What should I notice?" }], { projection: {}, voice: [] });
    expect(response).toContain("smallest action");
  });
});
