import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import chalk from "chalk";

import { SandboxManager } from "../sandbox/manager.js";
import { ForkManager } from "../sandbox/fork.js";
import { FoundryProject } from "../sandbox/foundry.js";
import { fetchContractSource } from "../ingestion/etherscan.js";
import { loadDataset, getChainId } from "../ingestion/defi-hacks.js";
import { runAgent } from "../agent/loop.js";
import { calculateCost, formatDuration } from "../reporter/format.js";
import type { ScanResult } from "../reporter/format.js";
import type { BenchmarkEntry } from "../ingestion/defi-hacks.js";

export interface BenchmarkConfig {
  datasetPath: string;
  limit?: number;
  concurrency: number;
  model: string;
  apiKey: string;
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
  console.log(`Model: ${config.model}`);
  console.log(`Concurrency: ${config.concurrency}\n`);

  const results: ScanResult[] = [];
  const sandbox = new SandboxManager();

  // Process in batches based on concurrency
  for (let i = 0; i < entries.length; i += config.concurrency) {
    const batch = entries.slice(i, i + config.concurrency);
    const batchPromises = batch.map((entry, idx) =>
      scanEntry(entry, sandbox, config, i + idx + 1, entries.length)
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

  return results;
}

async function scanEntry(
  entry: BenchmarkEntry,
  sandbox: SandboxManager,
  config: BenchmarkConfig,
  index: number,
  total: number
): Promise<ScanResult> {
  const tag = `[${index}/${total}]`;
  const scanId = randomUUID().slice(0, 8);
  let containerId: string | undefined;

  try {
    console.log(`${tag} ${entry.name} (${entry.contractAddress}) ...`);

    // Fetch source
    const chainId = getChainId(entry.chain);
    const contractInfo = await fetchContractSource(
      entry.contractAddress,
      config.etherscanKey,
      chainId
    );

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

    // Run agent
    const agentResult = await runAgent(
      {
        address: entry.contractAddress,
        name: contractInfo.name,
        chain: entry.chain,
        blockNumber: entry.blockNumber,
        sources: contractInfo.sources,
      },
      containerId,
      sandbox,
      {
        model: config.model,
        maxIterations: 30,
        toolTimeout: 60_000,
        scanTimeout: 1_800_000,
        apiKey: config.apiKey,
      }
    );

    const result: ScanResult = {
      report: agentResult.report,
      iterations: agentResult.iterations,
      cost: {
        inputTokens: agentResult.cost.inputTokens,
        outputTokens: agentResult.cost.outputTokens,
        totalUSD: calculateCost(
          config.model,
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
