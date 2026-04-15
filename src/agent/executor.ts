import { SandboxManager } from "../sandbox/manager.js";

const WORKDIR = "/workspace/scan";

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

  // Resolve relative paths to the workspace directory
  private resolvePath(path: string): string {
    if (path.startsWith("/")) return path;
    return `${WORKDIR}/${path}`;
  }

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
      // Always run from the workspace directory
      const cmd = `cd ${WORKDIR} && ${input.command}`;
      const result = await this.sandbox.exec(
        this.containerId,
        cmd,
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
    // Resolve relative paths to workspace
    const resolvedPath = this.resolvePath(input.path);
    const resolvedInput = { ...input, path: resolvedPath };

    try {
      switch (resolvedInput.command) {
        case "view": {
          const result = await this.sandbox.exec(
            this.containerId,
            resolvedInput.view_range
              ? `sed -n '${resolvedInput.view_range[0]},${resolvedInput.view_range[1]}p' '${resolvedInput.path}'`
              : `cat -n '${resolvedInput.path}'`,
            this.toolTimeout
          );
          return { output: result.stdout || result.stderr, isError: result.exitCode !== 0 };
        }

        case "create": {
          if (!resolvedInput.file_text) {
            return { output: "file_text required for create", isError: true };
          }
          // Create parent directories if needed
          const dir = resolvedInput.path.substring(0, resolvedInput.path.lastIndexOf("/"));
          await this.sandbox.exec(this.containerId, `mkdir -p "${dir}"`);
          await this.sandbox.writeFile(this.containerId, resolvedInput.path, resolvedInput.file_text);
          return { output: `File created: ${resolvedInput.path}`, isError: false };
        }

        case "str_replace": {
          if (resolvedInput.old_str === undefined || resolvedInput.new_str === undefined) {
            return { output: "old_str and new_str required for str_replace", isError: true };
          }

          // Read file, replace, write back
          const content = await this.sandbox.readFile(this.containerId, resolvedInput.path);
          const oldStr = resolvedInput.old_str;

          if (!content.includes(oldStr)) {
            return {
              output: `old_str not found in ${resolvedInput.path}. Make sure the string matches exactly.`,
              isError: true,
            };
          }

          const newContent = content.replace(oldStr, resolvedInput.new_str);
          await this.sandbox.writeFile(this.containerId, resolvedInput.path, newContent);
          return { output: `Replacement made in ${resolvedInput.path}`, isError: false };
        }

        case "insert": {
          if (resolvedInput.insert_line === undefined || resolvedInput.new_str === undefined) {
            return { output: "insert_line and new_str required", isError: true };
          }

          const fileContent = await this.sandbox.readFile(this.containerId, resolvedInput.path);
          const lines = fileContent.split("\n");
          lines.splice(resolvedInput.insert_line, 0, resolvedInput.new_str);
          await this.sandbox.writeFile(this.containerId, resolvedInput.path, lines.join("\n"));
          return { output: `Inserted at line ${resolvedInput.insert_line} in ${resolvedInput.path}`, isError: false };
        }

        default:
          return { output: `Unsupported editor command: ${resolvedInput.command}`, isError: true };
      }
    } catch (err: any) {
      return { output: `Text editor error: ${err.message}`, isError: true };
    }
  }

  private async executeReadFile(input: { path: string }): Promise<ToolResult> {
    try {
      const resolved = this.resolvePath(input.path);
      const content = await this.sandbox.readFile(this.containerId, resolved);
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
        `cd /workspace/scan && forge test ${matchPath} ${matchFn} ${vFlag} --fork-url http://localhost:8545 2>&1`,
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
