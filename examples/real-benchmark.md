# Real benchmark example

This example records an end-to-end ContextGym experiment on a real local repository using Codex and a deterministic verifier.

## Setup

- Added context: approximately 64 tokens.
- Paired runs: 3 baseline + 3 candidate.
- Same repository source state, task, verifier, and sandbox.
- Candidate differed only by the ContextGym-managed repository context.

## Independent optimization run

```text
Success                    100% -> 100%
Mean token change          -53.9%
Observed tool change       -56.3%
Mean duration change       -29.4%
Paired token wins          3/3
Verdict                    KEEP_EFFICIENCY
```

An earlier independent 3-pair run on the same navigation target also retained 100% success while reducing mean total tokens by 40.0%, observed tool calls by 31.6%, and duration by 40.1%.

These are task-specific benchmark results and are not universal performance claims.
