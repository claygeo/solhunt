#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { SandboxManager } from "./sandbox/manager.js";
import { ForkManager } from "./sandbox/fork.js";
import { FoundryProject } from "./sandbox/foundry.js";
import { runPreScanRecon, formatReconForPrompt } from "./sandbox/recon.js";
import { fetchContractSource } from "./ingestion/etherscan.js";
import { runAgent } from "./agent/loop.js";
import { resolveProvider, type ProviderConfig } from "./agent/provider.js";
import { calculateCost } from "./reporter/format.js";
import { renderReport, renderBenchmarkTable } from "./reporter/markdown.js";
import type { ScanResult } from "./reporter/format.js";
import { runBenchmark } from "./benchmark/runner.js";
import { isEnabled as isStorageEnabled, DataCollector, upsertContract, insertScanRun } from "./storage/index.js";
import { hostname } from "node:os";

dotenv.config();

const program = new Command();

program
  .name("solhunt")
  .description("Autonomous AI agent for smart contract vulnerability detection")
  .version("0.1.0");

// Resolve provider config from CLI flags + env vars
function buildProviderConfig(options: { provider?: string; model?: string }): ProviderConfig {
  const providerName = options.provider ?? process.env.SOLHUNT_PROVIDER ?? "ollama";
  const config = resolveProvider(providerName);

  // Override model if specified
  if (options.model) {
    config.model = options.model;
  }

  // Inject API keys from env
  if (config.provider === "anthropic") {
    config.apiKey = process.env.ANTHROPIC_API_KEY;
  } else if (config.provider === "openai") {
    config.apiKey = process.env.OPENAI_API_KEY;
  } else if (config.provider === "openrouter") {
    config.apiKey = process.env.OPENROUTER_API_KEY;
  }

  // Validate API key for providers that need one
  if (config.provider !== "ollama" && !config.apiKey) {
    const envVar = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      custom: "API_KEY",
    }[config.provider];
    throw new Error(`${envVar} not set. Required for ${providerName} provider.`);
  }

  return config;
}

