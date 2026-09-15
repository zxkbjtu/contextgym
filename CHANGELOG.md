# Changelog

## 0.8.0

- Added `contextgym apply` for explicitly applying validated KEEP proposals to `AGENTS.md`.
- Apply uses an idempotent managed block and preserves all human-authored content outside the block.
- Apply refuses stale optimization reports when the repository HEAD changed, unless `--force` is explicitly used.
- Apply defaults to review/confirmation and supports `--dry-run` and `--yes`.
- Added `contextgym report` to generate a standalone local HTML optimization report with success, efficiency, paired wins, Context ROI, and probe details.
- Reworked the README around the end-to-end experiment-driven workflow and real paired Codex benchmark results.
- Kept optimize non-mutating: the real repository is changed only through the separate explicit apply command.

## 0.7.0

- Add `contextgym optimize`, a one-command pipeline for history parsing, friction mining, proposal generation, deterministic probes, paired A/B evaluation, and Context ROI.
- Default to an interactive cost gate before any Codex invocation; `--yes` enables unattended execution and `--dry-run` is plan-only.
- Print planned Codex invocation count before evaluation.
- Skip auto-probes whose target files are not tracked by Git, avoiding evaluation against files absent from isolated worktrees.
- Refuse optimize when tracked working-tree changes are present, keeping proposal inspection and A/B source state aligned.
- Produce a persistent optimization report under `.contextgym/optimizations/`.
- Keep generated context review-only; v0.7 does not auto-edit the user's real `AGENTS.md`.

## 0.5.2

- Fix A/B success aggregation when a deterministic verifier passes after recoverable Codex JSON `error` events.
- Treat only terminal `turn.failed` as a failed Codex turn; top-level recoverable `error` events no longer poison a completed run.
- With `--verify` / `--verify-file`, the deterministic verifier is the task-level source of truth (while still requiring a successful, non-timed-out Codex process).

## 0.5.0 — Context A/B Evaluator

- Add `contextgym eval` for isolated baseline-vs-candidate Codex experiments.
- Create detached temporary Git worktrees from the exact same repository `HEAD`.
- Inject proposal context only into the candidate worktree's root `AGENTS.md`.
- Commit candidate context inside the temporary worktree and create a matching empty control commit in the baseline worktree so both arms start clean at the same history depth.
- Feed the exact same task to both arms through stdin, avoiding Windows prompt-quoting/length issues.
- Support deterministic `--verify` commands; without one, success is explicitly limited to agent completion.
- Capture Codex `turn.completed` token usage, duration, changed files, and best-effort observed item/tool-call counts.
- Alternate baseline/candidate execution order across paired repetitions to reduce time-order bias.
- Treat fewer than 3 paired runs as `SMOKE_ONLY`; only repeated experiments can emit KEEP/REJECT verdicts.
- Never store task prompt text in the eval report by default; persist only source, hash, and character length.
- Refuse A/B evaluation when the target repository has been deleted or is not the Git root.
- Clean temporary worktrees automatically unless `--keep-worktrees` is requested.

## 0.4.0 — Context Proposal Generator

- Add `contextgym propose` for review-only context draft generation.
- Group proposals by repository and emit one compact Markdown draft per project.
- Generate repository-map hints from repeated high-value file discovery.
- Generate preferred-command rules from fail→success recovery findings.
- Inspect only a bounded local file prefix and extract lightweight structure (Markdown headings, Python classes/functions/docstring hints, LaTeX title/section/includes).
- Estimate added Context tokens and retain historical avoidable-tool-call evidence for later Context ROI evaluation.
- Exclude files outside the repository root from repository proposals, including Codex plugin/runtime cache files.
- Ignore low-value persistent-context targets such as `.gitignore`, lockfiles and `references.bib`.
- Downgrade obvious entry-point files such as `README.md` and `main.tex` instead of automatically proposing redundant role notes.
- Fix cross-platform read-path handling for Windows drive paths, UNC paths and POSIX absolute paths.
- Never modify `AGENTS.md` / `CLAUDE.md` in the proposal stage.

## 0.3.2 — Friction triage

- Fix false read-path extraction from commands such as `tail -n 1` and PowerShell pipelines ending in `ConvertFrom-Json`.
- Treat `latexmk` as a build command.
- Collapse identical failing commands seen in multiple repositories into a global environment finding.
- Classify findings by scope: `repository`, `environment`, `workflow`, or `investigate`.
- Classify findings by action: `propose`, `investigate`, or `ignore`.
- Add `evidenceLevel` and `proposalScore` to proposal-worthy findings.
- Avoid duplicate repeated-failure findings when a stronger fail→success recovery pattern already exists.
- Add `contextgym mine --proposals-only` to expose only findings safe enough for Step 4 proposal generation.
- Mine report schema is now version 2.

## 0.3.1

- Add friction miner for repeated failures, command recovery, loops, repeated reads, and aborted turns.
- Parse Codex `turn_aborted` into failed `turn_end` events.
- Redact common secret patterns before storing commands in reports.

## 0.4.1
- Replaced Unicode em-dashes/curly quotes in generated drafts with ASCII-safe punctuation for Windows PowerShell compatibility.
- Added path/name-based role inference so proposals remain useful when source-file inspection is unavailable.
- Improved Python, Markdown, and LaTeX role summaries with file-specific responsibility hints.
- Grouped proposal drafts into Project status and decisions, Core model, Experiments, and Manuscript sections.
- Compact-rendered related experiment variants to reduce repetitive context tokens.
- Added inspected/path-fallback diagnostics to `contextgym propose` output.

## 0.5.2

- Added `contextgym eval --verify-file FILE` and made it the recommended verifier path on Windows.
- Avoided PowerShell/native-process quote loss for deterministic verifier scripts.
- Added per-run verifier diagnostics: exit code, pass/fail, stdout/stderr tail, and exact changed-file list.
- Fixed changed-file reporting so leading characters are not dropped from porcelain Git paths.

## 0.6.0
- Added Context ROI analysis (token savings, tool-call savings, time savings, paired wins, gross token leverage).
- Added `contextgym roi --report FILE` for old and new eval reports.
- Added automatic deterministic repository-navigation probe generation from ContextGym proposals.
- Eval JSON now embeds ROI and uses schema version 2.

## 0.9.0 - GitHub Release Candidate

- Prepared npm package allowlisting and prepack build.
- Added Windows/Linux CI across Node 20, 22, and 24.
- Added issue templates, PR template, CONTRIBUTING, and SECURITY guidance.
- Added benchmark policy, release checklist, and 30-second demo script.
- Reworked README for public launch while preserving conservative benchmark claims.
- No core evaluation semantics changed from 0.8.0.
