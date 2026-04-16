# I Built an Autonomous AI Agent That Finds DeFi Exploits. Here's What Happened.

Across 45 known DeFi hacks, my agent autonomously found and proved **15 exploits (33%)** for a total cost of **$16.56** across two models (Claude Sonnet 4 and Qwen3.5-35B-A3B). Human-equivalent audit cost: ~$450K+.

## The Pitch (30 seconds)

- **Input**: an Ethereum contract address + block number
- **Output**: a working Foundry exploit test, or a report that no vulnerability was found
- **No human in the loop**: agent reads source, decides attack class, writes Solidity, iterates on errors, produces a pass/fail proof
- **Beanstalk ($182M historical hack)**: found and exploited in **1m 44s for $0.65**
- **DFX Finance ($7.5M reentrancy)**: found and exploited in **4m 52s for $3.25**

If you want to skip the story: [github.com/claygeo/solhunt](https://github.com/claygeo/solhunt)

---

## Why This Matters

DeFi exploits stole **over $3.7B in 2022 alone**. The defensive side - auditors like Trail of Bits, OpenZeppelin, Certik - charge $10K-100K per audit and can't scale. The offensive side - white-hat bug bounty hunters - take days or weeks per contract.

Large language models like Claude and Qwen can write code. Could they find and prove vulnerabilities autonomously?

Turns out: partially. And "partially" is already useful.

## The Architecture

The agent runs in a loop:

1. **Fetch source** via Etherscan API
2. **Start Anvil fork** of mainnet at the exploit block (archive node required - free public RPCs don't serve historical state, Alchemy's free tier does)
3. **Inject source** into a Docker sandbox preloaded with OpenZeppelin, Uniswap V2/V3, Aave V3, Compound, Chainlink
4. **Give the LLM tools**: bash, str_replace_editor, read_file, forge_test
5. **Iterate**: agent reads code, identifies attack class, writes an exploit test as a Solidity file (using interfaces only to avoid version conflicts with source), runs forge test, fixes errors, repeats
6. **Produce report**: JSON with class, severity, functions, description, test file path, pass/fail

Every run persists to Supabase: scan_runs table for the summary, tool_calls table for per-iteration data, storage bucket for the exploit.sol + conversation.json.gz artifacts.

## The Hard Parts

### 1. Compilation version hell
Real DeFi contracts use Solidity 0.6.x, 0.7.x, sometimes 0.5.x. Forge-std is 0.8.x. You can't compile them together. The agent keeps rediscovering `mv src src_backup` as a workaround. I eventually documented this as a standard pattern in the system prompt.

### 2. EIP-55 checksum hell
LLMs love to output lowercase hex addresses. Forge rejects them with checksum errors. The agent would burn 5-10 iterations fighting this. Fixed by auto-checksumming every address in Solidity files the agent writes.

### 3. `vm.prank(admin)` false positives
The cheatcode `vm.prank(address)` makes the next call appear to come from `address`. Foundry uses this to test admin-only functions. But an AI agent will cheerfully use `vm.prank(admin)` to call `_setImplementation(attacker_contract)` and declare "EXPLOIT FOUND." That's not an exploit. That's an admin doing admin things.

The agent did exactly this on Inverse Finance - reported a "critical access control vulnerability" at $0.72/scan. I added explicit guidance to the system prompt about when `vm.prank` is valid (pranking a whale for their balance, pranking an EOA to test open access, pranking a governance executor *after* winning a vote with flash-loaned tokens) and when it's not (pranking the owner to call owner functions). On the retest, the agent correctly concluded "not exploitable" after 15 iterations of trying legitimate attack vectors.

### 4. The circuit breaker
I ran a baseline experiment: 3 contracts, $0.89 projected per contract. Actual? $1.34. That's 50% over budget with no way to stop the bleed.

An outside voice (literally: I spun up an adversarial sub-agent to review my plan) said "no circuit breaker = no experiment." They were right.

Fixed by adding `--max-budget <usd>` to the benchmark CLI. Benchmark stops between batches if cumulative cost exceeds the cap. Zero extra infrastructure, maybe 30 lines of code, saves you from the worst-case scenario where a contract loops for 30 iterations at $3+ each.

## Phase 1: Agent Intelligence Upgrades

Before scaling to 95 contracts I ran a controlled A/B: same 3 contracts, original agent vs upgraded agent, same Claude Sonnet 4.

| Contract | Before | After | Signal |
|---|---|---|---|
| Beanstalk ($182M) | ✓ 2m26s / $0.84 | ✓ 1m44s / $0.65 | 22% faster, cheaper |
| Saddle Finance | FALSE POSITIVE $2.83 | ✗ correctly NOT FOUND $2.14 | No hallucination |
| Inverse Finance | ✗ $0.43 | FALSE POSITIVE → fixed → ✗ correct $1.24 | vm.prank fix worked |

The raw detection rate didn't change (1/3). But the **quality of both successes and failures became trustworthy.** Before the upgrades, the "found" results were poisoned by false positives. Now every result is real signal.

Key upgrades shipped:
- Smart context trimming (preserve forge test output up to 5KB, error messages up to 2KB, aggressively truncate verbose source reads)
- Flash loan interfaces baked into the system prompt (Aave V2, Uniswap V2, dYdX - most DeFi exploits need one)
- EIP-55 auto-checksumming via keccak256
- Structural pattern detection (auto-hint to the agent when source contains "uniswap", "aave", "delegatecall", proxy patterns)
- vm.prank false-positive guard (rules for valid vs invalid uses)
- Dockerfile expanded with Aave V3, Compound, OZ upgradeable, Uniswap periphery

## Phase 2: Building the Dataset

Started with 32 hand-curated contracts. Not enough for a real benchmark. Wrote an import script that parses [DeFiHackLabs](https://github.com/SunWeb3Sec/DeFiHackLabs) (689 known exploits with Foundry PoCs) and extracts the Ethereum-chain contracts with all required fields.

Result: 95-contract class-balanced dataset:

- logic-error: 25
- price-manipulation: 20
- access-control: 20
- reentrancy: 18
- integer-overflow: 6
- flash-loan: 5
- unchecked-return: 1

Each contract has: address, fork block, vulnerability class, historical loss amount, reference exploit URL.

## Phase 3: The Multi-Model Benchmark

Ran Qwen3.5-35B-A3B across a 45-contract subset (circuit breaker fired at budget cap). Then ran Claude Sonnet 4 on a curated list of "hard failure" candidates Qwen couldn't crack. Combined results:

**45 unique contracts. 15 validated exploits. 33% detection rate. $16.56 total.**

### Per-Class Breakdown

| Vulnerability Class | Tested | Exploited | Rate |
|---|---|---|---|
| flash-loan | 2 | 1 | 50.0% |
| price-manipulation | 12 | 6 | 50.0% |
| reentrancy | 6 | 2 | 33.3% |
| access-control | 13 | 4 | 30.8% |
| logic-error | 10 | 2 | 20.0% |
| integer-overflow | 2 | 0 | 0.0% |

### The Interesting Splits

**Qwen3.5 sweet spot:** Cheap access-control exploits. 6 of the 15 exploits came from Qwen at $0.07-0.15 each. For contracts with a clear access-control flaw (forgotten admin function, unrestricted initializer), the small MoE model crushes it.

**Sonnet's premium:** Complex reentrancy. DFX Finance was the standout - Sonnet proved the `flash()` function's CEI violation in 19 iterations for $3.25. Qwen couldn't get this one past max iterations.

**Where both failed:** Integer-overflow (0/2). These require arithmetic insight neither model brought. Also: most logic-errors (80% failed). These bugs live in multi-protocol interactions that neither model's sandbox navigates well.

### Cost vs Human Audit

| Approach | Cost for 45 contracts | Time |
|---|---|---|
| Human auditor (Trail of Bits, OpenZeppelin tier) | $450K–2.25M | 3-9 months |
| solhunt (Qwen + Sonnet combined) | $16.56 | ~5 hours |

~27,000x cheaper. Worse detection rate (humans still find things we miss), but this isn't a replacement for human audit - it's a first-pass screen.

## What I Learned

**1. Outside voices save money.** Every time I consulted an adversarial sub-agent before making a spending decision, they pushed me toward a cheaper, better-targeted experiment. Human intuition says "run more contracts." Adversarial intuition says "your baseline is n=3, what are you even measuring?"

**2. Motion ≠ information.** I was about to run 5 brand-new contracts to test my agent upgrades. The outside voice pointed out this was useless: with only 3 baseline data points, I couldn't distinguish "my changes helped" from "different contracts behave differently." The correct experiment was re-running the *same* 3 contracts. Cheaper and gave actual signal.

**3. Fine-tuning isn't the answer for this problem (yet).** It's tempting to think "a fine-tuned exploit model would crush this." But the gating problem isn't the model's intelligence - it's the sandbox. Qwen3.5 correctly identified reentrancy in DFX Finance's `flash()` function on its first attempt. It just couldn't orchestrate the flash loan + token balance manipulation in 19 iterations. Better cheatcodes, better sandbox, better tooling would move the needle more than fine-tuning.

**4. The dataset is the moat.** Anyone can wire up Claude + Foundry. The value is in the benchmark data: per-model detection rates, cost curves, per-class breakdowns, full conversation logs. That's expensive and time-consuming to reproduce.

## What's Next

I'm publishing the dataset (95 contracts + per-model results) and open-sourcing the repo. If you work in DeFi security and want to improve on this, that's the starting point.

Specific things I'd welcome collaboration on:
- Better sandbox tooling (dynamic library installation, smarter `deal()` fallbacks for non-standard token storage)
- A proper MEV/arb bot built on the same infrastructure
- Running the benchmark across more models (GPT-4o, Gemini Pro, DeepSeek, fine-tuned variants)

**If you're hiring in blockchain security research, ML engineering, or DeFi infra**, I'm open to conversations. My email is in the repo.

---

*Built with: TypeScript, OpenRouter (Claude Sonnet 4 + Qwen3.5-35B-A3B), Foundry, Docker, Supabase, Alchemy. Repo: [github.com/claygeo/solhunt](https://github.com/claygeo/solhunt).*
