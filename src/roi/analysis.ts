import fs from "node:fs";
import path from "node:path";
import type { ContextRoi, EvalReport, EvalRunResult } from "../types.js";

function paired(report: EvalReport): Array<{ baseline: EvalRunResult; candidate: EvalRunResult }> {
  const byRun = new Map<number, Partial<Record<"baseline" | "candidate", EvalRunResult>>>();
  for (const row of report.results ?? []) {
    const bucket = byRun.get(row.run) ?? {};
    bucket[row.variant] = row;
    byRun.set(row.run, bucket);
  }
  return [...byRun.values()]
    .filter((v): v is { baseline: EvalRunResult; candidate: EvalRunResult } => Boolean(v.baseline && v.candidate))
    .map((v) => ({ baseline: v.baseline, candidate: v.candidate }));
}

export function computeContextRoi(report: EvalReport): ContextRoi | undefined {
  if (!report.baseline || !report.candidate) return undefined;
  const pairs = paired(report).filter((p) => p.baseline.success && p.candidate.success);
  const proposalTokens = Math.max(0, report.estimatedProposalTokens || 0);
  const meanTokensSaved = report.baseline.meanTotalTokens - report.candidate.meanTotalTokens;
  const meanObservedToolCallsSaved = report.baseline.meanObservedToolCalls - report.candidate.meanObservedToolCalls;
  const meanDurationMsSaved = report.baseline.meanDurationMs - report.candidate.meanDurationMs;
  return {
    eligiblePairs: pairs.length,
    proposalTokens,
    meanTokensSaved,
    meanObservedToolCallsSaved,
    meanDurationMsSaved,
    tokenSavingsPerContextToken: proposalTokens > 0 ? meanTokensSaved / proposalTokens : undefined,
    observedToolCallsSavedPer100ContextTokens: proposalTokens > 0 ? (meanObservedToolCallsSaved / proposalTokens) * 100 : undefined,
    pairedTokenWins: pairs.filter((p) => p.candidate.usage.totalTokens < p.baseline.usage.totalTokens).length,
    pairedObservedToolWins: pairs.filter((p) => p.candidate.observedToolCalls < p.baseline.observedToolCalls).length,
    pairedDurationWins: pairs.filter((p) => p.candidate.durationMs < p.baseline.durationMs).length,
    successNonRegression: report.candidate.successRate >= report.baseline.successRate,
  };
}

export function loadEvalReport(file: string): EvalReport {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`Eval report not found: ${resolved}`);
  let report: EvalReport;
  try { report = JSON.parse(fs.readFileSync(resolved, "utf8")) as EvalReport; }
  catch (error) { throw new Error(`Could not read eval report: ${error instanceof Error ? error.message : String(error)}`); }
  if (!report || !Array.isArray(report.results)) throw new Error(`Not a ContextGym eval report: ${resolved}`);
  return report;
}
