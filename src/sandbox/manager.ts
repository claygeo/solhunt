import Docker from "dockerode";

const SANDBOX_IMAGE = "solhunt-sandbox";
const CONTAINER_PREFIX = "solhunt-scan-";

export interface SandboxOptions {
  rpcUrl: string;
  cpuLimit?: number;
  memoryLimit?: number;
  timeout?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class SandboxManager {
  private docker: Docker;
  private imageBuilt = false;

  constructor(dockerOptions?: Docker.DockerOptions) {
    this.docker = new Docker(dockerOptions);
  }

  async ensureImage(): Promise<void> {
    if (this.imageBuilt) return;

    const images = await this.docker.listImages({
      filters: { reference: [SANDBOX_IMAGE] },
    });

    if (images.length === 0) {
      throw new Error(
        `Docker image "${SANDBOX_IMAGE}" not found. Run: docker build -t ${SANDBOX_IMAGE} .`
      );
    }

    this.imageBuilt = true;
  }

  async createContainer(
    scanId: string,
    options: SandboxOptions
  ): Promise<string> {
    await this.ensureImage();

    const containerName = `${CONTAINER_PREFIX}${scanId}`;

    const container = await this.docker.createContainer({
      Image: SANDBOX_IMAGE,
      name: containerName,
      Cmd: ["sleep", "infinity"],
      Env: [`ETH_RPC_URL=${options.rpcUrl}`],
      HostConfig: {
        NanoCpus: (options.cpuLimit ?? 2) * 1e9,
        Memory: (options.memoryLimit ?? 4) * 1024 * 1024 * 1024,
        SecurityOpt: ["no-new-privileges"],
        ReadonlyRootfs: false,
      },
      WorkingDir: "/workspace",
    });

    await container.start();
    return container.id;
  }

  async exec(
    containerId: string,
    command: string,
    timeout?: number
  ): Promise<ExecResult> {
    const container = this.docker.getContainer(containerId);
    const effectiveTimeout = timeout ?? 60_000;

    const exec = await container.exec({
      Cmd: ["bash", "-c", command],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: "/workspace/scan",
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Command timed out after ${effectiveTimeout}ms: ${command}`));
      }, effectiveTimeout);

      exec.start({ hijack: true, stdin: false }, (err, stream) => {
        if (err || !stream) {
          clearTimeout(timer);
          reject(err ?? new Error("No stream returned from exec"));
          return;
        }

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        // Docker multiplexes stdout/stderr into one stream with headers
        stream.on("data", (chunk: Buffer) => {
          // Docker stream header: 8 bytes, first byte is stream type
          // 1 = stdout, 2 = stderr
          let offset = 0;
          while (offset < chunk.length) {
            if (offset + 8 > chunk.length) break;
            const type = chunk[offset];
            const size = chunk.readUInt32BE(offset + 4);
            const payload = chunk.subarray(offset + 8, offset + 8 + size);

            if (type === 1) {
              stdout.push(payload);
            } else if (type === 2) {
              stderr.push(payload);
            }
            offset += 8 + size;
          }
        });

        stream.on("end", async () => {
          clearTimeout(timer);
          try {
            const inspection = await exec.inspect();
            resolve({
              stdout: Buffer.concat(stdout).toString("utf-8"),
              stderr: Buffer.concat(stderr).toString("utf-8"),
              exitCode: inspection.ExitCode ?? 1,
            });
          } catch {
            resolve({
              stdout: Buffer.concat(stdout).toString("utf-8"),
              stderr: Buffer.concat(stderr).toString("utf-8"),
              exitCode: 1,
            });
          }
        });

        stream.on("error", (streamErr: Error) => {
          clearTimeout(timer);
          reject(streamErr);
        });
      });
    });
  }

  async writeFile(
    containerId: string,
    path: string,
    content: string
  ): Promise<void> {
    // Escape content for shell
    const escaped = content.replace(/'/g, "'\\''");
    await this.exec(containerId, `mkdir -p "$(dirname '${path}')" && cat > '${path}' << 'SOLHUNT_EOF'\n${content}\nSOLHUNT_EOF`);
  }

  async readFile(containerId: string, path: string): Promise<string> {
    const result = await this.exec(containerId, `cat '${path}'`);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read ${path}: ${result.stderr}`);
    }
    return result.stdout;
  }

  async destroyContainer(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: 5 }).catch(() => {});
      await container.remove({ force: true });
    } catch {
      // Container may already be removed
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }
}
