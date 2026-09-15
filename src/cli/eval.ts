import path from "node:path";
import { bold, cyan, dim, green, pad, red, yellow } from "../core/format.js";
import { evaluateContext } from "../eval/evaluator.js";

function pct(value: number | undefined): string {
  if (value === undefined) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function rate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export async function evalCommand(options: {
  project: string;
  proposal?: string;
  proposalReport?: string;
  task?: string;
  taskFile?: string;
  verify?: string;
  verifyFile?: string;
  runs?: number;
  model?: string;
  sandbox?: string;
  timeoutMinutes?: number;
  outDir?: string;
  keepWorktrees?: boolean;
  dryRun?: boolean;
  json?: boolean;
}): Promise<void> {
  const report = await evaluateContext({
    project: options.project,
    proposal: options.proposal,
    proposalReport: options.proposalReport,
    task: options.task,
    taskFile: options.taskFile,
    verify: options.verify,
    verifyFile: options.verifyFile,
    runs: options.runs ?? 1,
    model: options.model,
    sandbox: options.sandbox ?? "workspace-write",
    timeoutMinutes: options.timeoutMinutes ?? 30,
    outDir: path.resolve(options.outDir ?? path.join(process.cwd(), ".contextgym", "evals")),
    keepWorktrees: Boolean(options.keepWorktrees),
    dryRun: Boolean(options.dryRun),
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log();
  console.log(bold("ContextGym Context A/B Evaluator"));
  console.log(dim("────────────────────────────────────────────────────────"));
  console.log(`${pad("Project", 28)} ${report.project}`);
  console.log(`${pad("Git HEAD", 28)} ${report.gitHead.slice(0, 12)}`);
  console.log(`${pad("Proposal", 28)} ${report.proposalFile}`);
  console.log(`${pad("Proposal context", 28)} ~${report.estimatedProposalTokens} tokens`);
  console.log(`${pad("Task", 28)} ${report.taskSource} · hash ${report.taskHash} · ${report.taskLength} chars`);
  console.log(`${pad("Verifier", 28)} ${report.verifierConfigured ? (report.verifierSource ?? report.verifier ?? "configured") : yellow("none (agent completion only)")}`);
  console.log(`${pad("Runs", 28)} ${report.runsRequested} paired run(s) = ${report.runsRequested * 2} Codex invocation(s)`);
  console.log(`${pad("Sandbox", 28)} ${report.sandbox}`);
  console.log(`${pad("Observed tool-call coverage", 28)} ${yellow("best effort")}`);
  console.log();

  if (report.dryRun) {
    console.log(green("✓ Dry-run validation passed. Codex was not invoked."));
    console.log(`${dim("Report:")} ${report.outputFile}`);
    console.log();
    return;
  }

  const baseline = report.baseline!;
  const candidate = report.candidate!;
  console.log(bold("Paired summary"));
  console.log(`${pad("", 26)} ${pad("Baseline", 14)} Candidate`);
  console.log(`${pad("Success", 26)} ${pad(`${baseline.successes}/${baseline.runs} (${rate(baseline.successRate)})`, 14)} ${candidate.successes}/${candidate.runs} (${rate(candidate.successRate)})`);
  console.log(`${pad("Mean total tokens", 26)} ${pad(baseline.meanTotalTokens.toFixed(0), 14)} ${candidate.meanTotalTokens.toFixed(0)}  ${dim(pct(report.delta?.meanTotalTokensPct))}`);
  console.log(`${pad("Mean observed tool calls", 26)} ${pad(baseline.meanObservedToolCalls.toFixed(1), 14)} ${candidate.meanObservedToolCalls.toFixed(1)}  ${dim(pct(report.delta?.meanObservedToolCallsPct))}`);
  console.log(`${pad("Mean duration", 26)} ${pad(`${(baseline.meanDurationMs / 1000).toFixed(1)}s`, 14)} ${(candidate.meanDurationMs / 1000).toFixed(1)}s  ${dim(pct(report.delta?.meanDurationPct))}`);
  console.log(`${pad("Mean changed files", 26)} ${pad(baseline.meanChangedFiles.toFixed(1), 14)} ${candidate.meanChangedFiles.toFixed(1)}`);
  console.log();

  if (report.roi) {
    console.log(bold("Context ROI"));
    console.log(`${pad("Mean token savings / task", 32)} ${report.roi.meanTokensSaved.toFixed(0)}`);
    console.log(`${pad("Gross token leverage", 32)} ${report.roi.tokenSavingsPerContextToken === undefined ? "n/a" : `${report.roi.tokenSavingsPerContextToken.toFixed(1)}x`}`);
    console.log(`${pad("Observed tools saved / task", 32)} ${report.roi.meanObservedToolCallsSaved.toFixed(2)}`);
    console.log(`${pad("Time saved / task", 32)} ${(report.roi.meanDurationMsSaved / 1000).toFixed(1)}s`);
    console.log(`${pad("Paired token wins", 32)} ${report.roi.pairedTokenWins}/${report.roi.eligiblePairs}`);
    console.log();
  }

  const failedRuns = report.results.filter((r) => !r.success);
  if (failedRuns.length) {
    console.log(bold("Run diagnostics"));
    for (const row of failedRuns) {
      const changed = row.changedFileList.length ? row.changedFileList.join(", ") : "none";
      console.log(`  run ${row.run} ${row.variant}: codex=${row.codexExitCode ?? "null"} completed=${row.completed} verifier=${row.verifierConfigured ? `${row.verifierExitCode ?? "null"}/${row.verifierPassed ? "pass" : "fail"}` : "n/a"} changed=${changed}`);
      if (row.verifierStderrTail) console.log(`    verifier stderr: ${dim(row.verifierStderrTail)}`);
      if (row.verifierStdoutTail) console.log(`    verifier stdout: ${dim(row.verifierStdoutTail)}`);
    }
    console.log();
  }

  const verdictColor = report.verdict.startsWith("KEEP") ? green : report.verdict.startsWith("REJECT") ? red : yellow;
  console.log(`${bold("Verdict")} ${verdictColor(report.verdict)}`);
  console.log(`  ${report.verdictReason}`);
  if (!report.verifierConfigured) {
    console.log(`  ${yellow("No deterministic verifier was supplied; success only means Codex completed the turn.")}`);
  }
  console.log(`  ${dim(report.observedToolCallsNote)}`);
  console.log();
  console.log(`${dim("Report:")} ${report.outputFile}`);
  console.log();
}
