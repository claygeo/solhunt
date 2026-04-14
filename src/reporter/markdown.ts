import chalk from "chalk";
import { ExploitReport, ScanResult, formatDuration } from "./format.js";
import { severityColor } from "./severity.js";

export function renderReport(result: ScanResult): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold("SOLHUNT SCAN REPORT"));
  lines.push("=".repeat(60));

  if (result.error) {
    lines.push(chalk.red(`Error: ${result.error}`));
    lines.push("");
    lines.push(`Iterations: ${result.iterations}`);
    lines.push(`Duration: ${formatDuration(result.durationMs)}`);
    lines.push(`Cost: $${result.cost.totalUSD.toFixed(4)}`);
    return lines.join("\n");
  }

  if (!result.report) {
    lines.push(chalk.yellow("No structured report was produced by the agent."));
    lines.push("");
    lines.push(`Iterations: ${result.iterations}`);
    lines.push(`Duration: ${formatDuration(result.durationMs)}`);
    lines.push(`Cost: $${result.cost.totalUSD.toFixed(4)}`);
    return lines.join("\n");
  }

  const r = result.report;

  // Contract info
  lines.push(`Contract:  ${r.contractName} (${r.contract})`);
  lines.push(`Chain:     ${r.chain}`);
  lines.push(`Block:     ${r.blockNumber}`);
  lines.push("-".repeat(60));

  if (!r.found) {
    lines.push(chalk.green("No exploitable vulnerability found."));
    lines.push("");
    lines.push(r.vulnerability.description);
  } else {
    // Vulnerability details
    const color = severityColor(r.vulnerability.severity);
    const severityStr = (chalk as any)[color](
      r.vulnerability.severity.toUpperCase()
    );

    lines.push(`Severity:  ${severityStr}`);
    lines.push(`Class:     ${r.vulnerability.class}`);
    lines.push(`Functions: ${r.vulnerability.functions.join(", ") || "N/A"}`);
    lines.push("");
    lines.push(chalk.bold("Description:"));
    lines.push(r.vulnerability.description);
    lines.push("");

    // Exploit details
    lines.push(chalk.bold("Exploit:"));
    lines.push(`  Test file:    ${r.exploit.script}`);
    lines.push(
      `  Executed:     ${r.exploit.executed ? chalk.green("PASS") : chalk.red("FAIL")}`
    );
    lines.push(`  Value at risk: ${r.exploit.valueAtRisk}`);
  }

  lines.push("-".repeat(60));
  lines.push(chalk.dim(`Iterations: ${result.iterations}`));
  lines.push(chalk.dim(`Duration:   ${formatDuration(result.durationMs)}`));
  lines.push(
    chalk.dim(
      `Tokens:     ${result.cost.inputTokens.toLocaleString()} in / ${result.cost.outputTokens.toLocaleString()} out`
    )
  );
  lines.push(chalk.dim(`Cost:       $${result.cost.totalUSD.toFixed(4)}`));
  lines.push("=".repeat(60));

  return lines.join("\n");
}

export function renderBenchmarkTable(results: ScanResult[]): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold("SOLHUNT BENCHMARK RESULTS"));
  lines.push("=".repeat(70));

  // Group by vulnerability class
  const byClass = new Map<string, ScanResult[]>();
  for (const r of results) {
    const cls = r.report?.vulnerability.class ?? "unknown";
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls)!.push(r);
  }

  // Summary stats
  const total = results.length;
  const exploited = results.filter((r) => r.report?.found && r.report.exploit.executed).length;
  const totalCost = results.reduce((sum, r) => sum + r.cost.totalUSD, 0);
  const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0);
  const errors = results.filter((r) => r.error).length;

  lines.push(`Dataset:    ${total} contracts`);
  lines.push(`Total time: ${formatDuration(totalTime)}`);
  lines.push(`Total cost: $${totalCost.toFixed(2)}`);
  lines.push(`Errors:     ${errors}`);
  lines.push("");

  // Table header
  const header = "Category".padEnd(22) + "Tested".padStart(8) + "Exploited".padStart(11) + "Rate".padStart(8) + "Avg Cost".padStart(10);
  lines.push(header);
  lines.push("-".repeat(59));

  // Table rows
  for (const [cls, classResults] of byClass) {
    const tested = classResults.length;
    const found = classResults.filter((r) => r.report?.found && r.report.exploit.executed).length;
    const rate = tested > 0 ? ((found / tested) * 100).toFixed(1) + "%" : "N/A";
    const avgCost = tested > 0
      ? "$" + (classResults.reduce((s, r) => s + r.cost.totalUSD, 0) / tested).toFixed(2)
      : "N/A";

    const row = cls.padEnd(22) + tested.toString().padStart(8) + found.toString().padStart(11) + rate.padStart(8) + avgCost.padStart(10);
    lines.push(row);
  }

  lines.push("-".repeat(59));
  const totalRate = total > 0 ? ((exploited / total) * 100).toFixed(1) + "%" : "N/A";
  const totalAvgCost = total > 0 ? "$" + (totalCost / total).toFixed(2) : "N/A";
  const totalRow = "TOTAL".padEnd(22) + total.toString().padStart(8) + exploited.toString().padStart(11) + totalRate.padStart(8) + totalAvgCost.padStart(10);
  lines.push(chalk.bold(totalRow));
  lines.push("=".repeat(70));

  return lines.join("\n");
}