program
  .command("scan")
  .description("Scan a smart contract for vulnerabilities")
  .argument("<target>", "Contract address (0x...) or path to .sol file")
  .option("--chain <chain>", "Blockchain network", "ethereum")
  .option("--block <number>", "Block number for fork")
  .option("--provider <name>", "Model provider (ollama, openai, openrouter, anthropic)", process.env.SOLHUNT_PROVIDER ?? "ollama")
  .option("--model <model>", "Model to use (overrides provider default)")
  .option("--max-iterations <n>", "Max agent iterations", "30")
  .option("--dry-run", "Show what would happen without calling the model", false)
  .option("--json", "Output as JSON", false)
  .action(async (target, options) => {
    const etherscanKey = process.env.ETHERSCAN_API_KEY;
    if (!etherscanKey && target.startsWith("0x")) {
      console.error(chalk.red("ETHERSCAN_API_KEY not set. Needed to fetch contract source."));
      process.exit(1);
    }

    const rpcUrl = process.env.ETH_RPC_URL;
    if (!rpcUrl) {
      console.error(chalk.red("ETH_RPC_URL not set. Need an RPC endpoint for blockchain forking."));
      process.exit(1);
    }

    let providerConfig: ProviderConfig;
    try {
      providerConfig = buildProviderConfig(options);
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }

    const spinner = ora("Initializing...").start();
    const sandbox = new SandboxManager();
    const scanId = randomUUID().slice(0, 8);
    let containerId: string | undefined;

    try {
      // Check Docker
      spinner.text = "Checking Docker...";
      const healthy = await sandbox.healthCheck();
      if (!healthy) {
        spinner.fail("Docker is not running. Start Docker and try again.");
        process.exit(1);
      }

      // Fetch contract source
      let sources: { filename: string; content: string }[];
      let contractName: string;

      if (target.startsWith("0x")) {
        spinner.text = `Fetching contract source from Etherscan...`;
        const info = await fetchContractSource(target, etherscanKey!, 1);
        sources = info.sources;
        contractName = info.name;
      } else {
        // Local file
        spinner.text = `Reading ${target}...`;
        const content = readFileSync(target, "utf-8");
        const filename = target.split("/").pop() ?? "Contract.sol";
        contractName = filename.replace(".sol", "");
        sources = [{ filename, content }];
      }

      spinner.text = `Found ${sources.length} source file(s) for ${contractName}`;

      if (options.dryRun) {
        spinner.succeed("Dry run complete");
        console.log(`\nWould scan: ${contractName} (${target})`);
        console.log(`Chain: ${options.chain}`);
        console.log(`Block: ${options.block ?? "latest"}`);
        console.log(`Provider: ${providerConfig.provider}`);
        console.log(`Model: ${providerConfig.model}`);
        console.log(`Source files: ${sources.map((s) => s.filename).join(", ")}`);
        return;
      }

      // Create sandbox
      spinner.text = "Creating Docker sandbox...";
      containerId = await sandbox.createContainer(scanId, { rpcUrl });

      // Scaffold Foundry project
      spinner.text = "Scaffolding Foundry project...";
      const foundry = new FoundryProject(sandbox);
      await foundry.scaffold(containerId, rpcUrl, options.block ? parseInt(options.block) : undefined);

      // Add contract sources
      spinner.text = "Adding contract source to sandbox...";
      await foundry.addContractSource(containerId, sources);

      // Start anvil fork (skip for local files without --block)
      const needsFork = target.startsWith("0x") || options.block;
      if (needsFork) {
        spinner.text = "Starting blockchain fork...";
        const fork = new ForkManager(sandbox);
        await fork.startAnvilFork(containerId, {
          chain: options.chain,
          rpcUrl,
          blockNumber: options.block ? parseInt(options.block) : undefined,
        });
      } else {
        // Start anvil without forking (local analysis only)
        spinner.text = "Starting local anvil...";
        const fork = new ForkManager(sandbox);
        await fork.startAnvilFork(containerId, {
          chain: options.chain,
          rpcUrl: "", // empty = no fork
        });
      }

      // Build to verify sources compile
      spinner.text = "Verifying contract compiles...";
      const buildResult = await foundry.build(containerId);
      if (!buildResult.success) {
        spinner.warn("Contract has compilation warnings (proceeding anyway)");
      }

      // Pre-scan recon: gather contract state to seed the agent prompt
      let reconData: string | undefined;
      if (target.startsWith("0x")) {
        spinner.text = "Running pre-scan reconnaissance...";
        try {
          const recon = await runPreScanRecon(sandbox, containerId, target);
          reconData = formatReconForPrompt(recon);
          if (recon.rawResults.length > 0) {
            spinner.text = `Recon found ${recon.rawResults.length} data points`;
          }
        } catch (err: any) {
          // Non-fatal: agent can still discover state manually
          console.error(`Recon failed (non-fatal): ${err.message}`);
        }
      }

      // Run agent
      const collector = isStorageEnabled() ? new DataCollector() : undefined;
      collector?.setContractSource(sources);
      if (reconData) collector?.setReconData(reconData);

      spinner.text = `Agent analyzing contract (${providerConfig.provider}/${providerConfig.model})...`;
      const agentResult = await runAgent(
        {
          address: target,
          name: contractName,
          chain: options.chain,
          blockNumber: options.block ? parseInt(options.block) : undefined,
          sources,
          reconData,
        },
        containerId,
        sandbox,
        {
          provider: providerConfig,
          maxIterations: parseInt(options.maxIterations),
          toolTimeout: parseInt(process.env.SOLHUNT_TOOL_TIMEOUT ?? "60000"),
          scanTimeout: parseInt(process.env.SOLHUNT_SCAN_TIMEOUT ?? "3600000"),
        },
        (iter, tool) => {
          spinner.text = `Agent iteration ${iter}: ${tool}`;
        },
        collector
      );

      // Extract exploit code before container is destroyed
      if (containerId && collector) {
        const exploitCode = await sandbox.tryReadFile(
          containerId,
          "/workspace/scan/test/Exploit.t.sol"
        );
        collector.setExploitCode(exploitCode);
      }

      spinner.succeed("Scan complete");

      // Format result
      const scanResult: ScanResult = {
        report: agentResult.report,
        iterations: agentResult.iterations,
        cost: {
          inputTokens: agentResult.cost.inputTokens,
          outputTokens: agentResult.cost.outputTokens,
          totalUSD: calculateCost(
            providerConfig.model,
            agentResult.cost.inputTokens,
            agentResult.cost.outputTokens
          ),
        },
        durationMs: agentResult.durationMs,
        error: agentResult.error,
      };

      // Persist to Supabase (fire-and-forget)
      if (collector && target.startsWith("0x")) {
        (async () => {
          try {
            const contractId = await upsertContract({
              address: target,
              chain: options.chain,
              name: contractName,
              block_number: options.block ? parseInt(options.block) : undefined,
            });
            if (!contractId) return;
            const scanRunId = await insertScanRun({
              contract_id: contractId,
              provider: providerConfig.provider,
              model: providerConfig.model,
              found: scanResult.report?.found ?? null,
              vuln_class: scanResult.report?.vulnerability?.class,
              severity: scanResult.report?.vulnerability?.severity,
              functions: scanResult.report?.vulnerability?.functions,
              description: scanResult.report?.vulnerability?.description,
              test_passed: scanResult.report?.exploit?.executed,
              value_at_risk: scanResult.report?.exploit?.valueAtRisk,
              input_tokens: scanResult.cost.inputTokens,
              output_tokens: scanResult.cost.outputTokens,
              cost_usd: scanResult.cost.totalUSD,
              duration_ms: scanResult.durationMs,
              iterations: scanResult.iterations,
              max_iterations: parseInt(options.maxIterations),
              error: scanResult.error,
              hostname: hostname(),
            });
            if (scanRunId) await collector.flush(scanRunId);
          } catch (err: any) {
            console.error(`[storage] ${err.message}`);
          }
        })();
      }

      if (options.json) {
        console.log(JSON.stringify(scanResult, null, 2));
      } else {
        console.log(renderReport(scanResult));
      }
    } catch (err: any) {
      spinner.fail(err.message);
      process.exit(1);
    } finally {
      if (containerId) {
        await sandbox.destroyContainer(containerId).catch(() => {});
      }
    }
  });

