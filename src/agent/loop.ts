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
import type { DataCollector } from "../storage/collector.js";
import { summarizeToolCall } from "../storage/collector.js";

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
  reconData?: string;
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
  onIteration?: (iteration: number, toolName: string) => void,
  collector?: DataCollector
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
    reconData: target.reconData,
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

    // If no tool calls: check if the model already produced the report, otherwise nudge.
    if (response.finish_reason !== "tool_calls" || !assistantMessage.tool_calls?.length) {
      // If the response contains the report markers, we're done — don't nudge
      if (lastTextOutput.includes("===SOLHUNT_REPORT_START===")) {
        break;
      }

      const iterationsLeft = config.maxIterations - iterations;

      // Near the end (last 3 iterations) with no report: force it
      if (iterationsLeft <= 3) {
        messages.push({ role: "assistant", content: assistantMessage.content || "(no output)" });
        const hasForgePass = messages.some(m =>
          m.role === "tool" && m.name === "forge_test" && m.content?.includes("PASS")
        );
        const reportNudge = hasForgePass
          ? `FINAL ITERATION. Your exploit test PASSED. You MUST now output your structured report. Do NOT call any more tools. Output ONLY this format:\n\n===SOLHUNT_REPORT_START===\n{ "found": true, "vulnerability": { "class": "...", "severity": "...", "functions": [...], "description": "..." }, "exploit": { "testFile": "test/Exploit.t.sol", "testPassed": true, "valueAtRisk": "..." } }\n===SOLHUNT_REPORT_END===`
          : `FINAL ITERATION. You MUST now output your findings report. Do NOT call any more tools. Output ONLY this format:\n\n===SOLHUNT_REPORT_START===\n{ "found": false, "vulnerability": { "class": "...", "severity": "...", "functions": [...], "description": "Describe what you analyzed and why exploitation was not possible" }, "exploit": { "testFile": "", "testPassed": false, "valueAtRisk": "unknown" } }\n===SOLHUNT_REPORT_END===`;
        messages.push({ role: "user", content: reportNudge });
        continue;
      }

      // Still have budget: context-aware nudge
      messages.push({ role: "assistant", content: assistantMessage.content || "(no output)" });

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
        nudge = `The exploit test passed. Now output your findings in the exact report format: ===SOLHUNT_REPORT_START=== { JSON } ===SOLHUNT_REPORT_END===. Include found, vulnerability class/severity/functions/description, and exploit testFile/testPassed/valueAtRisk.`;
      } else if (hasForgeError) {
        nudge = `The forge test failed. Read the error carefully and use str_replace_editor to REWRITE test/Exploit.t.sol. Remember: use interfaces only (no src/ imports), pragma solidity ^0.8.20, and target the contract at its real address on the fork. Do NOT explain — just fix the file and run forge_test again.`;
      } else if (hasReadCode) {
        nudge = `STOP READING. You have enough context. Write the exploit NOW. Use str_replace_editor to create test/Exploit.t.sol with a minimal interface targeting the real contract address on the fork. Do NOT import from src/. Do NOT run more cast commands. WRITE THE TEST.`;
      } else {
        nudge = `Use bash to list files: ls src/ — then read the main contract. You have limited iterations, so read quickly and write the exploit test early.`;
      }

      messages.push({ role: "user", content: nudge });
      continue;
    }

    // Force report when approaching max iterations.
    // This fixes models like Claude that ONLY return tool_calls and never text,
    // so the nudge system (which requires finish_reason !== "tool_calls") never fires.
    const iterationsLeft = config.maxIterations - iterations;
    if (iterationsLeft <= 3) {
      messages.push(assistantMessage);
      collector?.recordMessage(assistantMessage);

      // Execute tool calls first so the model sees results
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        let toolInput: any;
        try {
          toolInput = JSON.parse(toolCall.function.arguments);
        } catch {
          toolInput = { command: toolCall.function.arguments };
        }
        onIteration?.(iterations, toolName);
        const toolStart = Date.now();
        const result = await executor.execute(toolName, toolInput);
        collector?.recordToolCall(iterations, toolName, Date.now() - toolStart, result.isError ?? false, summarizeToolCall(toolName, toolInput));
        let output = result.output;
        if (output.length > 50_000) {
          output = output.slice(0, 25_000) + "\n\n... [truncated] ...\n\n" + output.slice(-25_000);
        }
        const toolMsg: Message = { role: "tool", tool_call_id: toolCall.id, name: toolName, content: output };
        messages.push(toolMsg);
        collector?.recordMessage(toolMsg);
      }

      // Now force the report
      const hasForgePass = messages.some(m =>
        m.role === "tool" && m.name === "forge_test" && m.content?.includes("PASS")
      );
      const reportNudge = hasForgePass
        ? `FINAL ITERATION. Your exploit test PASSED. You MUST now output your structured report. Do NOT call any more tools. Output ONLY this format:\n\n===SOLHUNT_REPORT_START===\n{ "found": true, "vulnerability": { "class": "...", "severity": "...", "functions": [...], "description": "..." }, "exploit": { "testFile": "test/Exploit.t.sol", "testPassed": true, "valueAtRisk": "..." } }\n===SOLHUNT_REPORT_END===`
        : `FINAL ITERATION. You have exhausted your iteration budget. You MUST now output your findings report. Do NOT call any more tools. Output ONLY this format:\n\n===SOLHUNT_REPORT_START===\n{ "found": false, "vulnerability": { "class": "...", "severity": "...", "functions": [...], "description": "Describe what you analyzed and why exploitation was not possible" }, "exploit": { "testFile": "", "testPassed": false, "valueAtRisk": "unknown" } }\n===SOLHUNT_REPORT_END===`;

      messages.push({ role: "user", content: reportNudge });
      continue;
    }

    // Detect repeated tool calls (model stuck in a loop)
    const lastToolCalls = messages
      .filter(m => m.role === "assistant" && m.tool_calls?.length)
      .slice(-3)
      .map(m => m.tool_calls![0].function.name);
    if (lastToolCalls.length >= 3 && lastToolCalls.every(n => n === "forge_test")) {
      messages.push(assistantMessage);
      messages.push({
        role: "user",
        content: "STOP re-running the same test. The test keeps failing. Use str_replace_editor with command='create' to rewrite test/Exploit.t.sol with a DIFFERENT approach. Use interfaces (not src/ imports), pragma ^0.8.20, and target the real contract address on the fork.",
      });
      continue;
    }

    // Detect agent spending too long reading without writing code
    const hasWrittenTest = messages.some(m =>
      m.role === "tool" && m.name === "str_replace_editor" &&
      m.content?.includes("Exploit.t.sol")
    );
    if (iterations >= 8 && !hasWrittenTest) {
      messages.push(assistantMessage);
      collector?.recordMessage(assistantMessage);
      // Execute the current tool calls first
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        let toolInput: any;
        try { toolInput = JSON.parse(toolCall.function.arguments); }
        catch { toolInput = { command: toolCall.function.arguments }; }
        onIteration?.(iterations, toolName);
        const toolStart = Date.now();
        const result = await executor.execute(toolName, toolInput);
        collector?.recordToolCall(iterations, toolName, Date.now() - toolStart, result.isError ?? false, summarizeToolCall(toolName, toolInput));
        let output = result.output;
        if (output.length > 50_000) {
          output = output.slice(0, 25_000) + "\n\n... [truncated] ...\n\n" + output.slice(-25_000);
        }
        const toolMsg: Message = { role: "tool", tool_call_id: toolCall.id, name: toolName, content: output };
        messages.push(toolMsg);
        collector?.recordMessage(toolMsg);
      }
      messages.push({
        role: "user",
        content: "WARNING: You have used 8 iterations without writing an exploit test. You are running out of budget. IMMEDIATELY write test/Exploit.t.sol using str_replace_editor. Use an interface-only approach (no src/ imports). Target the real contract address on the fork. If you're unsure about the vulnerability, write a test for your best guess. A failing test is better than no test.",
      });
      continue;
    }

    // Add assistant message to history
    messages.push(assistantMessage);
    collector?.recordMessage(assistantMessage);

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

      const toolStart = Date.now();
      const result = await executor.execute(toolName, toolInput);
      collector?.recordToolCall(iterations, toolName, Date.now() - toolStart, result.isError ?? false, summarizeToolCall(toolName, toolInput));

      // Truncate very long outputs to avoid filling context
      let output = result.output;
      if (output.length > 50_000) {
        output =
          output.slice(0, 25_000) +
          "\n\n... [output truncated, showing first and last 25KB] ...\n\n" +
          output.slice(-25_000);
      }

      const toolMsg: Message = {
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolName,
        content: output,
      };
      messages.push(toolMsg);
      collector?.recordMessage(toolMsg);
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
