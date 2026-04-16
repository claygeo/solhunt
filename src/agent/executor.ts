import { SandboxManager } from "../sandbox/manager.js";
import { keccak256 } from "js-sha3";

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
          // Sanitize file content: fix common model formatting issues
          let fileText = resolvedInput.file_text;
          // Remove leading/trailing whitespace
          fileText = fileText.trim();
          // Fix double-escaped newlines (\\n → \n) that some models produce
          fileText = fileText.replace(/\\n/g, "\n");
          // Fix double-escaped tabs
          fileText = fileText.replace(/\\t/g, "\t");
          // Remove stray leading backslashes
          fileText = fileText.replace(/^\\/m, "");
          // Auto-fix EIP-55 checksums on Ethereum addresses in Solidity files
          // Models often output lowercase hex addresses which Forge rejects
          if (resolvedInput.path.endsWith(".sol")) {
            fileText = fixSolidityChecksums(fileText);
          }
          await this.sandbox.writeFile(this.containerId, resolvedInput.path, fileText);
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

          let newStr = resolvedInput.new_str;
          // Auto-fix checksums in Solidity replacements
          if (resolvedInput.path.endsWith(".sol")) {
            newStr = fixSolidityChecksums(newStr);
          }
          const newContent = content.replace(oldStr, newStr);
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

/**
 * EIP-55 checksum: convert a hex address to its checksummed form.
 * Forge rejects non-checksummed addresses in Solidity source, and
 * LLMs frequently output lowercase hex. This saves 5-10 wasted iterations.
 * Uses keccak256 (NOT SHA3-256, they differ post-NIST).
 */
function toChecksumAddress(address: string): string {
  const addr = address.toLowerCase().replace("0x", "");
  const hash = keccak256(addr);
  let result = "0x";
  for (let i = 0; i < addr.length; i++) {
    if (parseInt(hash[i], 16) >= 8) {
      result += addr[i].toUpperCase();
    } else {
      result += addr[i];
    }
  }
  return result;
}

/**
 * Find all Ethereum addresses in Solidity source and apply EIP-55 checksums.
 * Matches 0x followed by 40 hex chars that aren't already checksummed.
 */
function fixSolidityChecksums(source: string): string {
  return source.replace(/0x([0-9a-fA-F]{40})\b/g, (match) => {
    // Skip if already has mixed case (likely already checksummed)
    const hex = match.slice(2);
    const hasUpper = /[A-F]/.test(hex);
    const hasLower = /[a-f]/.test(hex);
    if (hasUpper && hasLower) return match; // Already mixed case, leave it
    // All lowercase or all uppercase: needs checksum
    return toChecksumAddress(match);
  });
}
