export interface FunctionInfo {
  name: string;
  signature: string;
  stateMutability: string;
  visibility: string;
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
}

export interface ContractAnalysis {
  name: string;
  functions: FunctionInfo[];
  externalCalls: string[];
  stateChangingFunctions: string[];
  payableFunctions: string[];
  hasSelfdestruct: boolean;
  hasDelegatecall: boolean;
  usesAssembly: boolean;
}

export function analyzeABI(abi: any[]): FunctionInfo[] {
  return abi
    .filter((item: any) => item.type === "function")
    .map((item: any) => ({
      name: item.name,
      signature: `${item.name}(${(item.inputs ?? []).map((i: any) => i.type).join(",")})`,
      stateMutability: item.stateMutability ?? "nonpayable",
      visibility: "external",
      inputs: (item.inputs ?? []).map((i: any) => ({
        name: i.name,
        type: i.type,
      })),
      outputs: (item.outputs ?? []).map((o: any) => ({
        name: o.name,
        type: o.type,
      })),
    }));
}

export function analyzeSourceCode(source: string): ContractAnalysis {
  const name = extractContractName(source);
  const functions = extractFunctions(source);

  return {
    name,
    functions,
    externalCalls: findPatterns(source, /\.call\{|\.delegatecall\(|\.staticcall\(/g),
    stateChangingFunctions: functions
      .filter((f) => !["view", "pure"].includes(f.stateMutability))
      .map((f) => f.signature),
    payableFunctions: functions
      .filter((f) => f.stateMutability === "payable")
      .map((f) => f.signature),
    hasSelfdestruct: /selfdestruct\(|suicide\(/.test(source),
    hasDelegatecall: /delegatecall\(/.test(source),
    usesAssembly: /assembly\s*\{/.test(source),
  };
}

function extractContractName(source: string): string {
  const match = source.match(/contract\s+(\w+)/);
  return match?.[1] ?? "Unknown";
}

function extractFunctions(source: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const regex = /function\s+(\w+)\s*\(([^)]*)\)\s*(public|external|internal|private)?\s*(view|pure|payable)?/g;

  let match;
  while ((match = regex.exec(source)) !== null) {
    const name = match[1];
    const params = match[2].trim();
    const visibility = match[3] ?? "public";
    const mutability = match[4] ?? "nonpayable";

    const inputs = params
      ? params.split(",").map((p) => {
          const parts = p.trim().split(/\s+/);
          return { type: parts[0], name: parts[parts.length - 1] };
        })
      : [];

    functions.push({
      name,
      signature: `${name}(${inputs.map((i) => i.type).join(",")})`,
      stateMutability: mutability,
      visibility,
      inputs,
      outputs: [],
    });
  }

  return functions;
}

function findPatterns(source: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  let match;
  while ((match = pattern.exec(source)) !== null) {
    // Get some context around the match
    const start = Math.max(0, match.index - 50);
    const end = Math.min(source.length, match.index + match[0].length + 50);
    matches.push(source.slice(start, end).trim());
  }
  return matches;
}
