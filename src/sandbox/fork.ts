import { SandboxManager, ExecResult } from "./manager.js";

export interface ForkConfig {
  chain: string;
  rpcUrl: string;
  blockNumber?: number;
}

export class ForkManager {
  constructor(private sandbox: SandboxManager) {}

  async startAnvilFork(
    containerId: string,
    config: ForkConfig
  ): Promise<void> {
    const blockFlag = config.blockNumber
      ? `--fork-block-number ${config.blockNumber}`
      : "";

    // Start anvil in the background
    await this.sandbox.exec(
      containerId,
      `nohup anvil --host 0.0.0.0 --fork-url "${config.rpcUrl}" ${blockFlag} --silent > /tmp/anvil.log 2>&1 &`,
      10_000
    );

    // Wait for anvil to be ready
    await this.waitForAnvil(containerId, 30_000);
  }

  private async waitForAnvil(
    containerId: string,
    timeoutMs: number
  ): Promise<void> {
    const start = Date.now();
    const pollInterval = 500;

    while (Date.now() - start < timeoutMs) {
      try {
        const result = await this.sandbox.exec(
          containerId,
          'cast block-number --rpc-url http://localhost:8545 2>/dev/null',
          5_000
        );

        if (result.exitCode === 0 && result.stdout.trim().length > 0) {
          return;
        }
      } catch {
        // Not ready yet
      }

      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(`Anvil failed to start within ${timeoutMs}ms`);
  }

  async getBlockNumber(containerId: string): Promise<number> {
    const result = await this.sandbox.exec(
      containerId,
      "cast block-number --rpc-url http://localhost:8545"
    );

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get block number: ${result.stderr}`);
    }

    return parseInt(result.stdout.trim(), 10);
  }

  async stopAnvil(containerId: string): Promise<void> {
    await this.sandbox.exec(containerId, "pkill -f anvil || true", 5_000);
  }
}
