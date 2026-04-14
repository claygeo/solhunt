import { SandboxManager } from "../sandbox/manager.js";

export interface ToolResult {
  output: string;
  isError: boolean;
}

export class ToolExecutor {
  constructor(
    private sandbox: SandboxManager,
    private containerId: string,
    private toolTimeout: number = 60_000
  ) {}

  async execute(toolName: string, input: any): Promise<ToolResult> {
    switch (toolName) {
      case "bash":
        return this.executeBash(input);
      case "str_replace_editor":
        return this.executeTextEditor(input);
      case "read_file":
        return this.executeReadFile(input);
      case "forge_test":
        return this.executeForgeTest(input);
      default:
        return { output: `Unknown tool: ${toolName}`, isError: true };
    }
  }

  private async executeBash(input: {
    command: string;
    restart?: boolean;
  }): Promise<ToolResult> {
    try {
      const result = await this.sandbox.exec(
        this.containerId,
        input.command,
        this.toolTimeout
      );

      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

      return {
        output: output || "(no output)",
        isError: result.exitCode !== 0,
      };
    } catch (err: any) {
      return {
        output: `Error executing command: ${err.message}`,
        isError: true,
      };
    }
  }

  private async executeTextEditor(input: {
    command: "view" | "create" | "str_replace" | "insert" | "undo_edit";
    path: string;
    file_text?: string;
    old_str?: string;
    new_str?: string;
    insert_line?: number;
    view_range?: [number, number];
  }): Promise<ToolResult> {
    try {
      switch (input.command) {
        case "view": {
          const result = await this.sandbox.exec(
            this.containerId,
            input.view_range
              ? `sed -n '${input.view_range[0]},${input.view_range[1]}p' '${input.path}'`
              : `cat -n '${input.path}'`,
            this.toolTimeout
          );
          return { output: result.stdout || result.stderr, isError: result.exitCode !== 0 };
        }

        case "create": {
          if (!input.file_text) {
            return { output: "file_text required for create", isError: true };
          }
          await this.sandbox.writeFile(this.containerId, input.path, input.file_text);
          return { output: `File created: ${input.path}`, isError: false };
        }

        case "str_replace": {
          if (input.old_str === undefined || input.new_str === undefined) {
            return { output: "old_str and new_str required for str_replace", isError: true };
          }

          // Read file, replace, write back
          const content = await this.sandbox.readFile(this.containerId, input.path);
          const oldStr = input.old_str;

          if (!content.includes(oldStr)) {
            return {
              output: `old_str not found in ${input.path}. Make sure the string matches exactly.`,
              isError: true,
            };
          }

          const newContent = content.replace(oldStr, input.new_str);
          await this.sandbox.writeFile(this.containerId, input.path, newContent);
          return { output: `Replacement made in ${input.path}`, isError: false };
        }

        case "insert": {
          if (input.insert_line === undefined || input.new_str === undefined) {
            return { output: "insert_line and new_str required", isError: true };
          }

          const fileContent = await this.sandbox.readFile(this.containerId, input.path);
          const lines = fileContent.split("\n");
          lines.splice(input.insert_line, 0, input.new_str);
          await this.sandbox.writeFile(this.containerId, input.path, lines.join("\n"));
          return { output: `Inserted at line ${input.insert_line} in ${input.path}`, isError: false };
        }

        default:
          return { output: `Unsupported editor command: ${input.command}`, isError: true };
      }
    } catch (err: any) {
      return { output: `Text editor error: ${err.message}`, isError: true };
    }
  }

  private async executeReadFile(input: { path: string }): Promise<ToolResult> {
    try {
      const content = await this.sandbox.readFile(this.containerId, input.path);
      return { output: content, isError: false };
    } catch (err: any) {
      return { output: `Failed to read file: ${err.message}`, isError: true };
    }
  }

  private async executeForgeTest(input: {
    test_file: string;
    verbosity?: number;
    function_name?: string;
  }): Promise<ToolResult> {
    const v = input.verbosity ?? 3;
    const vFlag = "-" + "v".repeat(Math.min(v, 5));
    const matchPath = `--match-path "${input.test_file}"`;
    const matchFn = input.function_name
      ? `--match-test "${input.function_name}"`
      : "";

    try {
      const result = await this.sandbox.exec(
        this.containerId,
        `cd /workspace/scan && forge test ${matchPath} ${matchFn} ${vFlag} 2>&1`,
        300_000 // 5 min
      );

      const output = result.stdout + result.stderr;
      return {
        output: output || "(no output)",
        isError: result.exitCode !== 0,
      };
    } catch (err: any) {
      return {
        output: `Forge test error: ${err.message}`,
        isError: true,
      };
    }
  }
}
