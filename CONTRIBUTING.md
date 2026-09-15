# Contributing to ContextGym

ContextGym is an experiment-driven context optimizer for coding agents. Contributions are welcome, especially around new agent adapters, safer evaluation, better noise filtering, and reproducible benchmarks.

## Development

Requirements: Node.js 20+, Git, and (for real A/B evaluation) a locally authenticated Codex CLI.

```bash
npm install
npm run check
npm run build
node dist/index.js --help
```

## Design rules

1. **Evidence before automation.** A repeated behavior is evidence, not automatically a repository rule.
2. **Deterministic verification first.** When a verifier exists, it decides task success.
3. **Local-first and privacy-safe.** Do not require cloud accounts, telemetry, or full prompt storage for core workflows.
4. **No silent repository mutation.** `optimize` proposes/tests; `apply` is explicit and guarded.
5. **Do not overclaim metrics.** Tool-call counts are best-effort observed counts when the upstream event stream is incomplete.
6. **Keep A/B comparisons fair.** Baseline and candidate must use the same source state, task, verifier, sandbox, and run count.

## Pull requests

Keep changes focused. Include a reproduction or smoke test for behavioral changes. Never commit user prompts, tokens, private repositories, or raw session histories.
