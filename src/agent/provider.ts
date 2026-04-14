// Model-agnostic provider abstraction using OpenAI-compatible API format.
// Supports: Ollama (local), OpenRouter, Together, Groq, OpenAI, Anthropic (via proxy).

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
    model: "deepseek-coder-v2:16b",
    baseUrl: "http://localhost:11434/v1",
  },
  "ollama-small": {
    provider: "ollama",
    model: "qwen2.5-coder:7b",
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

  const body: Record<string, any> = {
    model: config.model,
    messages: messages.map(formatMessage),
    max_tokens: config.maxTokens ?? 16384,
    temperature: 0,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

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

// Attempt to parse a tool call from model text output.
// Handles: {"name": "bash", "arguments": {"command": "ls"}}
// and: {"name": "bash", "parameters": {"command": "ls"}}
function tryParseToolCallFromContent(content: string): ToolCall | null {
  try {
    // Try to find JSON in the content (may be wrapped in markdown code blocks)
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
    const text = jsonMatch[1]?.trim() ?? content.trim();

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
    // Not parseable as a tool call, that's fine
  }
  return null;
}

function formatMessage(msg: Message): any {
  const formatted: any = { role: msg.role, content: msg.content ?? "" };

  if (msg.tool_calls) {
    formatted.tool_calls = msg.tool_calls;
  }

  if (msg.tool_call_id) {
    formatted.tool_call_id = msg.tool_call_id;
    formatted.name = msg.name;
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

  const anthropicMessages = nonSystemMsgs.map((msg) => {
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
      return {
        role: "assistant" as const,
        content: msg.tool_calls.map((tc) => ({
          type: "tool_use" as const,
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        })),
      };
    }

    return {
      role: msg.role as "user" | "assistant",
      content: msg.content ?? "",
    };
  });

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
