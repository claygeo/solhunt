# solhunt Architecture

## End-to-end scan flow

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant CLI as solhunt CLI
    participant ES as Etherscan API
    participant Docker as Docker Sandbox
    participant Anvil as Anvil Fork
    participant LLM as LLM (Claude/Qwen)
    participant SB as Supabase

    User->>CLI: benchmark --dataset X --model Y
    CLI->>SB: insertBenchmarkRun()

    loop Each contract
        CLI->>ES: Fetch source code
        ES-->>CLI: Solidity files
        CLI->>Docker: Create isolated container
        Docker->>Anvil: Start fork at historical block
        Note over Anvil: Alchemy archive RPC required<br/>for historical state

        CLI->>LLM: System prompt + source + recon
        loop Up to 30 iterations
            LLM-->>CLI: Tool calls (bash, str_replace_editor, forge_test)
            CLI->>Docker: Execute tool
            Docker-->>CLI: Output
            CLI->>SB: Log tool_call row
            CLI->>LLM: Tool result (smart-trimmed)
        end

        LLM-->>CLI: ===SOLHUNT_REPORT_START=== JSON ===
        CLI->>SB: insertScanRun() + upload artifacts
        CLI->>Docker: Destroy container
    end

    CLI->>SB: updateBenchmarkRun() aggregate
    CLI->>User: Results table + cost summary
```

## Data model

```mermaid
erDiagram
    benchmark_runs ||--o{ scan_runs : produces
    scan_runs ||--o{ tool_calls : logs
    contracts ||--o{ scan_runs : scanned
    scan_runs ||--o{ artifacts : generates

    benchmark_runs {
        uuid id PK
        string provider
        string model
        int total
        int exploited
        float success_rate
        float total_cost
        timestamp created_at
    }

    scan_runs {
        uuid id PK
        uuid contract_id FK
        uuid benchmark_run_id FK
        bool found
        bool test_passed
        string vuln_class
        string severity
        float cost_usd
        int iterations
        int max_iterations
        string exploit_code_path
        string forge_output_path
        string conversation_path
    }

    tool_calls {
        int id PK
        uuid scan_run_id FK
        int iteration
        string tool_name
        int duration_ms
        bool is_error
        string summary
    }

    contracts {
        uuid id PK
        string address
        string chain
        string name
        int block_number
        string vuln_class
        string description
        string date_exploited
        string value_impacted
    }
```

## Agent loop state machine

```mermaid
stateDiagram-v2
    [*] --> Read: initial prompt
    Read --> Identify: source read
    Identify --> Write: pattern detected
    Write --> Test: exploit.t.sol created
    Test --> Write: compile error<br/>(str_replace)
    Test --> Test: forge fails<br/>(retry different vector)
    Test --> Report: forge passes
    Identify --> Report: no exploit found<br/>after iter N
    Write --> Report: iteration budget hit
    Report --> [*]

    Read: read source files
    Identify: identify attack vector
    Write: write exploit test
    Test: run forge_test
    Report: emit SOLHUNT_REPORT
```

## Key design decisions

### Why Docker sandbox per scan
- Isolation: agent can't escape or affect host
- Reproducibility: every scan starts from identical state
- Preloaded DeFi libs (Aave V3, Compound, Uniswap V2/V3, OZ v4+v5, Chainlink)
- Destroyed after scan, no lingering state

### Why Alchemy (archive node)
- Historical block forking requires archive state
- Free public RPCs (llamarpc, publicnode) don't serve archive state
- Alchemy free tier: 300M compute units/month, sufficient for benchmarks
- We hit this as a hard blocker before switching

### Why Supabase for persistence
- Separates transactional data (pg) from artifacts (storage bucket)
- Service role key = no auth surface for our internal pipeline
- Artifacts stored as `runs/<scan_id>/{exploit.sol, conversation.json.gz, forge_output.txt}`
- Queryable from analysis scripts without re-fetching

### Why fire-and-forget flush pattern
- `DataCollector` buffers tool calls, messages, artifacts in memory during scan
- One `flush(scanRunId)` call after scan completes
- All Supabase writes wrapped in try/catch that never throws
- Scan result is never blocked by storage failures
- If Supabase is down, we still get the scan result, we just lose persistence for that run

### Why auto-checksum addresses
- LLMs emit lowercase hex addresses frequently
- Forge rejects with EIP-55 checksum errors
- Agent wastes 5-10 iterations fighting this
- Fix: regex replace all 0x[40 hex] with keccak256-computed checksums on every .sol file write

### Why vm.prank false-positive guard
- `vm.prank(admin)` makes next call appear from admin
- Agent discovered it could "exploit" access-controlled functions this way
- But pranking as owner to call owner functions proves nothing
- System prompt now lists valid uses (whale, EOA, governance-after-vote) and flags invalid use

## Cost circuit breaker

Two layers of protection:

1. **Failure circuit breaker** (existing):
   - If last 3 contracts all failed without producing a report → stop
   - If last 3 contracts all hit the same error → stop

2. **Budget circuit breaker** (new):
   - `--max-budget <usd>` global cap
   - Checks cumulative cost between batches
   - Stops immediately if cap exceeded
   - Warns at 75% usage

Without these, a stuck agent in a 30-iteration loop at $3+ per contract could burn through a $80 budget in the first ~27 contracts.

## Model abstraction

```mermaid
flowchart LR
    Agent[Agent Loop] --> Provider{Provider}
    Provider -->|openai format| Claude[Claude Sonnet 4]
    Provider -->|openai format| Qwen[Qwen3.5-35B-A3B]
    Provider -->|openai format| GPT[GPT-4o]
    Provider -->|openai format| Gemini[Gemini 2.0 Flash]
    Provider -->|anthropic SDK| Direct[Direct Anthropic]
    Provider -->|localhost| Ollama[Ollama local models]
```

One provider abstraction, multiple backends. Qwen-specific handling: append `/no_think` to disable reasoning on local models. Cost calculated per-token against PRICING table.
