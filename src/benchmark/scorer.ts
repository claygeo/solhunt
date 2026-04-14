import type { ScanResult } from "../reporter/format.js";
import type { BenchmarkEntry } from "../ingestion/defi-hacks.js";

export interface BenchmarkScore {
  total: number;
  exploited: number;
  successRate: number;
  errors: number;
  classificationAccuracy: number;
  averageCostUSD: number;
  averageDurationMs: number;
  medianDurationMs: number;
  totalCostUSD: number;
  byClass: Record<
    string,
    {
      total: number;
      exploited: number;
      rate: number;
      avgCost: number;
    }
  >;
}

export function scoreResults(
  results: ScanResult[],
  dataset?: BenchmarkEntry[]
): BenchmarkScore {
  const total = results.length;
  const exploited = results.filter(
    (r) => r.report?.found && r.report.exploit.executed
  ).length;
  const errors = results.filter((r) => !!r.error).length;

  const costs = results.map((r) => r.cost.totalUSD);
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const totalCost = costs.reduce((s, c) => s + c, 0);

  // Classification accuracy: how many correctly identified the vulnerability class?
  let correctClass = 0;
  if (dataset && dataset.length === results.length) {
    for (let i = 0; i < results.length; i++) {
      const expected = dataset[i].vulnerabilityClass;
      const actual = results[i].report?.vulnerability.class;
      if (actual && normalizeClass(actual) === normalizeClass(expected)) {
        correctClass++;
      }
    }
  }

  // Group by vulnerability class
  const byClass: Record<string, { total: number; exploited: number; costs: number[] }> = {};
  for (let i = 0; i < results.length; i++) {
    const cls = dataset?.[i]?.vulnerabilityClass ?? results[i].report?.vulnerability.class ?? "unknown";
    const normalized = normalizeClass(cls);

    if (!byClass[normalized]) {
      byClass[normalized] = { total: 0, exploited: 0, costs: [] };
    }

    byClass[normalized].total++;
    byClass[normalized].costs.push(results[i].cost.totalUSD);

    if (results[i].report?.found && results[i].report?.exploit.executed) {
      byClass[normalized].exploited++;
    }
  }

  return {
    total,
    exploited,
    successRate: total > 0 ? exploited / total : 0,
    errors,
    classificationAccuracy: total > 0 ? correctClass / total : 0,
    averageCostUSD: total > 0 ? totalCost / total : 0,
    averageDurationMs: total > 0
      ? durations.reduce((s, d) => s + d, 0) / total
      : 0,
    medianDurationMs: durations.length > 0
      ? durations[Math.floor(durations.length / 2)]
      : 0,
    totalCostUSD: totalCost,
    byClass: Object.fromEntries(
      Object.entries(byClass).map(([cls, data]) => [
        cls,
        {
          total: data.total,
          exploited: data.exploited,
          rate: data.total > 0 ? data.exploited / data.total : 0,
          avgCost: data.costs.length > 0
            ? data.costs.reduce((s, c) => s + c, 0) / data.costs.length
            : 0,
        },
      ])
    ),
  };
}

function normalizeClass(cls: string): string {
  return cls
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/^(re-?entrancy|reentrancy)$/, "reentrancy")
    .replace(/^(access.?control|authorization)$/, "access-control")
    .replace(/^(integer.?overflow|overflow|underflow)$/, "integer-overflow")
    .replace(/^(price.?manipulation|oracle.?manipulation)$/, "price-manipulation")
    .replace(/^(flash.?loan)$/, "flash-loan");
}
