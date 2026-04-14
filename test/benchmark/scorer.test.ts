import { describe, it, expect } from "vitest";
import { scoreResults } from "../../src/benchmark/scorer.js";
import type { ScanResult } from "../../src/reporter/format.js";

function makeScanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    report: {
      contract: "0x1234",
      contractName: "Test",
      chain: "ethereum",
      blockNumber: 100,
      found: true,
      vulnerability: {
        class: "reentrancy",
        severity: "critical",
        functions: ["withdraw"],
        description: "Reentrancy in withdraw",
      },
      exploit: {
        script: "test/Exploit.t.sol",
        executed: true,
        output: "",
        valueAtRisk: "$1M",
      },
    },
    iterations: 10,
    cost: { inputTokens: 50000, outputTokens: 5000, totalUSD: 1.5 },
    durationMs: 60_000,
    ...overrides,
  };
}

describe("scoreResults", () => {
  it("calculates success rate", () => {
    const results = [
      makeScanResult(),
      makeScanResult(),
      makeScanResult({
        report: { ...makeScanResult().report!, found: false, exploit: { ...makeScanResult().report!.exploit, executed: false } },
      }),
    ];

    const score = scoreResults(results);
    expect(score.total).toBe(3);
    expect(score.exploited).toBe(2);
    expect(score.successRate).toBeCloseTo(2 / 3);
  });

  it("handles empty results", () => {
    const score = scoreResults([]);
    expect(score.total).toBe(0);
    expect(score.exploited).toBe(0);
    expect(score.successRate).toBe(0);
    expect(score.averageCostUSD).toBe(0);
  });

  it("calculates average cost", () => {
    const results = [
      makeScanResult({ cost: { inputTokens: 0, outputTokens: 0, totalUSD: 1.0 } }),
      makeScanResult({ cost: { inputTokens: 0, outputTokens: 0, totalUSD: 2.0 } }),
      makeScanResult({ cost: { inputTokens: 0, outputTokens: 0, totalUSD: 3.0 } }),
    ];

    const score = scoreResults(results);
    expect(score.averageCostUSD).toBeCloseTo(2.0);
    expect(score.totalCostUSD).toBeCloseTo(6.0);
  });

  it("counts errors", () => {
    const results = [
      makeScanResult(),
      makeScanResult({ error: "timeout" }),
      makeScanResult({ error: "API error" }),
    ];

    const score = scoreResults(results);
    expect(score.errors).toBe(2);
  });

  it("groups by vulnerability class", () => {
    const results = [
      makeScanResult(), // reentrancy, exploited
      makeScanResult(), // reentrancy, exploited
      makeScanResult({
        report: {
          ...makeScanResult().report!,
          vulnerability: {
            ...makeScanResult().report!.vulnerability,
            class: "access-control",
          },
        },
      }),
    ];

    const score = scoreResults(results);
    expect(score.byClass["reentrancy"].total).toBe(2);
    expect(score.byClass["reentrancy"].exploited).toBe(2);
    expect(score.byClass["access-control"].total).toBe(1);
  });

  it("calculates median duration", () => {
    const results = [
      makeScanResult({ durationMs: 10_000 }),
      makeScanResult({ durationMs: 20_000 }),
      makeScanResult({ durationMs: 100_000 }),
    ];

    const score = scoreResults(results);
    expect(score.medianDurationMs).toBe(20_000);
  });
});
