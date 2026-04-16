/**
 * Compare scan_runs across benchmark_run_ids to measure agent improvement.
 *
 * Usage:
 *   npx tsx scripts/compare-runs.ts <benchmark_id_before> <benchmark_id_after>
 *
 * Reports:
 * - Per-contract result diff (exploited vs not exploited in each run)
 * - Iteration count delta
 * - Cost delta
 * - Overall success rate before/after
 */

import { config } from "dotenv";
config();
import { createClient } from "@supabase/supabase-js";

async function main() {
  const [beforeId, afterId] = process.argv.slice(2);
  if (!beforeId || !afterId) {
    console.error("Usage: compare-runs.ts <benchmark_id_before> <benchmark_id_after>");
    process.exit(1);
  }

  const c = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

  // Fetch scan runs for each benchmark with contract details
  const { data: beforeRuns } = await c
    .from("scan_runs")
    .select("id, contract_id, found, test_passed, cost_usd, iterations, vuln_class, duration_ms, contracts(name)")
    .eq("benchmark_run_id", beforeId);

  const { data: afterRuns } = await c
    .from("scan_runs")
    .select("id, contract_id, found, test_passed, cost_usd, iterations, vuln_class, duration_ms, contracts(name)")
    .eq("benchmark_run_id", afterId);

  if (!beforeRuns?.length || !afterRuns?.length) {
    console.error(`No runs found: before=${beforeRuns?.length ?? 0}, after=${afterRuns?.length ?? 0}`);
    process.exit(1);
  }

  console.log(`\nBEFORE: ${beforeId} (${beforeRuns.length} runs)`);
  console.log(`AFTER:  ${afterId} (${afterRuns.length} runs)\n`);

  // Build contract -> run map
  const beforeMap = new Map(beforeRuns.map((r: any) => [r.contract_id, r]));
  const afterMap = new Map(afterRuns.map((r: any) => [r.contract_id, r]));

  // Compare
  console.log("Per-contract comparison:");
  console.log("─".repeat(100));
  console.log(
    "Contract".padEnd(30) +
    " | " + "Before".padEnd(18) +
    " | " + "After".padEnd(18) +
    " | " + "Δ cost".padStart(10) +
    " | " + "Δ iter".padStart(7)
  );
  console.log("─".repeat(100));

  let beforeWins = 0;
  let afterWins = 0;
  let regressions = 0;
  let improvements = 0;

  const allContractIds = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  for (const cid of allContractIds) {
    const b: any = beforeMap.get(cid);
    const a: any = afterMap.get(cid);
    const name = (a?.contracts?.name || b?.contracts?.name || "?").slice(0, 28);

    const bResult = b ? (b.found ? "✓ " + (b.vuln_class ?? "") : "✗ " + (b.vuln_class ?? "")) : "—";
    const aResult = a ? (a.found ? "✓ " + (a.vuln_class ?? "") : "✗ " + (a.vuln_class ?? "")) : "—";
    const costDelta = a && b ? (a.cost_usd - b.cost_usd).toFixed(2) : "—";
    const iterDelta = a && b ? (a.iterations - b.iterations).toString() : "—";

    if (b?.found) beforeWins++;
    if (a?.found) afterWins++;
    if (b?.found && !a?.found) regressions++;
    if (!b?.found && a?.found) improvements++;

    console.log(
      name.padEnd(30) +
      " | " + bResult.slice(0, 18).padEnd(18) +
      " | " + aResult.slice(0, 18).padEnd(18) +
      " | " + `$${costDelta}`.padStart(10) +
      " | " + iterDelta.padStart(7)
    );
  }

  console.log("─".repeat(100));
  console.log(`\nSummary:`);
  console.log(`  BEFORE: ${beforeWins}/${beforeRuns.length} exploited (${((beforeWins/beforeRuns.length)*100).toFixed(1)}%)`);
  console.log(`  AFTER:  ${afterWins}/${afterRuns.length} exploited (${((afterWins/afterRuns.length)*100).toFixed(1)}%)`);
  console.log(`  Improvements: ${improvements}`);
  console.log(`  Regressions:  ${regressions} ${regressions > 0 ? "⚠️ CRITICAL" : ""}`);

  if (regressions > 0) {
    console.log(`\n⚠️  Regressions indicate the agent upgrades BROKE contracts that previously worked.`);
    console.log(`   This is a hard signal to revert or investigate deeper before scaling.`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
