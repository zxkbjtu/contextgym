#!/usr/bin/env node
import { doctorCommand } from "./cli/doctor.js";
import { evalCommand } from "./cli/eval.js";
import { mineCommand } from "./cli/mine.js";
import { proposeCommand } from "./cli/propose.js";
import { sessionsInspectCommand, sessionsParseCommand } from "./cli/sessions.js";
import { probeCommand } from "./cli/probe.js";
import { roiCommand } from "./cli/roi.js";
import { optimizeCommand } from "./cli/optimize.js";
import { applyCommand } from "./cli/apply.js";
import { reportCommand } from "./cli/report.js";

const VERSION = "0.9.0";

function printHelp(): void {
  console.log(`ContextGym v${VERSION}

Train coding agents to work better on your repository.

Usage:
  contextgym doctor [--json]
  contextgym sessions inspect [--limit N] [--json]
  contextgym sessions parse [--limit N] [--out FILE] [--include-text] [--json]
  contextgym mine [--input FILE] [--out FILE] [--min-count N] [--top N] [--proposals-only] [--json]
  contextgym propose [--input FILE] [--out-dir DIR] [--min-score N] [--top N] [--project PATH] [--json]
  contextgym eval --project PATH (--task-file FILE | --task TEXT) [--proposal FILE] [--verify COMMAND | --verify-file FILE] [--runs N] [--dry-run] [--json]
  contextgym probe --project PATH [--proposal-report FILE] [--out-dir DIR] [--top N] [--json]
  contextgym roi --report FILE [--json]
  contextgym optimize [--project PATH] [--top N] [--runs N] [--yes] [--dry-run] [--json]
  contextgym apply --report FILE [--target FILE] [--yes] [--dry-run] [--force] [--json]
  contextgym report --report FILE [--out FILE] [--open] [--json]
  contextgym --help
  contextgym --version

Commands:
  doctor             Detect Git, coding-agent CLIs, instruction files, and local sessions.
  sessions inspect   Fingerprint Codex rollout schemas without printing conversation text.
  sessions parse     Normalize Codex rollout JSONL into vendor-neutral AgentEvent JSONL.
  mine               Find repeated failures, recoveries, loops, repeated reads, and aborted turns.
  propose            Generate review-only repository context drafts from high-confidence findings.
  eval               Run isolated baseline-vs-candidate Codex experiments in Git worktrees.
  probe              Auto-generate deterministic repository-navigation A/B probes from proposals.
  roi                Compute Context ROI from an existing eval report without rerunning Codex.
  optimize           Parse, mine, propose, probe, A/B test, and score context in one workflow.
  apply              Apply a validated KEEP proposal as an idempotent managed block in AGENTS.md.
  report             Generate a standalone local HTML optimization report.

Options:
  --limit N          Only inspect/parse the N most recently modified rollouts.
  --out FILE         Output file for parse/mine command.
  --input FILE       AgentEvent JSONL input for mine (default: .contextgym/events.jsonl).
  --min-count N      Minimum repeated evidence for a finding (default: 2).
  --top N            Number of findings printed to terminal (default: 15).
  --proposals-only   Print only findings safe enough to feed into proposal generation.
  --min-score N      Minimum proposal score for propose (default: 65).
  --out-dir DIR      Proposal output directory (default: .contextgym/proposals).
  --project PATH     Restrict proposal generation to one project.
  --include-text     Include full message/tool I/O text. Off by default for privacy.
  --task-file FILE   Task prompt file for eval (recommended).
  --task TEXT        Inline task prompt for eval.
  --proposal FILE    Context proposal draft for eval; auto-resolved when omitted.
  --verify COMMAND   Inline deterministic verifier command (shell quoting can be fragile on Windows).
  --verify-file FILE Deterministic .ps1/.sh verifier file (recommended, especially on Windows).
  --runs N           Paired A/B repetitions for eval (default: 1).
  --model ID         Optional Codex model override.
  --sandbox MODE     Codex sandbox for eval (default: workspace-write).
  --timeout-minutes N Per-invocation timeout (default: 30).
  --keep-worktrees   Keep temporary eval worktrees for inspection.
  --dry-run          Validate/plan without invoking Codex.
  --refresh          Re-parse Codex history before optimize (default behavior).
  --reuse-events     Reuse existing .contextgym/events.jsonl during optimize.
  --yes              Run planned Codex A/B probes or apply context without an interactive confirmation.
  --target FILE      Apply target inside the optimized project (default: AGENTS.md).
  --force            Allow apply when the optimization verdict is not KEEP (manual-review escape hatch).
  --open             Open the generated HTML report in the default browser.
  --json             Print machine-readable command summary.
  -h, --help         Show this help.
  -v, --version      Show version.
`);
}

function optionValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function parsePositiveInt(args: string[], name: string): number | undefined {
  const raw = optionValue(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function assertKnownOptions(args: string[], optionsWithValue: string[], flags: string[]): void {
  const known = new Set([...optionsWithValue, ...flags]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      const prev = args[i - 1];
      if (prev && optionsWithValue.includes(prev)) continue;
      throw new Error(`Unexpected argument: ${arg}`);
    }
    if (!known.has(arg)) throw new Error(`Unknown option: ${arg}`);
    if (optionsWithValue.includes(arg)) {
      if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) throw new Error(`${arg} requires a value`);
      i += 1;
    }
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (!command || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "-v" || command === "--version") {
    console.log(VERSION);
    return;
  }

  if (command === "doctor") {
    assertKnownOptions(rest, [], ["--json"]);
    doctorCommand({ json: rest.includes("--json") });
    return;
  }

  if (command === "sessions") {
    const [subcommand, ...args] = rest;
    if (!subcommand || subcommand === "-h" || subcommand === "--help") {
      console.log(`Usage:
  contextgym sessions inspect [--limit N] [--json]
  contextgym sessions parse [--limit N] [--out FILE] [--include-text] [--json]
`);
      return;
    }

    if (subcommand === "inspect") {
      assertKnownOptions(args, ["--limit"], ["--json"]);
      await sessionsInspectCommand({ limit: parsePositiveInt(args, "--limit"), json: args.includes("--json") });
      return;
    }

    if (subcommand === "parse") {
      assertKnownOptions(args, ["--limit", "--out"], ["--include-text", "--json"]);
      await sessionsParseCommand({
        limit: parsePositiveInt(args, "--limit"),
        out: optionValue(args, "--out"),
        includeText: args.includes("--include-text"),
        json: args.includes("--json"),
      });
      return;
    }

    throw new Error(`Unknown sessions subcommand: ${subcommand}`);
  }

  if (command === "mine") {
    assertKnownOptions(rest, ["--input", "--out", "--min-count", "--top"], ["--proposals-only", "--json"]);
    await mineCommand({
      input: optionValue(rest, "--input"),
      out: optionValue(rest, "--out"),
      minCount: parsePositiveInt(rest, "--min-count"),
      top: parsePositiveInt(rest, "--top"),
      json: rest.includes("--json"),
      proposalsOnly: rest.includes("--proposals-only"),
    });
    return;
  }

  if (command === "propose") {
    assertKnownOptions(rest, ["--input", "--out-dir", "--min-score", "--top", "--project"], ["--json"]);
    await proposeCommand({
      input: optionValue(rest, "--input"),
      outDir: optionValue(rest, "--out-dir"),
      minScore: parsePositiveInt(rest, "--min-score"),
      top: parsePositiveInt(rest, "--top"),
      project: optionValue(rest, "--project"),
      json: rest.includes("--json"),
    });
    return;
  }

  if (command === "eval") {
    assertKnownOptions(
      rest,
      ["--project", "--proposal", "--proposal-report", "--task", "--task-file", "--verify", "--verify-file", "--runs", "--model", "--sandbox", "--timeout-minutes", "--out-dir"],
      ["--keep-worktrees", "--dry-run", "--json"],
    );
    const project = optionValue(rest, "--project");
    if (!project) throw new Error("eval requires --project PATH");
    await evalCommand({
      project,
      proposal: optionValue(rest, "--proposal"),
      proposalReport: optionValue(rest, "--proposal-report"),
      task: optionValue(rest, "--task"),
      taskFile: optionValue(rest, "--task-file"),
      verify: optionValue(rest, "--verify"),
      verifyFile: optionValue(rest, "--verify-file"),
      runs: parsePositiveInt(rest, "--runs"),
      model: optionValue(rest, "--model"),
      sandbox: optionValue(rest, "--sandbox"),
      timeoutMinutes: parsePositiveInt(rest, "--timeout-minutes"),
      outDir: optionValue(rest, "--out-dir"),
      keepWorktrees: rest.includes("--keep-worktrees"),
      dryRun: rest.includes("--dry-run"),
      json: rest.includes("--json"),
    });
    return;
  }

  if (command === "probe") {
    assertKnownOptions(rest, ["--project", "--proposal-report", "--out-dir", "--top"], ["--json"]);
    const project = optionValue(rest, "--project");
    if (!project) throw new Error("probe requires --project PATH");
    probeCommand({ project, proposalReport: optionValue(rest, "--proposal-report"), outDir: optionValue(rest, "--out-dir"), top: parsePositiveInt(rest, "--top"), json: rest.includes("--json") });
    return;
  }

  if (command === "apply") {
    assertKnownOptions(rest, ["--report", "--target"], ["--yes", "--dry-run", "--force", "--json"]);
    const report = optionValue(rest, "--report");
    if (!report) throw new Error("apply requires --report FILE");
    await applyCommand({
      report,
      target: optionValue(rest, "--target"),
      yes: rest.includes("--yes"),
      dryRun: rest.includes("--dry-run"),
      force: rest.includes("--force"),
      json: rest.includes("--json"),
    });
    return;
  }

  if (command === "report") {
    assertKnownOptions(rest, ["--report", "--out"], ["--open", "--json"]);
    const report = optionValue(rest, "--report");
    if (!report) throw new Error("report requires --report FILE");
    reportCommand({ report, out: optionValue(rest, "--out"), open: rest.includes("--open"), json: rest.includes("--json") });
    return;
  }

  if (command === "optimize") {
    assertKnownOptions(
      rest,
      ["--project", "--runs", "--top", "--min-count", "--min-score", "--model", "--sandbox", "--timeout-minutes"],
      ["--refresh", "--reuse-events", "--yes", "--dry-run", "--json"],
    );
    await optimizeCommand({
      project: optionValue(rest, "--project"),
      runs: parsePositiveInt(rest, "--runs"),
      top: parsePositiveInt(rest, "--top"),
      minCount: parsePositiveInt(rest, "--min-count"),
      minScore: parsePositiveInt(rest, "--min-score"),
      model: optionValue(rest, "--model"),
      sandbox: optionValue(rest, "--sandbox"),
      timeoutMinutes: parsePositiveInt(rest, "--timeout-minutes"),
      refresh: !rest.includes("--reuse-events"),
      yes: rest.includes("--yes"),
      dryRun: rest.includes("--dry-run"),
      json: rest.includes("--json"),
    });
    return;
  }

  if (command === "roi") {
    assertKnownOptions(rest, ["--report"], ["--json"]);
    const report = optionValue(rest, "--report");
    if (!report) throw new Error("roi requires --report FILE");
    roiCommand({ report, json: rest.includes("--json") });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`ContextGym error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
