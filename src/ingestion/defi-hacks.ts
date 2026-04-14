import { readFileSync, existsSync } from "node:fs";

export interface BenchmarkEntry {
  id: string;
  name: string;
  chain: string;
  blockNumber: number;
  contractAddress: string;
  vulnerabilityClass: string;
  description: string;
  referenceExploit?: string;
  date: string;
  valueImpacted?: string;
}

export function loadDataset(path: string): BenchmarkEntry[] {
  if (!existsSync(path)) {
    throw new Error(`Benchmark dataset not found: ${path}`);
  }

  const raw = readFileSync(path, "utf-8");
  const data = JSON.parse(raw);

  if (!Array.isArray(data)) {
    throw new Error("Dataset must be a JSON array");
  }

  return data.map(validateEntry);
}

function validateEntry(entry: any, index: number): BenchmarkEntry {
  const required = ["id", "name", "chain", "blockNumber", "contractAddress", "vulnerabilityClass"];
  for (const field of required) {
    if (!entry[field]) {
      throw new Error(`Dataset entry ${index} missing required field: ${field}`);
    }
  }

  return {
    id: entry.id,
    name: entry.name,
    chain: entry.chain,
    blockNumber: Number(entry.blockNumber),
    contractAddress: entry.contractAddress,
    vulnerabilityClass: entry.vulnerabilityClass,
    description: entry.description ?? "",
    referenceExploit: entry.referenceExploit,
    date: entry.date ?? "",
    valueImpacted: entry.valueImpacted,
  };
}

// Chain name to Etherscan chain ID mapping
export const CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  mainnet: 1,
  bsc: 56,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  avalanche: 43114,
  base: 8453,
};

export function getChainId(chain: string): number {
  const id = CHAIN_IDS[chain.toLowerCase()];
  if (!id) {
    throw new Error(`Unknown chain: ${chain}. Supported: ${Object.keys(CHAIN_IDS).join(", ")}`);
  }
  return id;
}
