import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import chalk from "chalk";

import { SandboxManager } from "../sandbox/manager.js";
import { ForkManager } from "../sandbox/fork.js";
import { FoundryProject } from "../sandbox/foundry.js";
import { runPreScanRecon, formatReconForPrompt } from "../sandbox/recon.js";
import { fetchContractSource } from "../ingestion/etherscan.js";
import { loadDataset, getChainId } from "../ingestion/defi-hacks.js";
import { runAgent } from "../agent/loop.js";
import { calculateCost, formatDuration } from "../reporter/format.js";
import {
  isEnabled as isStorageEnabled,
  upsertContract,
  insertScanRun,
  insertBenchmarkRun,
  updateBenchmarkRun,
  DataCollector,
} from "../storage/index.js";
import type { ProviderConfig } from "../agent/provider.js";
import type { ScanResult } from "../reporter/format.js";
import type { BenchmarkEntry } from "../ingestion/defi-hacks.js";

export interface BenchmarkConfig {
  datasetPath: string;
  limit?: number;
  concurrency: number;
  provider: ProviderConfig;
  etherscanKey: string;
  rpcUrl: string;
  outputPath?: string;
}

export async function runBenchmark(
  config: BenchmarkConfig
): Promise<ScanResult[]> {
  const dataset = loadDataset(config.datasetPath);
  const entries = config.limit ? dataset.slice(0, config.limit) : dataset;

  console.log(chalk.bold(`\nBenchmark: ${entries.length} contracts`));
  console.log(`Provider: ${config.provider.provider}`);
  console.log(`Model: ${config.provider.model}`);
  console.log(`Concurrency: ${config.concurrency}`);
  if (isStorageEnabled()) {
    console.log(chalk.dim(`Storage: Supabase enabled`));
  }
  console.log();

  // Create benchmark_runs row if storage is enabled
  let benchmarkRunId: string | null = null;
  if (isStorageEnabled()) {
    let datasetHash: string | undefined;
    try {
      const raw = readFileSync(config.datasetPath, "utf-8");
      datasetHash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    } catch {}

    benchmarkRunId = await insertBenchmarkRun({
      provider: config.provider.provider,
      model: config.provider.model,
      dataset_hash: datasetHash,
      total: entries.length,
      exploited: 0,
      success_rate: 0,
      total_cost: 0,
      avg_cost: 0,
      errors: 0,
      hostname: hostname(),
    });
  }

  const results: ScanResult[] = [];
  const sandbox = new SandboxManager();

  // Process in batches based on concurrency
  for (let i = 0; i < entries.length; i += config.concurrency) {
    const batch = entries.slice(i, i + config.concurrency);
    const batchPromises = batch.map((entry, idx) =>
      scanEntry(entry, sandbox, config, i + idx + 1, entries.length, benchmarkRunId)
    );

    const batchResults = await Promise.allSettled(batchPromises);

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        results.push({
          report: null,
          iterations: 0,
          cost: { inputTokens: 0, outputTokens: 0, totalUSD: 0 },
          durationMs: 0,
          error: result.reason?.message ?? "Unknown error",
        });
      }
    }

    // Circuit breaker: stop if last 3 results all failed the same way
    if (results.length >= 3) {
      const last3 = results.slice(-3);
      const allNoReport = last3.every(r => !r.report && !r.error);
      const allSameError = last3.every(r => r.error) &&
        new Set(last3.map(r => r.error?.slice(0, 50))).size === 1;

      if (allNoReport) {
        console.log(chalk.red("\n[CIRCUIT BREAKER] Last 3 contracts produced no report. Stopping to avoid wasting budget."));
        console.log(chalk.red("Fix the agent loop before re-running.\n"));
        break;
      }
      if (allSameError) {
        console.log(chalk.red(`\n[CIRCUIT BREAKER] Last 3 contracts hit the same error: ${last3[0].error?.slice(0, 80)}`));
        console.log(chalk.red("Stopping to avoid wasting budget.\n"));
        break;
      }
    }

    // Save intermediate results
    if (config.outputPath) {
      writeFileSync(config.outputPath, JSON.stringify(results, null, 2));
    }
  }

  // Save final results
  if (config.outputPath) {
    writeFileSync(config.outputPath, JSON.stringify(results, null, 2));
    console.log(chalk.dim(`\nResults saved to ${config.outputPath}`));
  }

  // Update benchmark_runs with aggregate stats
  if (benchmarkRunId) {
    const exploited = results.filter(r => r.report?.found && r.report?.exploit?.executed).length;
    const totalCost = results.reduce((sum, r) => sum + r.cost.totalUSD, 0);
    const errors = results.filter(r => r.error).length;
    await updateBenchmarkRun(benchmarkRunId, {
      exploited,
      success_rate: results.length > 0 ? exploited / results.length : 0,
      total_cost: totalCost,
      avg_cost: results.length > 0 ? totalCost / results.length : 0,
      errors,
    }).catch(() => {});
  }

  return results;
}

