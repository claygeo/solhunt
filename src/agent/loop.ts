import Anthropic from "@anthropic-ai/sdk";
import { getToolDefinitions } from "./tools.js";
import { ToolExecutor } from "./executor.js";
import { getSystemPrompt, buildAnalysisPrompt } from "./prompts.js";
import { SandboxManager } from "../sandbox/manager.js";
import type { ExploitReport } from "../reporter/format.js";

export interface AgentConfig {
  model: string;
  maxIterations: number;
  toolTimeout: number;
  scanTimeout: number;
  apiKey: string;
}

export interface ScanTarget {
  address: string;
  name: string;
  chain: string;
  blockNumber?: number;
  sources: { filename: string; content: string }[];
}

export interface AgentResult {
  report: ExploitReport | null;
  rawOutput: string;
  iterations: number;
  cost: {
    inputTokens: number;
    outputTokens: number;
  };
  durationMs: number;
  error?: string;
}

export async function runAgent(
  target: ScanTarget,
  containerId: string,
  sandbox: SandboxManager,
  config: AgentConfig,
  onIteration?: (iteration: number, toolName: string) => void
): Promise<AgentResult> {
  const client = new Anthropic({ apiKey: config.apiKey });
  const executor = new ToolExecutor(sandbox, containerId, config.toolTimeout);
  const tools = getToolDefinitions();
  const systemPrompt = getSystemPrompt();

  const analysisPrompt = buildAnalysisPrompt({
    contractAddress: target.address,
    contractName: target.name,
    chain: target.chain,
    blockNumber: target.blockNumber,
    sourceFiles: target.sources,
  });

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: analysisPrompt },
  ];

  let iterations = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastTextOutput = "";
  const startTime = Date.now();
  const deadline = startTime + config.scanTimeout;

  while (iterations < config.maxIterations) {
    if (Date.now() > deadline) {
      return {
        report: null,
        rawOutput: lastTextOutput,
        iterations,
        cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        durationMs: Date.now() - startTime,
        error: `Scan timed out after ${config.scanTimeout}ms`,
      };
    }

    iterations++;

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: config.model,
        max_tokens: 16384,
        system: systemPrompt,
        tools: tools as any,
        messages,
      });
    } catch (err: any) {
      return {
        report: null,
        rawOutput: lastTextOutput,
        iterations,
        cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        durationMs: Date.now() - startTime,
        error: `API error: ${err.message}`,
      };
    }

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    // Collect text blocks and tool_use blocks
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    if (textBlocks.length > 0) {
      lastTextOutput = textBlocks.map((b) => b.text).join("\n");
    }

    // If stop_reason is "end_turn" (no more tool calls), we're done
    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
      break;
    }

    // Add assistant message with all content blocks
    messages.push({ role: "assistant", content: response.content });

    // Execute each tool call and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      onIteration?.(iterations, toolUse.name);

      const result = await executor.execute(toolUse.name, toolUse.input);

      // Truncate very long outputs to avoid filling context
      let output = result.output;
      if (output.length > 50_000) {
        output =
          output.slice(0, 25_000) +
          "\n\n... [output truncated, showing first and last 25KB] ...\n\n" +
          output.slice(-25_000);
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: output,
        is_error: result.isError,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Parse the report from the final output
  const report = parseReport(lastTextOutput, target);

  return {
    report,
    rawOutput: lastTextOutput,
    iterations,
    cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    durationMs: Date.now() - startTime,
  };
}

function parseReport(
  output: string,
  target: ScanTarget
): ExploitReport | null {
  const reportMatch = output.match(
    /===SOLHUNT_REPORT_START===\s*([\s\S]*?)\s*===SOLHUNT_REPORT_END===/
  );

  if (!reportMatch) return null;

  try {
    const data = JSON.parse(reportMatch[1]);

    return {
      contract: target.address,
      contractName: target.name,
      chain: target.chain,
      blockNumber: target.blockNumber ?? 0,
      found: data.found ?? false,
      vulnerability: {
        class: data.vulnerability?.class ?? "unknown",
        severity: data.vulnerability?.severity ?? "low",
        functions: data.vulnerability?.functions ?? [],
        description: data.vulnerability?.description ?? "",
      },
      exploit: {
        script: data.exploit?.testFile ?? "",
        executed: data.exploit?.testPassed ?? false,
        output: "",
        valueAtRisk: data.exploit?.valueAtRisk ?? "unknown",
      },
    };
  } catch {
    return null;
  }
}
