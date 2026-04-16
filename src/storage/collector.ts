import type { Message } from "../agent/provider.js";
import {
  insertToolCalls,
  uploadArtifact,
  gzipJson,
  type ToolCallRow,
} from "./supabase.js";

export interface ToolCallRecord {
  iteration: number;
  tool_name: string;
  duration_ms: number;
  is_error: boolean;
  summary: string;
}

export class DataCollector {
  private toolCalls: ToolCallRecord[] = [];
  private conversationHistory: Message[] = [];
  private exploitCode: string | null = null;
  private forgeOutput: string | null = null;
  private reconData: string | null = null;
  private contractSource: { filename: string; content: string }[] | null = null;

  recordToolCall(
    iteration: number,
    toolName: string,
    durationMs: number,
    isError: boolean,
    summary: string
  ): void {
    this.toolCalls.push({
      iteration,
      tool_name: toolName,
      duration_ms: durationMs,
      is_error: isError,
      summary: summary.slice(0, 500),
    });
  }

  recordMessage(message: Message): void {
    // Clone to avoid mutation from conversation trimming in the agent loop
    this.conversationHistory.push({ ...message });
  }

  setExploitCode(code: string | null): void {
    this.exploitCode = code;
  }

  setForgeOutput(output: string | null): void {
    this.forgeOutput = output;
  }

  setReconData(data: string | null): void {
    this.reconData = data;
  }

  setContractSource(
    sources: { filename: string; content: string }[] | null
  ): void {
    this.contractSource = sources;
  }

  getLastForgeOutput(): string | null {
    // Walk conversation backward to find the last forge_test tool result
    for (let i = this.conversationHistory.length - 1; i >= 0; i--) {
      const msg = this.conversationHistory[i];
      if (msg.role === "tool" && msg.name === "forge_test" && msg.content) {
        return msg.content;
      }
    }
    return this.forgeOutput;
  }

  /**
   * Flush all collected data to Supabase Storage and insert tool_calls.
   * Fire-and-forget safe: catches all errors, never throws.
   */
  async flush(scanRunId: string): Promise<{
    exploitCodePath: string | null;
    forgeOutputPath: string | null;
    conversationPath: string | null;
    reconDataPath: string | null;
    sourceStoragePath: string | null;
  }> {
    const prefix = `runs/${scanRunId}`;
    const paths = {
      exploitCodePath: null as string | null,
      forgeOutputPath: null as string | null,
      conversationPath: null as string | null,
      reconDataPath: null as string | null,
      sourceStoragePath: null as string | null,
    };

    try {
      // Upload all artifacts in parallel
      const uploads = [];

      if (this.exploitCode) {
        uploads.push(
          uploadArtifact(
            `${prefix}/exploit.sol`,
            this.exploitCode,
            "text/plain"
          ).then((p) => { paths.exploitCodePath = p; })
        );
      }

      if (this.forgeOutput || this.getLastForgeOutput()) {
        const output = this.forgeOutput || this.getLastForgeOutput()!;
        uploads.push(
          uploadArtifact(
            `${prefix}/forge_output.txt`,
            output,
            "text/plain"
          ).then((p) => { paths.forgeOutputPath = p; })
        );
      }

      if (this.conversationHistory.length > 0) {
        const compressed = gzipJson(this.conversationHistory);
        uploads.push(
          uploadArtifact(
            `${prefix}/conversation.json.gz`,
            compressed,
            "application/gzip"
          ).then((p) => { paths.conversationPath = p; })
        );
      }

      if (this.reconData) {
        uploads.push(
          uploadArtifact(
            `${prefix}/recon.json`,
            this.reconData,
            "application/json"
          ).then((p) => { paths.reconDataPath = p; })
        );
      }

      if (this.contractSource && this.contractSource.length > 0) {
        uploads.push(
          uploadArtifact(
            `${prefix}/source.json`,
            JSON.stringify(this.contractSource),
            "application/json"
          ).then((p) => { paths.sourceStoragePath = p; })
        );
      }

      await Promise.allSettled(uploads);

      // Insert tool calls
      if (this.toolCalls.length > 0) {
        const rows: ToolCallRow[] = this.toolCalls.map((tc) => ({
          scan_run_id: scanRunId,
          iteration: tc.iteration,
          tool_name: tc.tool_name,
          duration_ms: tc.duration_ms,
          is_error: tc.is_error,
          summary: tc.summary,
        }));
        await insertToolCalls(rows);
      }
    } catch (err: any) {
      console.error(`[storage] flush failed: ${err.message}`);
    }

    return paths;
  }
}

/**
 * Summarize a tool call for the tool_calls table.
 * Keeps it short: command for bash, path for file ops.
 */
export function summarizeToolCall(
  toolName: string,
  toolInput: Record<string, any>
): string {
  switch (toolName) {
    case "bash":
      return (toolInput.command ?? "").slice(0, 200);
    case "str_replace_editor":
      return `${toolInput.command ?? "edit"} ${toolInput.path ?? ""}`.slice(0, 200);
    case "read_file":
      return (toolInput.path ?? "").slice(0, 200);
    case "forge_test":
      return (toolInput.testFile ?? toolInput.path ?? "forge_test").slice(0, 200);
    default:
      return JSON.stringify(toolInput).slice(0, 200);
  }
}
