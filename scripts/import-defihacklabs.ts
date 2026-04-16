/**
 * Import DeFiHackLabs exploits into solhunt's dataset.json format.
 *
 * Usage:
 *   npx tsx scripts/import-defihacklabs.ts --repo /path/to/DeFiHackLabs --out benchmark/imported.json
 *   npx tsx scripts/import-defihacklabs.ts --clone --out benchmark/imported.json  # auto-clone repo
 *
 * Parses:
 * - Root README.md for vulnerability classifications and dates
 * - Individual test files for contract addresses, fork blocks, chains
 *
 * Filters:
 * - Only ethereum chain by default (pass --chains=ethereum,bsc,base to include more)
 * - Only entries with all required fields extractable
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

interface DatasetEntry {
  id: string;
  name: string;
  chain: string;
  blockNumber: number;
  contractAddress: string;
  vulnerabilityClass: string;
  description: string;
  referenceExploit: string;
  date: string;
  valueImpacted: string;
}

interface ParsedExploit {
  name: string;
  date: string;
  vulnType: string;
  loss: string;
  testPath: string;
}

// Map DeFiHackLabs vulnerability names to solhunt's canonical classes
const VULN_CLASS_MAP: Record<string, string> = {
  "reentrancy": "reentrancy",
  "reentry": "reentrancy",
  "access control": "access-control",
  "access-control": "access-control",
  "authentication": "access-control",
  "authorization": "access-control",
  "admin": "access-control",
  "price manipulation": "price-manipulation",
  "price oracle manipulation": "price-manipulation",
  "oracle manipulation": "price-manipulation",
  "oracle": "price-manipulation",
  "price": "price-manipulation",
  "flash loan": "flash-loan",
  "flashloan": "flash-loan",
  "governance": "flash-loan",
  "integer overflow": "integer-overflow",
  "integer underflow": "integer-overflow",
  "overflow": "integer-overflow",
  "underflow": "integer-overflow",
  "logic": "logic-error",
  "logic flaw": "logic-error",
  "logic error": "logic-error",
  "business logic": "logic-error",
  "input validation": "logic-error",
  "delegatecall": "delegatecall",
  "unchecked": "unchecked-return",
  "read-only reentrancy": "read-only-reentrancy",
  "read only reentrancy": "read-only-reentrancy",
};

const CHAIN_MAP: Record<string, string> = {
  "mainnet": "ethereum",
  "ethereum": "ethereum",
  "eth": "ethereum",
  "bsc": "bsc",
  "binance": "bsc",
  "polygon": "polygon",
  "matic": "polygon",
  "avalanche": "avalanche",
  "avax": "avalanche",
  "arbitrum": "arbitrum",
  "optimism": "optimism",
  "base": "base",
  "fantom": "fantom",
  "ftm": "fantom",
};

function normalizeVulnClass(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  // Direct match
  if (VULN_CLASS_MAP[lower]) return VULN_CLASS_MAP[lower];
  // Partial match: check if any key appears in the raw string
  for (const [key, value] of Object.entries(VULN_CLASS_MAP)) {
    if (lower.includes(key)) return value;
  }
  return null;
}

function normalizeChain(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  return CHAIN_MAP[lower] ?? null;
}

/**
 * Parse the main README.md for exploit entries.
 * Format varies but we look for markdown headings with date+protocol+vuln pattern.
 */
