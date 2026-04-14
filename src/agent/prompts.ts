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

  return `## Target Contract

**Address:** ${params.contractAddress}
**Name:** ${params.contractName}
**Chain:** ${params.chain}
**Block:** ${params.blockNumber ?? "latest"}

The contract source code has been placed in the \`src/\` directory:
${sourceList}

The Anvil fork is running at \`http://localhost:8545\` with the ${params.chain} state at block ${params.blockNumber ?? "latest"}.

Begin your analysis. Read the source files, identify potential vulnerabilities, and attempt to write a working exploit.`;
}
