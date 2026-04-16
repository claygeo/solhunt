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
  reconData?: string;
}): string {
  const sourceList = params.sourceFiles
    .map((f) => `- src/${f.filename}`)
    .join("\n");

  // Include source code directly in the prompt to reduce tool-use iterations.
  // Truncate if total source is too large (prevents prompt overflow on local models).
  const MAX_SOURCE_CHARS = 50_000;
  let totalChars = params.sourceFiles.reduce((sum, f) => sum + f.content.length, 0);

  let sourceContents: string;
  if (totalChars <= MAX_SOURCE_CHARS) {
    sourceContents = params.sourceFiles
      .map((f) => `### ${f.filename}\n\`\`\`solidity\n${f.content}\n\`\`\``)
      .join("\n\n");
  } else {
    // For large contracts: include as many files as possible up to the limit,
    // then summarize the rest. Prioritize the main contract file first.
    const included: string[] = [];
    let charBudget = MAX_SOURCE_CHARS;
    const remaining: { filename: string; chars: number }[] = [];

    for (const f of params.sourceFiles) {
      if (f.content.length <= charBudget) {
        included.push(`### ${f.filename}\n\`\`\`solidity\n${f.content}\n\`\`\``);
        charBudget -= f.content.length;
      } else if (included.length === 0) {
        // First file is too large: truncate it
        included.push(`### ${f.filename}\n\`\`\`solidity\n${f.content.slice(0, charBudget)}\n// ... [truncated, use read_file to see full source]\n\`\`\``);
        charBudget = 0;
      } else {
        remaining.push({ filename: f.filename, chars: f.content.length });
      }
    }

    sourceContents = included.join("\n\n");
    if (remaining.length > 0) {
      const otherFiles = remaining.map(f =>
        `- \`src/${f.filename}\` (${f.chars} chars)`
      ).join("\n");
      sourceContents += `\n\n### Other source files (use read_file or bash to inspect):\n${otherFiles}`;
    }
  }

  // Structural summary: list external calls, imports, and key patterns to guide analysis
  const externalCalls = new Set<string>();
  const importPatterns = new Set<string>();
  for (const f of params.sourceFiles) {
    // Detect external protocol references
    const protocols = ["uniswap", "aave", "compound", "curve", "balancer", "chainlink", "sushiswap", "maker", "yearn"];
    for (const p of protocols) {
      if (f.content.toLowerCase().includes(p)) importPatterns.add(p);
    }
    // Detect flash loan patterns
    if (/flash(Loan|loan|Borrow|borrow)|IFlash/i.test(f.content)) importPatterns.add("flash-loan");
    // Detect delegatecall
    if (/delegatecall/i.test(f.content)) importPatterns.add("delegatecall");
    // Detect proxy patterns
    if (/fallback|_implementation|upgradeTo|Diamond/i.test(f.content)) importPatterns.add("proxy-pattern");
  }

  const structuralHints = importPatterns.size > 0
    ? `\n**Detected patterns:** ${[...importPatterns].join(", ")}\n`
    : "";

  const reconSection = params.reconData ? `\n${params.reconData}\n` : "";

  return `## Target Contract

**Address:** \`${params.contractAddress}\`
**Name:** ${params.contractName}
**Chain:** ${params.chain}
**Fork Block:** ${params.blockNumber ?? "latest"}

The Anvil fork is running at \`http://localhost:8545\`. The contract is LIVE at its real address on the fork.

Source code is in \`/workspace/scan/src/\`:
${sourceList}

${sourceContents}
${structuralHints}${reconSection}
## Your Plan

1. Read the source above. Identify the vulnerability class.
2. Write \`test/Exploit.t.sol\` using an INTERFACE (not source imports) targeting the real address \`${params.contractAddress}\`.
3. Run forge_test. If it fails, fix and retry.
4. Output your report.

**DO NOT deploy a new contract instance.** Use the existing one at \`${params.contractAddress}\` on the fork.
**DO NOT import from src/.** Define a minimal interface in your test file.
**Write code by iteration 4 at the latest.** Reading without writing is wasted budget.`;
}