function parseReadme(readmeContent: string): ParsedExploit[] {
  const exploits: ParsedExploit[] = [];
  const lines = readmeContent.split("\n");

  // Heuristic: look for table rows like:
  // | 20220430 | Saddle | Price Manipulation | $11.9M | [test](...) |
  // Or markdown links: [YYYYMMDD Protocol - VulnType](src/test/YYYY-MM/Protocol_exp.sol)
  const linkRegex = /\[(\d{8})\s+(.+?)\s*-\s*(.+?)\]\(([^)]+)\)/;
  const tableRegex = /\|\s*(\d{8})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/;

  for (const line of lines) {
    const linkMatch = line.match(linkRegex);
    if (linkMatch) {
      const [, dateRaw, name, vulnType, path] = linkMatch;
      const testPath = path.startsWith("./") ? path.slice(2) : path;
      exploits.push({
        date: formatDate(dateRaw),
        name: name.trim(),
        vulnType: vulnType.trim(),
        loss: "unknown",
        testPath: testPath.replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\//, ""),
      });
      continue;
    }

    const tableMatch = line.match(tableRegex);
    if (tableMatch) {
      const [, dateRaw, name, vulnType, loss] = tableMatch;
      // Try to find a link to the test file in the same line
      const linkInRow = line.match(/\(([^)]+_exp\.sol)\)/);
      if (linkInRow) {
        exploits.push({
          date: formatDate(dateRaw),
          name: name.trim(),
          vulnType: vulnType.trim(),
          loss: loss.trim(),
          testPath: linkInRow[1].replace(/^\.\//, ""),
        });
      }
    }
  }

  return exploits;
}

function formatDate(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/**
 * Parse a Solidity test file for contract address, fork block, and chain.
 */
function parseTestFile(content: string): {
  blockNumber: number | null;
  chain: string | null;
  contractAddress: string | null;
  references: string[];
} {
  // Fork block: uint256 blocknumToForkFrom = 14595904 - 1;
  // Also: vm.createSelectFork("mainnet", 14595904);
  const blockPatterns = [
    /blocknumToForkFrom\s*=\s*(\d[\d_]*)/,
    /createSelectFork\s*\(\s*["'][^"']+["']\s*,\s*(\d[\d_]*)\s*\)/,
    /forkBlockNumber\s*=\s*(\d[\d_]*)/,
    /fork.*?block.*?(\d{7,9})/i,
  ];
  let blockNumber: number | null = null;
  for (const pattern of blockPatterns) {
    const match = content.match(pattern);
    if (match) {
      blockNumber = parseInt(match[1].replace(/_/g, ""), 10);
      break;
    }
  }

  // Chain: vm.createSelectFork("mainnet") or vm.createSelectFork("bsc")
  const chainMatch = content.match(/createSelectFork\s*\(\s*["']([^"']+)["']/);
  const chain = chainMatch ? normalizeChain(chainMatch[1]) : "ethereum";

  // Victim/vulnerable contract: look for @Info Analyst, @KeyInfo Analyst, or similar
  // Also: address constant VICTIM = 0x...; or address immutable VULNERABLE = 0x...;
  const addrPatterns = [
    /(?:victim|vulnerable|target|attacked)[^=]*?=\s*(0x[a-fA-F0-9]{40})/i,
    /address\s+(?:constant|immutable)?\s+(?:VICTIM|VULNERABLE|TARGET|ATTACKED)\w*\s*=\s*(0x[a-fA-F0-9]{40})/i,
    /@KeyInfo[\s\S]*?Vulnerable[^\n]*?(0x[a-fA-F0-9]{40})/i,
    /@Info[\s\S]*?Victim[^\n]*?(0x[a-fA-F0-9]{40})/i,
  ];
  let contractAddress: string | null = null;
  for (const pattern of addrPatterns) {
    const match = content.match(pattern);
    if (match) {
      contractAddress = match[1];
      break;
    }
  }

  // Fallback: grab the first 0x... address from the header comment block
  if (!contractAddress) {
    const headerEnd = content.indexOf("contract ");
    const header = headerEnd > 0 ? content.slice(0, headerEnd) : content.slice(0, 3000);
    const anyAddr = header.match(/0x[a-fA-F0-9]{40}/);
    if (anyAddr) contractAddress = anyAddr[0];
  }

  // References: https:// links in the header
  const refMatches = content.matchAll(/https?:\/\/[^\s)"'<>]+/g);
  const references = [...new Set([...refMatches].map(m => m[0]))].slice(0, 5);

  return { blockNumber, chain, contractAddress, references };
}

function cloneRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "defihacklabs-"));
  console.log(`Cloning DeFiHackLabs into ${dir}...`);
  execSync(`git clone --depth 1 https://github.com/SunWeb3Sec/DeFiHackLabs.git "${dir}"`, {
    stdio: "inherit",
  });
  return dir;
}

