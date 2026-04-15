export interface EtherscanSource {
  filename: string;
  content: string;
}

export interface ContractInfo {
  address: string;
  name: string;
  compiler: string;
  optimizationUsed: boolean;
  runs: number;
  abi: string;
  sources: EtherscanSource[];
  constructorArguments: string;
  evmVersion: string;
  licenseType: string;
}

const ETHERSCAN_BASE = "https://api.etherscan.io/v2/api";

// Rate limiter: max 5 calls per second
let lastCall = 0;
const MIN_INTERVAL = 200; // 200ms between calls = 5/sec

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCall;
  if (elapsed < MIN_INTERVAL) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL - elapsed));
  }
  lastCall = Date.now();
}

export async function fetchContractSource(
  address: string,
  apiKey: string,
  chainId: number = 1
): Promise<ContractInfo> {
  await rateLimit();

  const url = new URL(ETHERSCAN_BASE);
  url.searchParams.set("chainid", chainId.toString());
  url.searchParams.set("module", "contract");
  url.searchParams.set("action", "getsourcecode");
  url.searchParams.set("address", address);
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Etherscan API error: ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json();

  if (data.status !== "1" || !data.result?.[0]) {
    throw new Error(`Etherscan API error: ${data.message ?? "Unknown error"}`);
  }

  const result = data.result[0];

  if (!result.SourceCode || result.SourceCode === "") {
    throw new Error(`Contract ${address} is not verified on Etherscan`);
  }

  const sources = parseSourceCode(result.SourceCode, result.ContractName);

  return {
    address,
    name: result.ContractName,
    compiler: result.CompilerVersion,
    optimizationUsed: result.OptimizationUsed === "1",
    runs: parseInt(result.Runs, 10),
    abi: result.ABI,
    sources,
    constructorArguments: result.ConstructorArguments,
    evmVersion: result.EVMVersion,
    licenseType: result.LicenseType,
  };
}

// Strip common path prefixes from Etherscan source filenames
// e.g., "contracts/src/Curve.sol" → "Curve.sol"
//        "src/interfaces/IFoo.sol" → "interfaces/IFoo.sol"
function normalizeSourcePath(filename: string): string {
  // Strip common prefixes that would cause double-nesting in our src/ directory
  return filename
    .replace(/^contracts\//, "")
    .replace(/^src\//, "")
    .replace(/^lib\//, "");
}

function parseSourceCode(
  sourceCode: string,
  contractName: string
): EtherscanSource[] {
  // Etherscan returns source code in different formats:
  // 1. Plain Solidity string
  // 2. JSON with multiple files (wrapped in double braces: {{...}})
  // 3. Standard JSON input format

  // Check for multi-file JSON format (double-brace wrapped)
  if (sourceCode.startsWith("{{")) {
    try {
      const parsed = JSON.parse(sourceCode.slice(1, -1));
      if (parsed.sources) {
        return Object.entries(parsed.sources).map(
          ([filename, data]: [string, any]) => ({
            filename: normalizeSourcePath(filename),
            content: data.content,
          })
        );
      }
    } catch {
      // Fall through to single-file handling
    }
  }

  // Check for standard JSON input format
  if (sourceCode.startsWith("{")) {
    try {
      const parsed = JSON.parse(sourceCode);
      if (parsed.sources) {
        return Object.entries(parsed.sources).map(
          ([filename, data]: [string, any]) => ({
            filename: normalizeSourcePath(filename),
            content: data.content,
          })
        );
      }
    } catch {
      // Fall through to single-file handling
    }
  }

  // Single file
  return [
    {
      filename: `${contractName}.sol`,
      content: sourceCode,
    },
  ];
}

export async function fetchContractABI(
  address: string,
  apiKey: string,
  chainId: number = 1
): Promise<any[]> {
  await rateLimit();

  const url = new URL(ETHERSCAN_BASE);
  url.searchParams.set("chainid", chainId.toString());
  url.searchParams.set("module", "contract");
  url.searchParams.set("action", "getabi");
  url.searchParams.set("address", address);
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Etherscan API error: ${response.status}`);
  }

  const data: any = await response.json();
  if (data.status !== "1") {
    throw new Error(`Failed to fetch ABI: ${data.message}`);
  }

  return JSON.parse(data.result);
}
