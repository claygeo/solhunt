import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "../../prompts");

export function getSystemPrompt(): string {
  return readFileSync(resolve(PROMPTS_DIR, "system.md"), "utf-8");
}

export function buildAnalysisPrompt(params: {
  contractAddress: string;
  contractName: string;
  chain: string;
  blockNumber?: number;
  sourceFiles: { filename: string; content: string }[];
}): string {
  const sourceList = params.sourceFiles
    .map((f) => `- src/${f.filename}`)
    .join("\n");

  // Include source code directly in the prompt to reduce tool-use iterations.
  // Truncate if total source is too large (prevents prompt overflow on local models).
  const MAX_SOURCE_CHARS = 30_000;
  let totalChars = params.sourceFiles.reduce((sum, f) => sum + f.content.length, 0);

  let sourceContents: string;
  if (totalChars <= MAX_SOURCE_CHARS) {
    sourceContents = params.sourceFiles
      .map((f) => `### ${f.filename}\n\`\`\`solidity\n${f.content}\n\`\`\``)
      .join("\n\n");
  } else {
    // For large contracts: include first file in full, summarize the rest
    const primary = params.sourceFiles[0];
    const primaryContent = primary.content.length > MAX_SOURCE_CHARS
      ? primary.content.slice(0, MAX_SOURCE_CHARS) + "\n// ... [truncated, use read_file to see full source]"
      : primary.content;
    const otherFiles = params.sourceFiles.slice(1).map(f =>
      `- \`src/${f.filename}\` (${f.content.length} chars)`
    ).join("\n");
    sourceContents = `### ${primary.filename}\n\`\`\`solidity\n${primaryContent}\n\`\`\`\n\n` +
      (otherFiles ? `### Other source files (use read_file or bash to inspect):\n${otherFiles}` : "");
  }

  return `## Target Contract

**Address:** ${params.contractAddress}
**Name:** ${params.contractName}
**Chain:** ${params.chain}
**Block:** ${params.blockNumber ?? "latest"}

The contract source code has been placed in \`/workspace/scan/src/\`:
${sourceList}

${sourceContents}

## Important Notes for Writing the Exploit Test

1. Import the contract directly: \`import "../src/${params.sourceFiles[0]?.filename ?? "Contract.sol"}";\`
2. Deploy a new instance in setUp(): \`target = new ${params.contractName}();\`
3. Use \`vm.deal(address(this), 10 ether);\` to fund the attacker
4. The test file goes at: \`/workspace/scan/test/Exploit.t.sol\`

Begin your analysis. Identify vulnerabilities and write a working exploit test. Use the str_replace_editor tool to create the test file, then use forge_test to run it. If it fails, fix and retry.`;
}
