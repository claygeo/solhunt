import { SandboxManager } from "./manager.js";

export interface ContractSource {
  filename: string;
  content: string;
}

export class FoundryProject {
  constructor(private sandbox: SandboxManager) {}

  async scaffold(
    containerId: string,
    rpcUrl: string,
    blockNumber?: number
  ): Promise<void> {
    // Copy from pre-built template (faster than forge init)
    await this.sandbox.exec(
      containerId,
      "cp -r /workspace/template /workspace/scan",
      30_000
    );

    // Write foundry.toml with fork config
    const forkUrl = "http://localhost:8545";
    const toml = `[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.20"
evm_version = "shanghai"
auto_detect_solc = true

remappings = [
  "@openzeppelin/=lib/openzeppelin-contracts/",
  "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
  "@uniswap/v2-core/=lib/v2-core/",
  "@uniswap/v3-core/=lib/v3-core/",
  "@chainlink/=lib/chainlink/",
]

[rpc_endpoints]
local = "${forkUrl}"
mainnet = "${rpcUrl}"

[fuzz]
runs = 256
`;

    await this.sandbox.writeFile(containerId, "/workspace/scan/foundry.toml", toml);

    // Clean default src files
    await this.sandbox.exec(
      containerId,
      "rm -f /workspace/scan/src/Counter.sol /workspace/scan/test/Counter.t.sol /workspace/scan/script/Counter.s.sol"
    );
  }

  async addContractSource(
    containerId: string,
    sources: ContractSource[]
  ): Promise<void> {
    // Filter out sources that ship with forge-std (always pre-installed).
    // Keep everything else, including vendored OpenZeppelin, since the
    // contract may pin a specific version.
    const skipPrefixes = ["forge-std/"];

    for (const source of sources) {
      if (skipPrefixes.some(p => source.filename.startsWith(p))) continue;

      // Files with "lib/" prefix go to /workspace/scan/lib/ (not src/)
      // because contracts import them via "../lib/..." relative paths.
      // Everything else goes to /workspace/scan/src/.
      const isLib = source.filename.startsWith("lib/");
      const basePath = isLib ? "/workspace/scan" : "/workspace/scan/src";
      const path = `${basePath}/${source.filename}`;

      // Create parent directories for nested source files
      const dir = path.substring(0, path.lastIndexOf("/"));
      await this.sandbox.exec(containerId, `mkdir -p "${dir}"`);

      await this.sandbox.writeFile(containerId, path, source.content);
    }
  }

  async build(containerId: string): Promise<{ success: boolean; output: string }> {
    const result = await this.sandbox.exec(
      containerId,
      "cd /workspace/scan && forge build 2>&1",
      120_000
    );

    return {
      success: result.exitCode === 0,
      output: result.stdout + result.stderr,
    };
  }

  async runTest(
    containerId: string,
    testFile?: string,
    verbosity: number = 3
  ): Promise<{ success: boolean; output: string }> {
    const contractsFlag = testFile ? `--match-path "${testFile}"` : "";
    const vFlag = "-" + "v".repeat(verbosity);

    const result = await this.sandbox.exec(
      containerId,
      `cd /workspace/scan && forge test ${contractsFlag} ${vFlag} 2>&1`,
      300_000 // 5 min for complex tests
    );

    return {
      success: result.exitCode === 0,
      output: result.stdout + result.stderr,
    };
  }
}
