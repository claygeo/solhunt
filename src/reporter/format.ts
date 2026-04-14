export interface ExploitReport {
  contract: string;
  contractName: string;
  chain: string;
  blockNumber: number;
  found: boolean;
  vulnerability: {
    class: string;
    severity: "critical" | "high" | "medium" | "low";
    functions: string[];
    description: string;
  };
  exploit: {
    script: string;
    executed: boolean;
    output: string;
    valueAtRisk: string;
  };
}

export interface ScanResult {
  report: ExploitReport | null;
  iterations: number;
  cost: {
    inputTokens: number;
    outputTokens: number;
    totalUSD: number;
  };
  durationMs: number;
  error?: string;
}

// Claude API pricing (per 1M tokens)
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
};

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const price = PRICING[model] ?? PRICING["claude-sonnet-4-6"];
  return (
    (inputTokens / 1_000_000) * price.input +
    (outputTokens / 1_000_000) * price.output
  );
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}
