export type Severity = "critical" | "high" | "medium" | "low";

// Severity is based on vulnerability class + exploitability
const CLASS_BASE_SEVERITY: Record<string, Severity> = {
  "reentrancy": "critical",
  "access-control": "critical",
  "flash-loan": "high",
  "price-manipulation": "high",
  "integer-overflow": "high",
  "delegatecall": "critical",
  "unchecked-return": "medium",
  "logic-error": "high",
  "timestamp-dependence": "low",
  "front-running": "medium",
  "other": "medium",
};

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function classifySeverity(
  vulnerabilityClass: string,
  exploitExecuted: boolean,
  valueAtRisk?: string
): Severity {
  const baseSeverity = CLASS_BASE_SEVERITY[vulnerabilityClass] ?? "medium";

  // If exploit was executed successfully, bump severity up one level
  if (exploitExecuted && SEVERITY_ORDER[baseSeverity] < 4) {
    const entries = Object.entries(SEVERITY_ORDER);
    const next = entries.find(
      ([, v]) => v === SEVERITY_ORDER[baseSeverity] + 1
    );
    if (next) return next[0] as Severity;
  }

  return baseSeverity;
}

export function severityColor(severity: Severity): string {
  switch (severity) {
    case "critical": return "red";
    case "high": return "yellow";
    case "medium": return "cyan";
    case "low": return "gray";
  }
}

export function severityEmoji(severity: Severity): string {
  switch (severity) {
    case "critical": return "[CRITICAL]";
    case "high": return "[HIGH]";
    case "medium": return "[MEDIUM]";
    case "low": return "[LOW]";
  }
}
