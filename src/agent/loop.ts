import {
  chatCompletion,
  type ProviderConfig,
  type Message,
  type ToolDefinition,
} from "./provider.js";
import { getToolDefinitions } from "./tools.js";
import { ToolExecutor } from "./executor.js";
import { getSystemPrompt, buildAnalysisPrompt } from "./prompts.js";
import { SandboxManager } from "../sandbox/manager.js";
import type { ExploitReport } from "../reporter/format.js";

export interface AgentConfig {
  provider: ProviderConfig;
  maxIterations: number;
  toolTimeout: number;
  scanTimeout: number;
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

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
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

    let response;
    try {
      response = await chatCompletion(config.provider, messages, tools);
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

    totalInputTokens += response.usage.prompt_tokens;
    totalOutputTokens += response.usage.completion_tokens;

    const assistantMessage = response.message;

    if (assistantMessage.content) {
      lastTextOutput = assistantMessage.content;
    }

    // If no tool calls: for early iterations, nudge the model to use tools.
    // Local models often explain instead of acting on the first try.
    if (response.finish_reason !== "tool_calls" || !assistantMessage.tool_calls?.length) {
      if (iterations <= 3) {
        // Add assistant response then nudge
        messages.push({ role: "assistant", content: assistantMessage.content ?? "" });
        messages.push({
          role: "user",
          content: "You have tools available. Please use the bash or str_replace_editor tool to read the contract source files and begin your analysis. Start by running: bash with command 'cat /workspace/scan/src/*.sol'",
        });
        continue;
      }
      break;
    }

    // Add assistant message to history
    messages.push(assistantMessage);

    // Execute each tool call and push results
    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      let toolInput: any;

      try {
        toolInput = JSON.parse(toolCall.function.arguments);
      } catch {
        toolInput = { command: toolCall.function.arguments };
      }

      onIteration?.(iterations, toolName);

      const result = await executor.execute(toolName, toolInput);

      // Truncate very long outputs to avoid filling context
      let output = result.output;
      if (output.length > 50_000) {
        output =
          output.slice(0, 25_000) +
          "\n\n... [output truncated, showing first and last 25KB] ...\n\n" +
          output.slice(-25_000);
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolName,
        content: output,
      });
    }
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
