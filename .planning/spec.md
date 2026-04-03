# P1 Fixes — Spec

## What are we fixing?

Two P1 issues discovered during smoke testing of the `kb` CLI tool.

### Issue 1: Duplicate Articles (P1)
**Problem:** When 2+ raw docs cover overlapping topics, `kb compile` creates separate articles with near-identical titles (e.g., "Load Balancing in MoE" and "Load Balancing in Mixture of Experts"). 
**Impact:** Data pollution, confused query context, wasted tokens, worsens over time.
**Root cause:** Compile prompt doesn't check existing wiki articles for semantic duplicates before creating new ones.

### Issue 2: Truncated Articles (P1)
**Problem:** Articles from large raw docs get cut off mid-sentence during compilation.
**Impact:** Bad data quality that cascades to query answers.
**Root cause:** LLM runs out of output tokens (`maxTokens: 8192`) when generating many articles from a single large raw doc. No explicit instruction to keep articles concise or to handle length limits.

## Success Criteria
1. Running `kb compile` on overlapping raw docs should NOT create duplicate articles — it should merge or update existing ones
2. No wiki article should end mid-sentence after compilation
3. Existing functionality (incremental compile, index rebuild, etc.) must not regress

## Constraints
- Stack: Bun + TypeScript
- LLM: CLIProxyAPIPlus (Sonnet)
- Must be backward-compatible with existing KBs

## Out of Scope
- Deduplication of already-existing duplicate articles (that's a `kb lint --fix` concern)
- Phase 3 features