interface Options {
  repoPath?: string;
  outPath: string;
  clone: boolean;
  chains: string[];
  includeVulnClasses?: Set<string>;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = {
    outPath: "benchmark/imported.json",
    clone: false,
    chains: ["ethereum"],
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo" && args[i + 1]) {
      opts.repoPath = args[++i];
    } else if (a === "--out" && args[i + 1]) {
      opts.outPath = args[++i];
    } else if (a === "--clone") {
      opts.clone = true;
    } else if (a === "--chains" && args[i + 1]) {
      opts.chains = args[++i].split(",").map(c => c.trim());
    } else if (a === "--classes" && args[i + 1]) {
      opts.includeVulnClasses = new Set(args[++i].split(",").map(c => c.trim()));
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  let repoPath = opts.repoPath;
  if (!repoPath && opts.clone) {
    repoPath = cloneRepo();
  }
  if (!repoPath) {
    console.error("Error: provide --repo /path/to/DeFiHackLabs or --clone");
    process.exit(1);
  }

  const readmePath = join(repoPath, "README.md");
  if (!existsSync(readmePath)) {
    console.error(`README.md not found at ${readmePath}`);
    process.exit(1);
  }

  console.log(`Parsing ${readmePath}...`);
  const readmeContent = readFileSync(readmePath, "utf-8");
  const exploits = parseReadme(readmeContent);
  console.log(`Found ${exploits.length} exploits in README`);

  const entries: DatasetEntry[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const classCounts: Record<string, number> = {};

  for (const exploit of exploits) {
    const vulnClass = normalizeVulnClass(exploit.vulnType);
    if (!vulnClass) {
      skipped.push({ name: exploit.name, reason: `unknown vuln: ${exploit.vulnType}` });
      continue;
    }
    if (opts.includeVulnClasses && !opts.includeVulnClasses.has(vulnClass)) {
      continue;
    }

    const testFilePath = join(repoPath, exploit.testPath);
    if (!existsSync(testFilePath)) {
      skipped.push({ name: exploit.name, reason: `file missing: ${exploit.testPath}` });
      continue;
    }

    const fileContent = readFileSync(testFilePath, "utf-8");
    const parsed = parseTestFile(fileContent);

    if (!parsed.blockNumber || !parsed.contractAddress || !parsed.chain) {
      skipped.push({
        name: exploit.name,
        reason: `missing: ${!parsed.blockNumber ? "block " : ""}${!parsed.contractAddress ? "addr " : ""}${!parsed.chain ? "chain" : ""}`,
      });
      continue;
    }

    if (!opts.chains.includes(parsed.chain)) {
      skipped.push({ name: exploit.name, reason: `chain ${parsed.chain} not in allow list` });
      continue;
    }

    const id = `${vulnClass}-${String(entries.length + 1).padStart(3, "0")}-imported`;
    const referenceExploit = `https://github.com/SunWeb3Sec/DeFiHackLabs/blob/main/${exploit.testPath}`;

    entries.push({
      id,
      name: exploit.name,
      chain: parsed.chain,
      blockNumber: parsed.blockNumber,
      contractAddress: parsed.contractAddress,
      vulnerabilityClass: vulnClass,
      description: `${exploit.vulnType}. See reference exploit for details.`,
      referenceExploit,
      date: exploit.date,
      valueImpacted: exploit.loss || "unknown",
    });
    classCounts[vulnClass] = (classCounts[vulnClass] ?? 0) + 1;
  }

  writeFileSync(opts.outPath, JSON.stringify(entries, null, 2));

  console.log(`\nImported ${entries.length} entries to ${opts.outPath}`);
  console.log(`Skipped ${skipped.length} entries`);
  console.log(`\nBy vulnerability class:`);
  for (const [cls, count] of Object.entries(classCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls}: ${count}`);
  }
  if (skipped.length > 0 && skipped.length < 50) {
    console.log(`\nFirst 20 skipped:`);
    for (const s of skipped.slice(0, 20)) {
      console.log(`  ${s.name}: ${s.reason}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
