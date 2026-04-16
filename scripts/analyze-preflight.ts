/**
 * Analyze a Qwen pre-flight benchmark run and categorize contracts into:
 *
 * 1. CHEAP WINS: Qwen exploited successfully - skip Sonnet, save money
 * 2. HARD FAILURES: Qwen failed + hit max iterations - sandbox/inherent issue
 * 3. SONNET CANDIDATES: Qwen failed BUT made real progress (wrote test, ran forge, partial success)
 *
 * Writes a subset dataset of Sonnet candidates for targeted follow-up.
 *
 * Usage:
 *   npx tsx scripts/analyze-preflight.ts <benchmark_run_id> [--limit 20] [--out benchmark/sonnet-candidates.json]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
config();
import { createClient } from "@supabase/supabase-js";

async function main() {
  const args = process.argv.slice(2);
  const benchmarkId = args[0];
  if (!benchmarkId) {
    console.error("Usage: analyze-preflight.ts <benchmark_run_id> [--limit N] [--out path]");
    process.exit(1);
  }

  let limit = 20;
  let outPath = "benchmark/sonnet-candidates.json";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[++i]);
    else if (args[i] === "--out" && args[i + 1]) outPath = args[++i];
  }

  const c = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

  // Fetch all scan_runs for this benchmark with contract + tool_call counts
  const { data: runs, error } = await c
    .from("scan_runs")
    .select(`
      id, contract_id, found, test_passed, cost_usd, iterations, max_iterations,
      vuln_class, duration_ms, error,
      contracts(name, address, vuln_class)
    `)
    .eq("benchmark_run_id", benchmarkId);

  if (error) {
    console.error("Supabase error:", error.message);
    process.exit(1);
  }
  if (!runs?.length) {
    console.error(`No scan runs found for benchmark ${benchmarkId}`);
    process.exit(1);
  }

  console.log(`\nAnalyzing ${runs.length} scan runs from benchmark ${benchmarkId}\n`);

  const cheapWins: any[] = [];
  const hardFailures: any[] = [];
  const sonnetCandidates: any[] = [];

  for (const r of runs as any[]) {
    if (r.error) {
      hardFailures.push({ ...r, reason: `error: ${r.error.slice(0, 60)}` });
      continue;
    }
    if (r.found && r.test_passed) {
      cheapWins.push(r);
      continue;
    }
    // Hit max iterations with no result: likely stuck
    if (r.iterations >= (r.max_iterations ?? 30) - 2) {
      hardFailures.push({ ...r, reason: `hit max iterations (${r.iterations}/${r.max_iterations})` });
      continue;
    }
    // Failed but didn't hit max - this is a Sonnet candidate
    // (model gave up, maybe a smarter model can finish)
    sonnetCandidates.push(r);
  }

  // Sort candidates by iteration count descending (most effort = most likely salvageable)
  sonnetCandidates.sort((a, b) => b.iterations - a.iterations);

  console.log("=== CHEAP WINS (skip Sonnet) ===");
  console.log(`Count: ${cheapWins.length} | Total cost: $${cheapWins.reduce((s, r) => s + r.cost_usd, 0).toFixed(2)}`);
  for (const r of cheapWins.slice(0, 10)) {
    console.log(`  ✓ ${r.contracts.name.padEnd(30)} (${r.vuln_class}) $${r.cost_usd.toFixed(2)} ${r.iterations}it`);
  }
  if (cheapWins.length > 10) console.log(`  ... and ${cheapWins.length - 10} more`);

  console.log("\n=== HARD FAILURES (Sonnet probably won't help) ===");
  console.log(`Count: ${hardFailures.length} | Total cost: $${hardFailures.reduce((s, r) => s + r.cost_usd, 0).toFixed(2)}`);
  for (const r of hardFailures.slice(0, 10)) {
    console.log(`  ✗ ${(r.contracts?.name || "?").padEnd(30)} ${r.reason}`);
  }
  if (hardFailures.length > 10) console.log(`  ... and ${hardFailures.length - 10} more`);

  console.log(`\n=== SONNET CANDIDATES (top ${limit} - worth retesting) ===`);
  console.log(`Count: ${sonnetCandidates.length} | Top ${Math.min(limit, sonnetCandidates.length)} selected`);
  const topCandidates = sonnetCandidates.slice(0, limit);
  for (const r of topCandidates) {
    console.log(`  ? ${r.contracts.name.padEnd(30)} (${r.vuln_class || r.contracts.vuln_class}) ${r.iterations}it $${r.cost_usd.toFixed(2)}`);
  }

  // Write subset dataset for Sonnet targeted run
  // Need to look up full contract details from the original dataset
  const dataset: any[] = JSON.parse(readFileSync("benchmark/dataset-100.json", "utf-8"));
  const candidateAddrs = new Set(topCandidates.map(r => r.contracts.address.toLowerCase()));
  const subset = dataset.filter(c => candidateAddrs.has(c.contractAddress.toLowerCase()));

  writeFileSync(outPath, JSON.stringify(subset, null, 2));
  console.log(`\nWrote ${subset.length} candidates to ${outPath}`);

  // Estimated Sonnet cost
  const avgSonnetCost = 1.34; // our actual observed average
  console.log(`\nEstimated Sonnet cost for top ${subset.length}: $${(subset.length * avgSonnetCost).toFixed(2)}`);
  console.log(`Run command:`);
  console.log(`  npx tsx src/index.ts benchmark --dataset ${outPath} --provider openrouter --model anthropic/claude-sonnet-4 --concurrency 2 --max-budget ${Math.ceil(subset.length * 1.5)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