program
  .command("benchmark")
  .description("Run agent against a dataset of known-vulnerable contracts")
  .option("--dataset <path>", "Path to benchmark dataset JSON", "./benchmark/dataset.json")
  .option("--limit <n>", "Max contracts to test")
  .option("--concurrency <n>", "Parallel scans", "3")
  .option("--provider <name>", "Model provider", process.env.SOLHUNT_PROVIDER ?? "ollama")
  .option("--model <model>", "Model to use (overrides provider default)")
  .option("--output <path>", "Output results JSON path")
  .option("--json", "Output as JSON", false)
  .action(async (options) => {
    const etherscanKey = process.env.ETHERSCAN_API_KEY;
    const rpcUrl = process.env.ETH_RPC_URL;

    if (!etherscanKey || !rpcUrl) {
      console.error(chalk.red("Missing ETHERSCAN_API_KEY or ETH_RPC_URL. Check .env file."));
      process.exit(1);
    }

    let providerConfig: ProviderConfig;
    try {
      providerConfig = buildProviderConfig(options);
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }

    try {
      const results = await runBenchmark({
        datasetPath: options.dataset,
        limit: options.limit ? parseInt(options.limit) : undefined,
        concurrency: parseInt(options.concurrency),
        provider: providerConfig,
        etherscanKey,
        rpcUrl,
        outputPath: options.output,
      });

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(renderBenchmarkTable(results));
      }
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
  });

program
  .command("health")
  .description("Check if Docker and dependencies are ready")
  .action(async () => {
    const sandbox = new SandboxManager();
    const providerName = process.env.SOLHUNT_PROVIDER ?? "ollama";

    const checks = [
      { name: "Docker", check: () => sandbox.healthCheck() },
      { name: `Provider (${providerName})`, check: async () => {
        try {
          buildProviderConfig({ provider: providerName });
          return true;
        } catch {
          return false;
        }
      }},
      { name: "ETHERSCAN_API_KEY", check: async () => !!process.env.ETHERSCAN_API_KEY },
      { name: "ETH_RPC_URL", check: async () => !!process.env.ETH_RPC_URL },
      { name: "Supabase (optional)", check: async () => isStorageEnabled() },
    ];

    console.log(chalk.bold("\nsolhunt health check\n"));

    for (const { name, check } of checks) {
      try {
        const ok = await check();
        console.log(ok ? chalk.green(`  [ok] ${name}`) : chalk.red(`  [!!] ${name}`));
      } catch {
        console.log(chalk.red(`  [!!] ${name}`));
      }
    }
    console.log("");
  });

program.parse();
