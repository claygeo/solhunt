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

    // Debug: log what the model returned
    console.error(`[iter ${iterations}] finish_reason=${response.finish_reason} tool_calls=${assistantMessage.tool_calls?.length ?? 0} content_len=${assistantMessage.content?.length ?? 0}`);
    if (assistantMessage.content) {
      console.error(`[iter ${iterations}] content_preview: ${assistantMessage.content.slice(0, 200)}`);
    }
    if (assistantMessage.tool_calls?.length) {
      console.error(`[iter ${iterations}] tool_call: ${assistantMessage.tool_calls[0].function.name}(${assistantMessage.tool_calls[0].function.arguments.slice(0, 100)})`);
    }

    if (assistantMessage.content) {
      lastTextOutput = assistantMessage.content;
    }

    // If no tool calls: nudge the model to use tools instead of explaining.
    // Local models often explain instead of acting.
    if (response.finish_reason !== "tool_calls" || !assistantMessage.tool_calls?.length) {
      if (iterations <= 8) {
        messages.push({ role: "assistant", content: assistantMessage.content ?? "" });

        // Context-aware nudge: if the model already analyzed the code, tell it to write the exploit
        const hasReadCode = messages.some(m =>
          m.role === "tool" && m.content?.includes("pragma solidity")
        );

        const nudge = hasReadCode
          ? `Good analysis. Now take action: use the str_replace_editor tool to create the exploit test file at test/Exploit.t.sol. Write the Solidity exploit code that demonstrates this vulnerability. Do NOT explain — use the tool to create the file.`
          : `You have tools available. Use the bash tool to read the contract: bash with command 'cat /workspace/scan/src/*.sol'`;

        messages.push({ role: "user", content: nudge });
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
