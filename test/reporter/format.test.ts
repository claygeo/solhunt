import { describe, it, expect } from "vitest";
import { calculateCost, formatDuration } from "../../src/reporter/format.js";

describe("calculateCost", () => {
  it("calculates Sonnet pricing correctly", () => {
    // Sonnet: $3/M input, $15/M output
    const cost = calculateCost("claude-sonnet-4-6", 1_000_000, 1_000_000);
    expect(cost).toBe(3 + 15);
  });

  it("calculates Opus pricing correctly", () => {
    // Opus: $15/M input, $75/M output
    const cost = calculateCost("claude-opus-4-6", 1_000_000, 1_000_000);
    expect(cost).toBe(15 + 75);
  });

  it("handles partial token counts", () => {
    // 500k input tokens with Sonnet = $1.50
    const cost = calculateCost("claude-sonnet-4-6", 500_000, 0);
    expect(cost).toBeCloseTo(1.5);
  });

  it("defaults to Sonnet pricing for unknown models", () => {
    const cost = calculateCost("unknown-model", 1_000_000, 1_000_000);
    expect(cost).toBe(3 + 15);
  });
});

describe("formatDuration", () => {
  it("formats milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms");
  });

  it("formats seconds", () => {
    expect(formatDuration(5000)).toBe("5.0s");
  });

  it("formats minutes", () => {
    expect(formatDuration(125_000)).toBe("2m 5s");
  });
});
