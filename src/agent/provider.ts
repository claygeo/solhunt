// Model-agnostic provider abstraction using OpenAI-compatible API format.
// Supports: Ollama (local), OpenRouter, Together, Groq, OpenAI, Anthropic (via proxy).

import { Agent as UndiciAgent, setGlobalDispatcher } from "undici";

// Override Node.js fetch's default 5-minute headersTimeout (kills slow local models)
setGlobalDispatcher(new UndiciAgent({
  headersTimeout: 600_000,    // 10 minutes
  bodyTimeout: 600_000,       // 10 minutes
  connectTimeout: 30_000,     // 30 seconds
}));

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface CompletionResponse {
  message: Message;
  finish_reason: "stop" | "tool_calls" | "length";
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ProviderConfig {
  provider: "ollama" | "openai" | "openrouter" | "anthropic" | "custom";
  model: string;
  baseUrl: string;
  apiKey?: string;
  maxTokens?: number;
}

// Preset configurations for common providers
export const PRESETS: Record<string, Omit<ProviderConfig, "model"> & { model: string }> = {
  "ollama": {
    provider: "ollama",
    model: "qwen2.5-coder:32b-8k",
    baseUrl: "http://localhost:11434/v1",
  },
  "ollama-small": {
    provider: "ollama",
    model: "qwen2.5-coder:7b",
    baseUrl: "http://localhost:11434/v1",
  },
  "ollama-llama": {
    provider: "ollama",
    model: "llama3.1:8b",
    baseUrl: "http://localhost:11434/v1",
  },
  "ollama-32b": {
    provider: "ollama",
    model: "qwen2.5-coder:32b-8k",
    baseUrl: "http://localhost:11434/v1",
  },
  "ollama-qwen35": {
    provider: "ollama",
    model: "qwen3.5:27b",
    baseUrl: "http://localhost:11434/v1",
  },
  "openai": {
    provider: "openai",
    model: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
  },
  "openrouter": {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  "anthropic": {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    baseUrl: "https://api.anthropic.com/v1",
  },
};

export function resolveProvider(
  providerName: string,
  overrides?: Partial<ProviderConfig>
): ProviderConfig {
  const preset = PRESETS[providerName];
  if (!preset) {
    throw new Error(
      `Unknown provider: ${providerName}. Available: ${Object.keys(PRESETS).join(", ")}`
    );
  }
  return { ...preset, ...overrides };
}

export async function chatCompletion(
  config: ProviderConfig,
  messages: Message[],
  tools?: ToolDefinition[]
): Promise<CompletionResponse> {
  // Anthropic has a different API format - use their SDK path
  if (config.provider === "anthropic") {
    return anthropicCompletion(config, messages, tools);
  }

  // Everyone else speaks OpenAI-compatible format
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  if (config.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/claygeo/solhunt";
    headers["X-Title"] = "solhunt";
  }

  // Disable thinking/reasoning for Qwen3 family (saves ~2-3min per call on CPU).
  // /no_think directive works for qwen3.5, qwen3.6, and newer variants.
  const isQwen35 = /qwen3[.-](5|6)/i.test(config.model) || config.model.includes("qwen3.5") || config.model.includes("qwen3.6");
  let formattedMessages = messages.map(formatMessage);

  // Gemini requires every message to have non-empty content.
  // Strip any messages with null/empty/whitespace-only content.
  const isGemini = config.model.includes("gemini");
  if (isGemini) {
    formattedMessages = formattedMessages.filter(m => {
      // Keep all messages but ensure content is non-empty
      if (!m.content || (typeof m.content === "string" && !m.content.trim())) {
        if (m.tool_calls) {
          m.content = "Calling tool.";
        } else if (m.tool_call_id) {
          m.content = "(empty result)";
        } else {
          m.content = ".";
        }
      }
      return true;
    });
  }
  if (isQwen35) {
    // Append /no_think to the last user message to disable reasoning mode
    for (let i = formattedMessages.length - 1; i >= 0; i--) {
      if (formattedMessages[i].role === "user") {
        const content = formattedMessages[i].content;
        if (typeof content === "string" && !content.includes("/no_think")) {
          formattedMessages[i] = { ...formattedMessages[i], content: content + " /no_think" };
        }
        break;
      }
    }
  }

  const body: Record<string, any> = {
    model: config.model,
    messages: formattedMessages,
    max_tokens: config.maxTokens ?? 16384,
    temperature: 0,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  // Long timeout for slow local models (32B on CPU can take 5+ minutes per response)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600_000); // 10 min

  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  const data: any = await response.json();
  const choice = data.choices?.[0];

  if (!choice) {
    throw new Error("No response from model");
  }

  const message = choice.message;

  // Some models (especially local ones via Ollama) return tool calls as JSON text
  // in the content field instead of using the structured tool_calls field.
  // Detect and convert these to proper tool_calls format.
  if (!message.tool_calls && message.content && tools?.length) {
    const parsed = tryParseToolCallFromContent(message.content);
    if (parsed) {
      message.tool_calls = [parsed];
      message.content = undefined;
    }
  }

  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;

  return {
    message,
    finish_reason: (choice.finish_reason === "tool_calls" || hasToolCalls) ? "tool_calls" : "stop",
    usage: data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// Known tool names for text-based tool call detection
const KNOWN_TOOLS = ["bash", "str_replace_editor", "read_file", "forge_test"];

// Attempt to parse a tool call from model text output.
// Handles multiple formats:
//   1. JSON: {"name": "bash", "arguments": {"command": "ls"}}
//   2. Markdown code block with JSON
//   3. Python-style: bash(command="ls -la")
//   4. Markdown-style: ```\nbash(command="ls")\n```
//   5. Gemini-style: tool_name(key='value', key2='value2')
function tryParseToolCallFromContent(content: string): ToolCall | null {
  const candidates: string[] = [];

  // 1. Try markdown code block extraction (JSON inside code blocks)
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch?.[1]) {
    candidates.push(codeBlockMatch[1].trim());
  }

  // 2. Try extracting first JSON object with "name" key
  const jsonObjMatch = content.match(/\{[\s\S]*?"name"\s*:\s*"[^"]+"/);
  if (jsonObjMatch) {
    const startIdx = jsonObjMatch.index!;
    let depth = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }
    if (depth === 0) {
      candidates.push(content.slice(startIdx, endIdx));
    }
  }

  // 3. Try the full content as-is
  candidates.push(content.trim());

  // Try JSON-based parsing first
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.name && (parsed.arguments || parsed.parameters)) {
        const args = parsed.arguments ?? parsed.parameters;
        return {
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: "function",
          function: {
            name: parsed.name,
            arguments: typeof args === "string" ? args : JSON.stringify(args),
          },
        };
      }
    } catch {
      // Try next candidate
    }
  }

  // 4. Try Python/Gemini function-call syntax: tool_name(key="value", key2='value2')
  //    Models like Gemini Flash write tool calls as text in this format.
  //    Also handles code blocks containing tool calls.
  for (const toolName of KNOWN_TOOLS) {
    // Match tool_name( ... ) allowing multi-line content
    const startPattern = new RegExp(`${toolName}\\s*\\(`);
    const startMatch = content.match(startPattern);
    if (startMatch) {
      const startIdx = startMatch.index! + startMatch[0].length;
      // Find matching closing paren (handle nested parens)
      let depth = 1;
      let endIdx = startIdx;
      for (let i = startIdx; i < content.length && depth > 0; i++) {
        if (content[i] === '(') depth++;
        else if (content[i] === ')') {
          depth--;
          if (depth === 0) endIdx = i;
        }
      }
      if (depth === 0) {
        const argsStr = content.slice(startIdx, endIdx).trim();
        const args = parsePythonArgs(argsStr);
        if (args && Object.keys(args).length > 0) {
          return {
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: "function",
            function: {
              name: toolName,
              arguments: JSON.stringify(args),
            },
          };
        }
      }
    }
  }

  return null;
}

// Parse Python-style keyword arguments: key="value", key2='value2', key3=123
// Handles multi-line string values (for file contents with Solidity code).
function parsePythonArgs(argsStr: string): Record<string, any> | null {
  const result: Record<string, any> = {};

  // For multi-line content (like file_text with Solidity), we need a stateful parser
  let i = 0;
  while (i < argsStr.length) {
    // Skip whitespace and commas
    while (i < argsStr.length && /[\s,]/.test(argsStr[i])) i++;
    if (i >= argsStr.length) break;

    // Read key
    const keyMatch = argsStr.slice(i).match(/^(\w+)\s*=\s*/);
    if (!keyMatch) { i++; continue; }
    const key = keyMatch[1];
    i += keyMatch[0].length;

    // Read value
    if (i >= argsStr.length) break;

    if (argsStr[i] === '"' || argsStr[i] === "'") {
      // Quoted string - find matching close quote (handle multi-line)
      const quote = argsStr[i];
      i++; // skip opening quote
      let value = "";
      while (i < argsStr.length) {
        if (argsStr[i] === '\\' && i + 1 < argsStr.length) {
          // Handle escape sequences
          const next = argsStr[i + 1];
          if (next === 'n') { value += '\n'; i += 2; }
          else if (next === 't') { value += '\t'; i += 2; }
          else if (next === '\\') { value += '\\'; i += 2; }
          else if (next === quote) { value += quote; i += 2; }
          else { value += argsStr[i + 1]; i += 2; }
        } else if (argsStr[i] === quote) {
          i++; // skip closing quote
          break;
        } else {
          value += argsStr[i];
          i++;
        }
      }
      result[key] = value;
    } else if (/\d/.test(argsStr[i])) {
      // Number
      const numMatch = argsStr.slice(i).match(/^(\d+(?:\.\d+)?)/);
      if (numMatch) {
        result[key] = Number(numMatch[1]);
        i += numMatch[0].length;
      }
    } else if (argsStr.slice(i).startsWith("True") || argsStr.slice(i).startsWith("true")) {
      result[key] = true;
      i += 4;
    } else if (argsStr.slice(i).startsWith("False") || argsStr.slice(i).startsWith("false")) {
      result[key] = false;
      i += 5;
    } else {
      i++; // skip unknown character
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function formatMessage(msg: Message): any {
  // Gemini API rejects empty content fields. Handle each message type carefully.
  const formatted: any = { role: msg.role };

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    // Assistant message with tool calls
    formatted.tool_calls = msg.tool_calls;
    // Gemini requires non-empty content in all message parts.
    // Use the actual content if available, otherwise a placeholder.
    formatted.content = (msg.content && msg.content.trim()) ? msg.content : "Calling tool.";
  } else if (msg.tool_call_id) {
    // Tool result message
    formatted.tool_call_id = msg.tool_call_id;
    formatted.name = msg.name;
    formatted.content = msg.content || "(empty result)";
  } else {
    // Regular message (system, user, or assistant text)
    formatted.content = msg.content || "(no content)";
  }

  return formatted;
}

// Anthropic API adapter (converts to/from their format)
async function anthropicCompletion(
  config: ProviderConfig,
  messages: Message[],
  tools?: ToolDefinition[]
): Promise<CompletionResponse> {
  if (!config.apiKey) {
    throw new Error("Anthropic provider requires an API key (ANTHROPIC_API_KEY)");
  }

  // Convert OpenAI messages to Anthropic format
  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystemMsgs = messages.filter((m) => m.role !== "system");

  // Convert messages, then merge consecutive same-role messages.
  // Anthropic requires strict user/assistant alternation.
  const rawAnthropicMessages = nonSystemMsgs.map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: msg.tool_call_id,
            content: msg.content ?? "",
          },
        ],
      };
    }

    if (msg.tool_calls) {
      const blocks: any[] = [];
      // Include text content if present (Anthropic supports mixed content blocks)
      if (msg.content && msg.content.trim()) {
        blocks.push({ type: "text" as const, text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        blocks.push({
          type: "tool_use" as const,
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        });
      }
      return {
        role: "assistant" as const,
        content: blocks,
      };
    }

    return {
      role: msg.role as "user" | "assistant",
      content: msg.content ?? "",
    };
  });

  // Merge consecutive same-role messages (Anthropic requires strict alternation)
  const anthropicMessages: any[] = [];
  for (const msg of rawAnthropicMessages) {
    const prev = anthropicMessages[anthropicMessages.length - 1];
    if (prev && prev.role === msg.role) {
      // Merge: convert both to content arrays and concatenate
      const prevBlocks = Array.isArray(prev.content)
        ? prev.content
        : [{ type: "text", text: prev.content }];
      const newBlocks = Array.isArray(msg.content)
        ? msg.content
        : [{ type: "text", text: msg.content }];
      prev.content = [...prevBlocks, ...newBlocks];
    } else {
      anthropicMessages.push({ ...msg });
    }
  }

  // Convert tools to Anthropic format
  const anthropicTools = tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const body: any = {
    model: config.model,
    max_tokens: config.maxTokens ?? 16384,
    messages: anthropicMessages,
  };

  if (systemMsg) {
    body.system = systemMsg.content;
  }

  if (anthropicTools && anthropicTools.length > 0) {
    body.tools = anthropicTools;
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const data: any = await response.json();

  // Convert Anthropic response to OpenAI format
  const textBlocks = data.content?.filter((b: any) => b.type === "text") ?? [];
  const toolBlocks = data.content?.filter((b: any) => b.type === "tool_use") ?? [];

  const message: Message = {
    role: "assistant",
    content: textBlocks.map((b: any) => b.text).join("\n") || undefined,
  };

  if (toolBlocks.length > 0) {
    message.tool_calls = toolBlocks.map((b: any) => ({
      id: b.id,
      type: "function" as const,
      function: {
        name: b.name,
        arguments: JSON.stringify(b.input),
      },
    }));
  }

  return {
    message,
    finish_reason: data.stop_reason === "tool_use" ? "tool_calls" : "stop",
    usage: {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    },
  };
}
