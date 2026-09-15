# 30-second demo script

Goal: show the complete value proposition without explaining internals first.

## Scene 1 — The problem (0–5s)

Terminal title: `Stop guessing what belongs in AGENTS.md.`

```powershell
contextgym optimize --project D:\demo\repo --runs 3 --top 1
```

Show the optimization plan:

```text
Historical findings           113
Context proposals               1
Proposal context              ~64 tokens
Planned Codex invocations       6
```

## Scene 2 — Experiment (5–18s)

Jump to the paired A/B result:

```text
KEEP_EFFICIENCY  manuscript/sections/experiments.tex
success 100% -> 100%
tokens -53.9% · tools -56.3% · time -29.4%
paired token wins 3/3
```

Overlay: `Same repo. Same task. Same verifier. Only context changed.`

## Scene 3 — Evidence (18–25s)

Open the HTML report and highlight:

- Success: `100% -> 100%`
- Token change: `-53.9%`
- Observed tools: `-56.3%`
- Duration: `-29.4%`
- Verdict: `KEEP`

## Scene 4 — Apply (25–30s)

```powershell
contextgym apply --report .contextgym/optimizations/<report>.json --dry-run
```

Show the managed `AGENTS.md` block.

End card:

> ContextGym — Test your context before you keep it.
