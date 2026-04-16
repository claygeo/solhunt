# LinkedIn Post — Final Version (honest numbers)

## Recommended post

I've been building a lot in 2026. A cannabis pricing scraper. A Miami condo risk tool. An AI agent that exploits DeFi smart contracts.

I'm committing to the third one.

Solhunt is an autonomous AI agent that finds and exploits smart contract vulnerabilities. No human in the loop: it forks Ethereum at the exploit block, reads source, writes a Foundry test in Solidity, runs it, iterates on errors, and produces a pass/fail proof.

Just ran it against 45 real DeFi hacks from DeFiHackLabs. Multi-model benchmark, Claude Sonnet 4 + Qwen3.5-35B-A3B.

Results:

• **15 exploits autonomously proven (33%)**
• **Total cost: $16.56**
• **Human-equivalent audit cost: $450K - $2.25M (~27,000x cheaper)**
• Beanstalk ($182M hack) exploited in 1m 44s for $0.65
• DFX Finance ($7.5M reentrancy) exploited in 4m 52s for $3.25

What I actually learned building this:

→ **AI agents love to "cheat" with vm.prank(admin)** and claim false-positive exploits. Added explicit guardrails after seeing it first-hand.

→ **Budget projections are 50% off reality.** Shipped a cost circuit breaker that physically cannot overspend.

→ **Smaller models have their niche.** Qwen3.5-35B-A3B handled most access-control exploits at $0.07-$0.15 per contract. Sonnet only needed for complex reentrancy + proxy patterns.

→ **Sandbox tooling matters more than model intelligence.** Both models hit the same ceiling on contracts requiring flash-loan orchestration across protocols. The model isn't the bottleneck - our infrastructure is.

Repo: github.com/claygeo/solhunt
Full write-up with the gory details: [link]

Open to conversations with security firms, DeFi protocols, and ML infrastructure teams. DMs open.

---

## Why this version

Under 250 words. Leads with concrete numbers. Acknowledges the scattered feed without apologizing. Four "what I learned" bullets show depth of thinking. Explicit CTA with target audiences named.

## What to attach as visual

Option A (recommended): Per-class results table as an image. Clean, credible, scannable.

Option B: Terminal screenshot of the actual Beanstalk exploit moment ("[1/1] EXPLOITED 1m 44s $0.65"). Visceral but mobile-unfriendly.

Option C: Both - the table as the main image, terminal screenshot in a comment reply.

## When to post

Not today. Wait until:
1. Repo README is polished (DONE - commit 9c75935)
2. Blog post is published somewhere (Medium, Substack, personal site)
3. You have one night to sleep on the draft

Best posting time: **Tuesday-Thursday, 8-10am EST.** Highest LinkedIn engagement for technical audiences.

## Tagging strategy

Tag sparingly. Bad: tagging 10 random people. Good: 1-2 relevant accounts that might engage.

Consider tagging:
- @Trail of Bits (if you want their security team to notice)
- @OpenZeppelin (same)
- @Certik (same)
- A specific DeFi protocol you admire (creates dialogue)

Don't tag: random influencers, "AI thought leaders," anyone you don't have a reason to tag.

## Follow-up plan

If the post hits well (20+ reactions):
- Pin to profile
- Reply to every comment with substance
- DM 3-5 people who engaged meaningfully
- Post a follow-up thread about one specific finding (e.g., "the vm.prank false positive problem")

If it flops (<10 reactions):
- Not the numbers - that's the feed. Try again in 2 weeks with a different angle.
- Maybe lead with "DFX Finance exploited in 4 minutes" as the hook instead.
