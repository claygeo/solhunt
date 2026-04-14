import { describe, it, expect } from "vitest";
import { resolveProvider, PRESETS } from "../../src/agent/provider.js";

describe("resolveProvider", () => {
  it("resolves ollama preset", () => {
    const config = resolveProvider("ollama");
    expect(config.provider).toBe("ollama");
    expect(config.model).toBe("qwen2.5-coder:32b-8k");
    expect(config.baseUrl).toContain("localhost:11434");
  });

  it("resolves ollama-small preset", () => {
    const config = resolveProvider("ollama-small");
    expect(config.provider).toBe("ollama");
    expect(config.model).toBe("qwen2.5-coder:7b");
  });

  it("resolves openai preset", () => {
    const config = resolveProvider("openai");
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
    expect(config.baseUrl).toContain("api.openai.com");
  });

  it("resolves anthropic preset", () => {
    const config = resolveProvider("anthropic");
    expect(config.provider).toBe("anthropic");
    expect(config.model).toContain("claude");
  });

  it("throws on unknown provider", () => {
    expect(() => resolveProvider("fakeprovider")).toThrow("Unknown provider");
  });

  it("allows overrides", () => {
    const config = resolveProvider("ollama", { model: "llama3:8b" });
    expect(config.model).toBe("llama3:8b");
    expect(config.provider).toBe("ollama");
  });

  it("all presets have required fields", () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(preset.provider).toBeTruthy();
      expect(preset.model).toBeTruthy();
      expect(preset.baseUrl).toBeTruthy();
    }
  });
});
