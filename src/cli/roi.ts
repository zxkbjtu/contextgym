import { bold, dim, green, pad, yellow } from "../core/format.js";
import { computeContextRoi, loadEvalReport } from "../roi/analysis.js";

export function roiCommand(options: { report: string; json?: boolean }): void {
  const report = loadEvalReport(options.report);
  const roi = computeContextRoi(report);
  if (!roi) throw new Error("Eval report does not contain baseline/candidate summaries yet.");
  if (options.json) {
    console.log(JSON.stringify({ report: options.report, verdict: report.verdict, roi }, null, 2));
    return;
  }
  console.log();
  console.log(bold("ContextGym Context ROI"));
  console.log(dim("────────────────────────────────────────────────────────"));
  console.log(`${pad("Project", 32)} ${report.project}`);
  console.log(`${pad("Verdict", 32)} ${report.verdict.startsWith("KEEP") ? green(report.verdict) : yellow(report.verdict)}`);
  console.log(`${pad("Successful paired runs", 32)} ${roi.eligiblePairs}/${report.runsRequested}`);
  console.log(`${pad("Proposal cost", 32)} ~${roi.proposalTokens} tokens`);
  console.log(`${pad("Mean token savings / task", 32)} ${roi.meanTokensSaved.toFixed(0)}`);
  console.log(`${pad("Gross token leverage", 32)} ${roi.tokenSavingsPerContextToken === undefined ? "n/a" : `${roi.tokenSavingsPerContextToken.toFixed(1)}x`}`);
  console.log(`${pad("Observed tool calls saved / task", 32)} ${roi.meanObservedToolCallsSaved.toFixed(2)}`);
  console.log(`${pad("Time saved / task", 32)} ${(roi.meanDurationMsSaved / 1000).toFixed(1)}s`);
  console.log(`${pad("Paired token wins", 32)} ${roi.pairedTokenWins}/${roi.eligiblePairs}`);
  console.log(`${pad("Paired observed-tool wins", 32)} ${roi.pairedObservedToolWins}/${roi.eligiblePairs}`);
  console.log(`${pad("Paired duration wins", 32)} ${roi.pairedDurationWins}/${roi.eligiblePairs}`);
  console.log();
  console.log(dim("Gross token leverage = mean total-token savings divided by proposal context tokens for this benchmark. It is a task-specific efficiency indicator, not a universal causal estimate."));
  console.log();
}
