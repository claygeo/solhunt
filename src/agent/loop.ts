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

    // Trim conversation to prevent context overflow.
    // Keep: system prompt, user prompt, last 6 messages (3 assistant+tool pairs).
    // Summarize older tool results to save tokens.
    if (messages.length > 10) {
      const systemAndUser = messages.slice(0, 2); // system + analysis prompt
      const recent = messages.slice(-6); // last 3 pairs
      const middle = messages.slice(2, -6);

      // Compress middle messages: keep structure but truncate long tool outputs
      const compressed = middle.map(m => {
        if (m.role === "tool" && m.content && m.content.length > 200) {
          return { ...m, content: m.content.slice(0, 200) + "\n[... output truncated ...]" };
        }
        if (m.role === "assistant" && m.content && m.content.length > 200) {
          return { ...m, content: m.content.slice(0, 200) + "\n[... truncated ...]" };
        }
        return m;
      });

      messages.length = 0;
      messages.push(...systemAndUser, ...compressed, ...recent);
    }

    let response;
    try {
      response = await chatCompletion(config.provider, messages, tools);
    } catch (err: any) {
      // Retry once after a brief pause (handles transient connection issues)
      console.error(`[iter ${iterations}] API error (retrying): ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
      try {
        response = await chatCompletion(config.provider, messages, tools);
      } catch (retryErr: any) {
        console.error(`[iter ${iterations}] API error (fatal): ${retryErr.message}`);
        return {
          report: null,
          rawOutput: lastTextOutput,
          iterations,
          cost: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
          durationMs: Date.now() - startTime,
          error: `API error: ${retryErr.message}`,
        };
      }
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

        // Context-aware nudge based on what stage the agent is at
        const hasReadCode = messages.some(m =>
          m.role === "tool" && m.content?.includes("pragma solidity")
        );
        const hasForgeError = messages.some(m =>
          m.role === "tool" && m.name === "forge_test" && (m.content?.includes("Error") || m.content?.includes("FAIL"))
        );
        const hasForgePass = messages.some(m =>
          m.role === "tool" && m.name === "forge_test" && m.content?.includes("PASS")
        );

        let nudge: string;
        if (hasForgePass) {
          // Test passed — ask for the structured report
          nudge = `The exploit test passed. Now output your findings in the exact report format: ===SOLHUNT_REPORT_START=== { JSON } ===SOLHUNT_REPORT_END===. Include found, vulnerability class/severity/functions/description, and exploit testFile/testPassed/valueAtRisk.`;
        } else if (hasForgeError) {
          nudge = `The forge test failed. Use str_replace_editor to fix the test file at test/Exploit.t.sol. Common fixes: import the contract with 'import "../src/test-contract.sol";', ensure correct function signatures. Then run forge_test again. Do NOT explain — just fix the file.`;
        } else if (hasReadCode) {
          nudge = `Good analysis. Now take action: use the str_replace_editor tool to create the exploit test file at test/Exploit.t.sol. Write the Solidity exploit code that demonstrates this vulnerability. Do NOT explain — use the tool to create the file.`;
        } else {
          nudge = `You have tools available. Use the bash tool to read the contract: bash with command 'cat /workspace/scan/src/*.sol'`;
        }

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
