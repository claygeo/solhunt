# LinkedIn Post Drafts

Multiple versions for different angles. Pick one or adapt.

---

## Version A: Technical achievement (safe, credible)

I built an autonomous AI agent that finds and exploits DeFi vulnerabilities. Here's what happened when I ran it against real historical hacks:

• Beanstalk ($182M exploit, April 2022) → found and exploited in **1m 44s for $0.65**
• Tested against [95 known DeFi hacks] from DeFiHackLabs
• Multi-model comparison: Claude Sonnet 4 vs Qwen3.5-35B-A3B
• Full pipeline: Etherscan source fetch → Anvil mainnet fork at exploit block → Docker sandbox → agent writes Solidity exploit test → Foundry verifies it works
• Detection rate: 33% (15/45)% on 95 contracts

The interesting part isn't the LLM. It's the sandbox infrastructure: forge/anvil tooling, auto-checksumming Ethereum addresses, flash loan interfaces baked into the system prompt, vm.prank false-positive guards.

Open source: github.com/claygeo/solhunt

Write-up with the gory details: [blog link]

#DeFi #Security #AI #SmartContracts

---

## Version B: Story / journey (engaging)

I had a question: can an AI agent autonomously find DeFi exploits?

Three weeks ago I didn't have an answer. Today I do: **partially, and "partially" is already useful.**

What I built (solhunt):
- Takes a contract address + block number
- Forks Ethereum mainnet at that block using Alchemy (archive access required)
- Docker sandbox preloaded with OpenZeppelin, Aave V3, Uniswap, Compound, Chainlink
- Claude/Qwen get tools: bash, file editor, forge test
- Agent iterates: read source, identify attack, write exploit, run test, fix errors
- Produces structured report or admits it can't

What I learned:
• **Outside voices save money.** Every time I consulted an adversarial sub-agent before spending, they pushed me toward smaller, better-targeted experiments.
• **Real cost is 50% over your projection.** Budgeted $0.89/contract. Actual: $1.34.
• **Circuit breakers aren't optional.** A $80 experiment can become $200 without one.
• **Fine-tuning isn't the answer (yet).** The sandbox is the bottleneck, not the model's IQ.

Benchmark results across 95 known DeFi hacks: [TK insert metrics]

Repo: github.com/claygeo/solhunt
Full write-up: [link]

---

## Version C: Hiring hook (explicit)

I'm Clayton. I just spent 3 weeks building an autonomous AI agent that exploits DeFi smart contracts. It found a delegatecall vulnerability in Beanstalk (historical $182M hack) in under 2 minutes for $0.65.

I'm looking for my next role in blockchain security, ML engineering, or DeFi infrastructure.

What the benchmark says:
• 95 real exploits tested across two models (Claude Sonnet 4, Qwen3.5-35B-A3B)
• Full conversation logs + exploit Solidity artifacts stored in Supabase
• [TK: final detection rate] across six vulnerability classes

What I did differently:
• Shipped 15+ commits of agent improvements based on actual failure data (not speculation)
• Consulted adversarial AI reviewers before every major spending decision
• Built a cost circuit breaker that physically cannot overspend
• Parsed DeFiHackLabs into a clean 95-contract class-balanced benchmark dataset

Companies I'd love to talk to: Certik, Trail of Bits, OpenZeppelin, Consensys Diligence, Sherlock, Spearbit, Code4rena. Or any DeFi protocol building security tooling in-house.

DMs open. Repo: github.com/claygeo/solhunt

---

## Version D: Dataset contribution (academic/research)

New open dataset for benchmarking AI-based smart contract auditors:

95 known DeFi exploits, class-balanced across:
- Access control (20)
- Price manipulation (20)
- Logic error (25)
- Reentrancy (18)
- Integer overflow (6)
- Flash loan (5)
- Other (1)

Each entry: contract address, fork block number, vulnerability class, historical loss, reference exploit URL. Fully reproducible via Alchemy archive node + Foundry.

Imported from DeFiHackLabs, deduplicated and curated with class balancing.

Results from two models:
• Claude Sonnet 4: 33% (15/45)
• Qwen3.5-35B-A3B: 33% (15/45)

Full benchmark infrastructure is open source. If you're working on AI-based security tooling, this should save you dataset curation time.

Dataset: github.com/claygeo/solhunt/blob/main/benchmark/dataset-100.json
Code: github.com/claygeo/solhunt
Write-up: [link]

---

## Notes for whoever posts this

1. Replace all 33% (15/45) with actual Phase 3 numbers
2. Add a single screenshot: either the benchmark terminal output, or a comparison table
3. Version C is most aggressive on the hiring angle - use if you want responses from recruiters
4. Version D is most impressive to researchers/academics
5. Version A/B are safest for a general professional audience
6. Tag relevant people: Certik, Trail of Bits, OpenZeppelin accounts
7. Post timing: Tuesday-Thursday, 8-10am EST gets best engagement