async function scanEntry(
  entry: BenchmarkEntry,
  sandbox: SandboxManager,
  config: BenchmarkConfig,
  index: number,
  total: number,
  benchmarkRunId: string | null
): Promise<ScanResult> {
  const tag = `[${index}/${total}]`;
  const scanId = randomUUID().slice(0, 8);
  let containerId: string | undefined;
  const collector = isStorageEnabled() ? new DataCollector() : undefined;

  try {
    console.log(`${tag} ${entry.name} (${entry.contractAddress}) ...`);

    // Fetch source
    const chainId = getChainId(entry.chain);
    const contractInfo = await fetchContractSource(
      entry.contractAddress,
      config.etherscanKey,
      chainId
    );
    collector?.setContractSource(contractInfo.sources);

    // Create sandbox
    containerId = await sandbox.createContainer(scanId, {
      rpcUrl: config.rpcUrl,
    });

    // Scaffold project
    const foundry = new FoundryProject(sandbox);
    await foundry.scaffold(containerId, config.rpcUrl, entry.blockNumber);
    await foundry.addContractSource(containerId, contractInfo.sources);

    // Start fork
    const fork = new ForkManager(sandbox);
    await fork.startAnvilFork(containerId, {
      chain: entry.chain,
      rpcUrl: config.rpcUrl,
      blockNumber: entry.blockNumber,
    });

    // Pre-scan recon
    let reconData: string | undefined;
    try {
      const recon = await runPreScanRecon(sandbox, containerId, entry.contractAddress);
      reconData = formatReconForPrompt(recon);
      collector?.setReconData(reconData);
    } catch {
      // Non-fatal
    }

    // Run agent
    const agentResult = await runAgent(
      {
        address: entry.contractAddress,
        name: contractInfo.name,
        chain: entry.chain,
        blockNumber: entry.blockNumber,
        sources: contractInfo.sources,
        reconData,
      },
      containerId,
      sandbox,
      {
        provider: config.provider,
        maxIterations: 30,
        toolTimeout: 60_000,
        scanTimeout: 1_800_000,
      },
      undefined,
      collector
    );

    // Extract exploit code from container BEFORE it's destroyed
    if (containerId) {
      const exploitCode = await sandbox.tryReadFile(
        containerId,
        "/workspace/scan/test/Exploit.t.sol"
      );
      collector?.setExploitCode(exploitCode);
    }

    const result: ScanResult = {
      report: agentResult.report,
      iterations: agentResult.iterations,
      cost: {
        inputTokens: agentResult.cost.inputTokens,
        outputTokens: agentResult.cost.outputTokens,
        totalUSD: calculateCost(
          config.provider.model,
          agentResult.cost.inputTokens,
          agentResult.cost.outputTokens
        ),
      },
      durationMs: agentResult.durationMs,
      error: agentResult.error,
    };

    const status = result.report?.found
      ? chalk.green("EXPLOITED")
      : result.error
        ? chalk.red("ERROR")
        : chalk.yellow("NOT FOUND");

    console.log(
      `${tag} ${status} ${formatDuration(result.durationMs)} $${result.cost.totalUSD.toFixed(2)}`
    );

    // Persist to Supabase (fire-and-forget, after container is still alive for reads)
    if (collector) {
      persistScanResult(entry, result, config, collector, benchmarkRunId).catch(
        (err) => console.error(`[storage] persist failed: ${err.message}`)
      );
    }

    return result;
  } catch (err: any) {
    console.log(`${tag} ${chalk.red("FAILED")} ${err.message}`);
    return {
      report: null,
      iterations: 0,
      cost: { inputTokens: 0, outputTokens: 0, totalUSD: 0 },
      durationMs: 0,
      error: err.message,
    };
  } finally {
    if (containerId) {
      await sandbox.destroyContainer(containerId).catch(() => {});
    }
  }
}

async function persistScanResult(
  entry: BenchmarkEntry,
  result: ScanResult,
  config: BenchmarkConfig,
  collector: DataCollector,
  benchmarkRunId: string | null
): Promise<void> {
  // Upsert contract
  const contractId = await upsertContract({
    address: entry.contractAddress,
    chain: entry.chain,
    name: entry.name,
    block_number: entry.blockNumber,
    vuln_class: entry.vulnerabilityClass,
    description: entry.description,
    date_exploited: entry.date,
    value_impacted: entry.valueImpacted,
    reference_exploit: entry.referenceExploit,
  });
  if (!contractId) return;

  // Determine class match
  const agentClass = result.report?.vulnerability?.class?.toLowerCase();
  const expectedClass = entry.vulnerabilityClass?.toLowerCase();
  const classMatch = agentClass && expectedClass
    ? agentClass.includes(expectedClass) || expectedClass.includes(agentClass)
    : undefined;

  // Insert scan_run (without storage paths first)
  const scanRunId = await insertScanRun({
    contract_id: contractId,
    benchmark_run_id: benchmarkRunId ?? undefined,
    provider: config.provider.provider,
    model: config.provider.model,
    found: result.report?.found ?? null,
    vuln_class: result.report?.vulnerability?.class,
    severity: result.report?.vulnerability?.severity,
    functions: result.report?.vulnerability?.functions,
    description: result.report?.vulnerability?.description,
    test_passed: result.report?.exploit?.executed,
    value_at_risk: result.report?.exploit?.valueAtRisk,
    input_tokens: result.cost.inputTokens,
    output_tokens: result.cost.outputTokens,
    cost_usd: result.cost.totalUSD,
    duration_ms: result.durationMs,
    iterations: result.iterations,
    max_iterations: 30,
    error: result.error,
    class_match: classMatch,
    hostname: hostname(),
  });

  if (!scanRunId) return;

  // Flush artifacts to Storage + insert tool_calls
  const paths = await collector.flush(scanRunId);

  // Update scan_run with storage paths
  const { getClient } = await import("../storage/supabase.js");
  const sb = getClient();
  if (sb && (paths.exploitCodePath || paths.conversationPath)) {
    await sb
      .from("scan_runs")
      .update({
        exploit_code_path: paths.exploitCodePath,
        forge_output_path: paths.forgeOutputPath,
        conversation_path: paths.conversationPath,
        recon_data_path: paths.reconDataPath,
      })
      .eq("id", scanRunId)
      .then(() => {});
  }
}
