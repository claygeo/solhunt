# solhunt

Autonomous AI agent that finds and exploits smart contract vulnerabilities. Give it a contract address (or a local `.sol` file), and it will fork the blockchain, analyze the source code, write a Solidity exploit test, execute it, debug failures autonomously, and produce a structured vulnerability report.

No human in the loop. The agent reads code, reasons about attack vectors, writes Solidity, runs `forge test`, reads compiler errors, fixes its own code, and iterates until the exploit passes or it runs out of attempts.

Inspired by the [Anthropic Fellows project (SCONE-bench)](https://www.anthropic.com/research/scone-bench) where AI agents discovered $4.6M in blockchain exploits across 405 known-vulnerable contracts.

## Verified Results

Tested against a reentrancy-vulnerable contract (VulnerableBank). The agent autonomously:

1. Read the contract source and identified the reentrancy vulnerability in `withdraw()`
2. Wrote a complete Solidity exploit test with an attacker contract using `receive()` callback
3. Encountered two compilation/logic errors (non-payable constructor, missing `deposit()` call)
4. Read the forge error output, diagnosed both issues, and fixed them without human input
5. Re-ran the test successfully, draining 101 ETH from the contract

| Run | Iterations | Duration | Model | Result |
|-----|-----------|----------|-------|--------|
| 1 | 7 | ~32 min | qwen3.5:27b (CPU) | Reentrancy found, exploit passed |
| 2 | 8 | ~37 min | qwen3.5:27b (CPU) | Confirmed, valid structured report |

Both runs used a 27B parameter model running on CPU via Ollama. No GPU, no paid API calls. The agent's structured output from Run 2:

```json
{
  "found": true,
  "vulnerability": {
    "class": "reentrancy",
    "severity": "critical",
    "functions": ["withdraw"],
    "description": "The withdraw function sends ETH before updating the balance..."
  },
  "exploit": {
    "testFile": "test/Exploit.t.sol",
    "testPassed": true,
    "valueAtRisk": "101 ETH (entire contract balance drained)"
  }
}
```

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│                      solhunt CLI                         │
│                   (TypeScript, Node.js)                   │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │ Ingestion │───>│  Agent Loop  │───>│   Reporter    │  │
│  │  Layer    │    │  (LLM API)   │    │  (structured  │  │
│  │           │    │              │    │   output)     │  │
│  └──────────┘    └──────┬───────┘    └───────────────┘  │
│       │                 │                                │
│       │          ┌──────v───────┐                        │
│       │          │  Tool Runner │                        │
│       │          │  (sandboxed) │                        │
│       │          ├──────────────┤                        │
│       │          │ bash         │                        │
│       │          │ text_editor  │                        │
│       │          │ read_file    │                        │
│       │          │ forge_test   │                        │
│       │          └──────┬───────┘                        │
│       │                 │                                │
│  ┌────v─────────────────v──────────────────────────┐    │
│  │              Docker Sandbox                       │    │
│  │  ┌─────────┐  ┌──────────┐  ┌────────────────┐  │    │
│  │  │  Anvil  │  │  Forge   │  │  Contract Src  │  │    │
│  │  │ (forked │  │  (build  │  │  (from Ethscan │  │    │
│  │  │  chain) │  │  & test) │  │  or local)     │  │    │
│  │  └─────────┘  └──────────┘  └────────────────┘  │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### The Agent Loop

The core loop in `src/agent/loop.ts`:

1. **System prompt** tells the agent it's a security researcher with access to a Foundry sandbox
2. **Analysis prompt** includes the contract source code, address, chain, and block number
3. Agent calls tools (bash, editor, forge_test) to analyze and exploit the contract
4. Each tool call executes inside an isolated Docker container via `docker exec`
5. Agent sees tool output, decides next action (fix code, run test again, try different approach)
6. Loop continues until the agent produces a structured report or hits max iterations

The agent has access to these vulnerability classes in its system prompt:
- Reentrancy
- Access control / authorization
- Integer overflow/underflow
- Price oracle manipulation
- Flash loan attacks
- Unchecked return values
- Delegatecall abuse
- Logic errors

### Smart Recovery

The loop has several mechanisms to keep the agent on track:

**Context-aware nudges.** When the model stops calling tools, the loop checks what stage the agent is at and sends a targeted nudge: "read the code first" vs "write the exploit" vs "fix the failing test" vs "output the report."

**Loop detection.** If the model calls `forge_test` 3 times in a row without fixing code, the loop forces it to rewrite the test file with a different approach.

**Conversation trimming.** To prevent context overflow on local models with limited context windows, the loop keeps the system prompt + analysis prompt + last 6 messages, and compresses everything in between (truncating long tool outputs to 200 chars).

**Report detection.** The agent wraps its findings in `===SOLHUNT_REPORT_START===` / `===SOLHUNT_REPORT_END===` markers. The loop watches for this in every response and breaks immediately when found, instead of wasting iterations on nudges.

### Sandbox Isolation

Each scan runs in its own Docker container built from `ghcr.io/foundry-rs/foundry:latest`:
- **Resource limits:** 2 CPU cores, 4GB RAM per container
- **Security:** `no-new-privileges` flag, no host network access
- **Lifecycle:** container created at scan start, destroyed after (pass or fail)
- **Pre-cached:** Forge project template with forge-std is pre-built in the image for fast scaffolding

The agent writes and executes arbitrary Solidity inside this sandbox. It cannot escape to the host.

### Multi-Provider Support

Works with any OpenAI-compatible API out of the box:

| Provider | Model | Cost | Notes |
|----------|-------|------|-------|
| **Ollama** (default) | qwen3.5:27b | Free | Runs locally on CPU, ~3-5 min/call |
| **Ollama** | qwen2.5-coder:32b | Free | Alternative local model |
| **OpenAI** | gpt-4o | ~$1.20/scan | Fast, good tool use |
| **Anthropic** | claude-sonnet-4-6 | ~$1.00/scan | Excellent at Solidity |
| **OpenRouter** | any model | varies | Access to 100+ models |

The Anthropic provider uses a full API adapter that converts between Anthropic and OpenAI message formats, including tool_use/tool_result conversion.

For local models that return tool calls as JSON text instead of structured `tool_calls`, the provider includes a robust JSON extractor that handles markdown code blocks, trailing garbage tokens (common with Qwen models), and malformed JSON.

## Setup

### Requirements

- **Node.js 20+**
- **Docker** (running)
- **Ethereum RPC endpoint** (Alchemy free tier works)
- **Etherscan API key** (free, needed for fetching contract source by address)

### Install

```bash
git clone https://github.com/claygeo/solhunt.git
cd solhunt
npm install
```

### Environment Variables

Create a `.env` file:

```bash
# Required
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
ETHERSCAN_API_KEY=YOUR_KEY

# Provider (pick one)
SOLHUNT_PROVIDER=ollama                  # default, free
# SOLHUNT_PROVIDER=anthropic             # needs ANTHROPIC_API_KEY
# SOLHUNT_PROVIDER=openai                # needs OPENAI_API_KEY
# SOLHUNT_PROVIDER=openrouter            # needs OPENROUTER_API_KEY

# API keys (only needed for paid providers)
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# OPENROUTER_API_KEY=sk-or-...

# Optional
# SOLHUNT_TOOL_TIMEOUT=60000             # per-tool timeout (ms)
# SOLHUNT_SCAN_TIMEOUT=3600000           # per-scan timeout (ms)
```

### Build the Docker Sandbox

```bash
docker build -t solhunt-sandbox .
```

This builds an image from `ghcr.io/foundry-rs/foundry:latest` with a pre-initialized Forge project template. Takes ~2 minutes on first build, cached after that.

### Set Up Ollama (for local inference)

```bash
# Install Ollama (https://ollama.com)
ollama pull qwen3.5:27b
```

Minimum requirements for qwen3.5:27b: 16GB RAM (22GB recommended). Runs on CPU at ~1500% utilization on a 16-core machine. First call takes ~9 minutes (cold KV cache), subsequent calls drop to 2-5 minutes.

## Usage

### Scan a contract by address

```bash
# Scan an Ethereum contract, forking at a specific block
npx tsx src/index.ts scan 0x1234...abcd --chain ethereum --block 19000000

# Let it use the latest block
npx tsx src/index.ts scan 0x1234...abcd
```

### Scan a local Solidity file

```bash
npx tsx src/index.ts scan ./contracts/VulnerableBank.sol
```

### Choose a different model

```bash
# Use Claude via Anthropic
npx tsx src/index.ts scan 0x1234... --provider anthropic --model claude-sonnet-4-6

# Use GPT-4o
npx tsx src/index.ts scan 0x1234... --provider openai

# Use a specific Ollama model
npx tsx src/index.ts scan 0x1234... --provider ollama-qwen35
```

### Dry run (preview without calling the model)

```bash
npx tsx src/index.ts scan 0x1234... --dry-run
```

Outputs: contract name, source files found, chain, block, provider, model. No API calls made.

### Run the benchmark suite

```bash
# Run against the full dataset
npx tsx src/index.ts benchmark --dataset ./benchmark/dataset.json

# Limit to 10 contracts, save results
npx tsx src/index.ts benchmark --limit 10 --output results.json

# Adjust concurrency (parallel scans)
npx tsx src/index.ts benchmark --concurrency 3
```

Benchmark output:
```
SOLHUNT BENCHMARK RESULTS
======================================================================
Dataset:    50 contracts
Total time: 4h 23m
Total cost: $61.00

Category              Tested   Exploited    Rate   Avg Cost
-----------------------------------------------------------
reentrancy                10         8     80.0%     $1.05
access-control            10         7     70.0%     $0.92
price-manipulation         8         5     62.5%     $1.44
...
-----------------------------------------------------------
TOTAL                     50        31     62.0%     $1.22
======================================================================
```

### Health check

```bash
npx tsx src/index.ts health
```

Verifies Docker is running, provider is configured, API keys are set, and RPC endpoint is reachable.

### CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `--chain <chain>` | Blockchain network | `ethereum` |
| `--block <number>` | Fork at specific block number | `latest` |
| `--provider <name>` | Model provider preset | `ollama` |
| `--model <model>` | Override model name | provider default |
| `--max-iterations <n>` | Max agent loop iterations | `30` |
| `--json` | Output structured JSON instead of formatted report | `false` |
| `--dry-run` | Preview scan config without running | `false` |

## Project Structure

```
solhunt/
├── Dockerfile                 # Foundry sandbox image
├── docker-compose.yml         # Resource limits + security config
├── package.json
├── tsconfig.json
│
├── src/
│   ├── index.ts               # CLI entry point (commander)
│   │
│   ├── agent/
│   │   ├── loop.ts            # Core agentic loop with nudging + loop detection
│   │   ├── tools.ts           # Tool schemas (bash, str_replace_editor, read_file, forge_test)
│   │   ├── executor.ts        # Sandboxed tool execution via Docker exec
│   │   ├── provider.ts        # Multi-provider abstraction (Ollama, OpenAI, Anthropic, OpenRouter)
│   │   └── prompts.ts         # System prompt + analysis prompt builder
│   │
│   ├── ingestion/
│   │   ├── etherscan.ts       # Fetch verified source from Etherscan v2 API (rate-limited)
│   │   ├── contracts.ts       # ABI parsing, function signature extraction
│   │   └── defi-hacks.ts      # DeFiHackLabs benchmark dataset loader
│   │
│   ├── sandbox/
│   │   ├── manager.ts         # Docker container lifecycle (create, exec, destroy)
│   │   ├── foundry.ts         # Forge project scaffolding inside container
│   │   └── fork.ts            # Anvil fork setup with health check polling
│   │
│   ├── reporter/
│   │   ├── format.ts          # ExploitReport + ScanResult types, cost calculation
│   │   ├── markdown.ts        # Terminal report rendering + benchmark table
│   │   └── severity.ts        # Severity scoring (critical/high/medium/low)
│   │
│   └── benchmark/
│       ├── runner.ts          # Batch evaluation with configurable concurrency
│       ├── scorer.ts          # Precision/recall calculation
│       └── dataset.ts         # Dataset curation from DeFiHackLabs
│
├── prompts/
│   └── system.md              # Full agent system prompt (vulnerability classes, tools, workflow)
│
├── test/                      # Unit + integration tests (vitest)
│   ├── agent/
│   ├── benchmark/
│   ├── e2e/
│   ├── ingestion/
│   ├── reporter/
│   └── sandbox/
│
└── benchmark/
    └── dataset.json           # Curated contracts from DeFiHackLabs
```

## Technical Details

### How the Agent Writes Exploits

The system prompt in `prompts/system.md` gives the agent:
- A Foundry environment overview (forge, anvil, cast commands)
- An exploit test template with proper imports and structure
- A list of useful `vm` cheatcodes (`vm.deal`, `vm.prank`, `vm.warp`, `vm.roll`)
- Instructions to use `cast` for on-chain state queries
- The exact output format with JSON markers

The analysis prompt in `src/agent/prompts.ts` includes the full contract source code inline (not behind a tool call), so the agent can start reasoning about vulnerabilities immediately without a read-code-first iteration.

### Provider Quirks Handled

- **undici headersTimeout:** Node.js `fetch` uses undici internally with a 5-minute default `headersTimeout`. Local models on CPU can take 5-9 minutes per response. solhunt overrides this globally to 10 minutes.
- **Qwen3.5 `/no_think` mode:** Qwen 3.5 models have a reasoning mode that adds 2-3 minutes of "thinking" per call on CPU. solhunt appends `/no_think` to disable it.
- **Tool call extraction:** Local models sometimes return tool calls as JSON text in the content field instead of structured `tool_calls`. The provider includes a multi-strategy JSON extractor (code block extraction, brace-matching with depth tracking, raw content parsing).
- **Forge fork URL:** `forge test` reads `foundry.toml` for fork config, but the anvil fork runs inside the container at `localhost:8545`. solhunt explicitly passes `--fork-url http://localhost:8545` to avoid hitting external RPCs.

### Cost Tracking

Built-in pricing for common models:

| Model | Input ($/1M tokens) | Output ($/1M tokens) |
|-------|---------------------|----------------------|
| claude-sonnet-4-6 | $3.00 | $15.00 |
| claude-opus-4-6 | $15.00 | $75.00 |
| gpt-4o | $2.50 | $10.00 |
| Ollama (any) | $0.00 | $0.00 |

A typical scan uses ~30K input tokens and ~3K output tokens. With Sonnet, that's about $0.14 per scan.

## Running Tests

```bash
# All tests
npm test

# Watch mode
npm run test:watch

# E2E tests (requires Docker)
npm run test:e2e

# Type check
npm run lint
```

## Deployment

solhunt is designed to run on a Linux VPS with Docker. Recommended specs:

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 4 cores | 16 cores |
| RAM | 8 GB | 32 GB |
| Disk | 20 GB | 40 GB |

For Ollama with qwen3.5:27b, 16 cores and 32GB RAM gives ~3-5 minute inference times on CPU. Smaller models (7B) work on 8GB.

```bash
# On VPS
git clone https://github.com/claygeo/solhunt.git
cd solhunt
npm install
docker build -t solhunt-sandbox .
ollama pull qwen3.5:27b
cp .env.example .env  # fill in keys
npx tsx src/index.ts health
npx tsx src/index.ts scan ./test/fixtures/VulnerableBank.sol
```

## Tech Stack

- **TypeScript + Node.js** - CLI and agent orchestration
- **Ollama** - local LLM inference (qwen3.5:27b, qwen2.5-coder:32b)
- **Foundry** (forge, anvil, cast) - Solidity compilation, testing, blockchain forking
- **Docker** - sandbox isolation for arbitrary code execution
- **Etherscan API v2** - verified contract source code retrieval
- **dockerode** - Docker API client for Node.js

## Not in Scope

- **Web UI.** This is a CLI tool.
- **Real-time monitoring.** No mempool watching or live contract monitoring.
- **Automated mainnet exploitation.** This is a research and analysis tool.
- **Multi-chain in v1.** Ethereum mainnet only. Adding BSC/Polygon/Arbitrum is a config change.

## License

MIT
