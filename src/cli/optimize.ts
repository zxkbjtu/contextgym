import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { bold, cyan, dim, green, pad, red, yellow } from "../core/format.js";
import { parseCodexRollout, makeParseSummary } from "../sessions/codex-parser.js";
import { codexSessionRoot, listCodexRollouts } from "../sessions/scan.js";
import { readAgentEvents } from "../mining/events.js";
import { mineFriction } from "../mining/friction.js";
import { generateProposalReport } from "../proposals/generator.js";
import { generateProbes } from "../probes/generator.js";
import { evaluateContext } from "../eval/evaluator.js";
import { computeContextRoi } from "../roi/analysis.js";
import type {
  ContextRoi,
  EvalReport,
  MineReport,
  ProbeReport,
  ProposalReport,
  SessionParseSummary,
} from "../types.js";

export type OptimizeVerdict = "PLAN_ONLY" | "NO_PROPOSALS" | "KEEP" | "REJECT" | "MIXED" | "INCONCLUSIVE";

export interface OptimizeEvalSummary {
  probeId: string;
  target: string;
  role: string;
  reportFile: string;
  verdict: EvalReport["verdict"];
  successBaseline: number;
  successCandidate: number;
  runs: number;
  tokenDeltaPct?: number;
  observedToolDeltaPct?: number;
  durationDeltaPct?: number;
  roi?: ContextRoi;
}

export interface OptimizeReport {
  schemaVersion: 1;
  generatedAt: string;
  project: string;
  gitHead: string;
  workDir: string;
  historyRefreshed: boolean;
  parseSummary?: SessionParseSummary;
  mine: {
    findings: number;
    proposalCandidates: number;
    projectCandidates: number;
    environmentIssues: number;
    workflowIssues: number;
  };
  proposal: {
    file?: string;
    proposals: number;
    estimatedTokens: number;
    avoidableToolCalls: number;
    inspected: number;
    repositoryMap: number;
  };
  probes: {
    generated: number;
    selected: number;
    skippedUntracked: number;
    plannedCodexInvocations: number;
  };
  runs: number;
  evaluations: OptimizeEvalSummary[];
  verdict: OptimizeVerdict;
  outputFile: string;
  proposalReportFile: string;
  probeReportFile?: string;
}

function norm(value: string): string {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function git(project: string, args: string[], allowFailure = false): string | undefined {
  const result = spawnSync("git", args, { cwd: project, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    if (allowFailure) return undefined;
    const message = `${result.stderr ?? result.stdout ?? ""}`.trim();
    throw new Error(`git ${args.join(" ")} failed${message ? `: ${message}` : ""}`);
  }
  return `${result.stdout ?? ""}`.trim();
}

function trackedDirty(project: string): string[] {
  const text = git(project, ["status", "--porcelain", "--untracked-files=no"]) ?? "";
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function isTracked(project: string, relativePath: string): boolean {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
    cwd: project,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0;
}

async function refreshEvents(outputFile: string): Promise<SessionParseSummary> {
  const root = codexSessionRoot();
  const files = listCodexRollouts(root);
  if (!files.length) throw new Error(`No Codex rollout sessions found under ${root}`);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const tempFile = `${outputFile}.tmp`;
  const stream = fs.createWriteStream(tempFile, { encoding: "utf8" });
  const eventTypes: Record<string, number> = {};
  const sessionIds = new Set<string>();
  let linesRead = 0;
  let parseErrors = 0;
  let eventsWritten = 0;
  try {
    for (const file of files) {
      const parsed = await parseCodexRollout(file.path, { includeText: false });
      linesRead += parsed.summary.lines;
      parseErrors += parsed.summary.parseErrors;
      for (const event of parsed.events) {
        stream.write(`${JSON.stringify(event)}\n`);
        eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
        sessionIds.add(event.sessionId);
        eventsWritten += 1;
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      stream.end(resolve);
      stream.on("error", reject);
    });
  }
  fs.renameSync(tempFile, outputFile);
  const summary = makeParseSummary(root, files.length, linesRead, parseErrors, eventsWritten, eventTypes, sessionIds.size, outputFile, false);
  fs.writeFileSync(path.join(path.dirname(outputFile), "parse-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  return summary;
}

async function mine(eventsFile: string, reportFile: string, minCount: number): Promise<MineReport> {
  const read = await readAgentEvents(eventsFile);
  const report = mineFriction(read.events, eventsFile, minCount);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  return report;
}

function proposalForProject(report: ProposalReport, project: string) {
  return report.projects.find((p) => norm(p.project) === norm(project));
}

function overallVerdict(rows: OptimizeEvalSummary[]): OptimizeVerdict {
  if (!rows.length) return "INCONCLUSIVE";
  const keep = rows.filter((r) => r.verdict.startsWith("KEEP")).length;
  const reject = rows.filter((r) => r.verdict.startsWith("REJECT")).length;
  if (keep === rows.length) return "KEEP";
  if (reject === rows.length) return "REJECT";
  if (keep > 0 && reject > 0) return "MIXED";
  if (reject > 0) return "MIXED";
  if (keep > 0) return "MIXED";
  return "INCONCLUSIVE";
}

function fmtPct(value: number | undefined): string {
  if (value === undefined) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

async function confirmRun(invocations: number): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`Run ${invocations} Codex invocation(s) now? [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function optimizeCommand(options: {
  project?: string;
  runs?: number;
  top?: number;
  minCount?: number;
  minScore?: number;
  model?: string;
  sandbox?: string;
  timeoutMinutes?: number;
  refresh?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
}): Promise<void> {
  const workDir = process.cwd();
  const project = path.resolve(options.project ?? workDir);
  const runs = options.runs ?? 3;
  const top = options.top ?? 1;
  const minCount = options.minCount ?? 2;
  const minScore = options.minScore ?? 65;
  const root = git(project, ["rev-parse", "--show-toplevel"], true);
  if (!root) throw new Error(`Project is not a Git repository: ${project}. optimize currently requires Git for isolated A/B evaluation.`);
  if (norm(root) !== norm(project)) throw new Error(`--project must point to the Git repository root. Detected root: ${root}`);
  const head = git(project, ["rev-parse", "HEAD"])!;
  const dirty = trackedDirty(project);
  if (dirty.length) throw new Error(`Tracked working-tree changes detected in ${project}. Commit/stash them before optimize so proposals and A/B worktrees use the same source state.`);

  const cgDir = path.join(workDir, ".contextgym");
  const eventsFile = path.join(cgDir, "events.jsonl");
  const frictionFile = path.join(cgDir, "friction-report.json");
  const proposalDir = path.join(cgDir, "proposals");
  const proposalReportFile = path.join(proposalDir, "proposals.json");
  const probeDir = path.join(cgDir, "probes");
  const evalDir = path.join(cgDir, "evals");
  const optimizeDir = path.join(cgDir, "optimizations");
  fs.mkdirSync(cgDir, { recursive: true });
  fs.mkdirSync(proposalDir, { recursive: true });
  fs.mkdirSync(probeDir, { recursive: true });
  fs.mkdirSync(evalDir, { recursive: true });
  fs.mkdirSync(optimizeDir, { recursive: true });

  if (!options.json) {
    console.log();
    console.log(bold("ContextGym Optimize"));
    console.log(dim("────────────────────────────────────────────────────────"));
    console.log(`${pad("Project", 28)} ${project}`);
    console.log(`${pad("Git HEAD", 28)} ${head.slice(0, 12)}`);
    console.log(`${pad("Paired runs / probe", 28)} ${runs}`);
    console.log(`${pad("Max probes", 28)} ${top}`);
    console.log();
  }

  let parseSummary: SessionParseSummary | undefined;
  const shouldRefresh = options.refresh !== false || !fs.existsSync(eventsFile);
  if (shouldRefresh) {
    if (!options.json) console.log(`${cyan("1/5")} Refreshing privacy-safe Codex history...`);
    parseSummary = await refreshEvents(eventsFile);
  } else if (!fs.existsSync(eventsFile)) {
    throw new Error(`Agent events not found: ${eventsFile}`);
  }

  if (!options.json) console.log(`${cyan("2/5")} Mining recurring friction...`);
  const mineReport = await mine(eventsFile, frictionFile, minCount);
  const projectCandidates = mineReport.findings.filter((f) => f.action === "propose" && norm(f.project) === norm(project)).length;

  if (!options.json) console.log(`${cyan("3/5")} Building context proposal...`);
  const proposalReport = generateProposalReport(mineReport, frictionFile, proposalDir, { minScore, top: 50, project });
  for (const draft of proposalReport.projects) fs.writeFileSync(draft.file, draft.markdown, "utf8");
  fs.writeFileSync(proposalReportFile, JSON.stringify(proposalReport, null, 2) + "\n", "utf8");
  const projectDraft = proposalForProject(proposalReport, project);
  const projectProposals = proposalReport.proposals.filter((p) => norm(p.project) === norm(project));
  const repoMap = projectProposals.filter((p) => p.kind === "repository_map");
  const inspected = repoMap.filter((p) => p.inspected).length;

  const reportBase: Omit<OptimizeReport, "verdict" | "outputFile" | "evaluations" | "probes"> = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project,
    gitHead: head,
    workDir,
    historyRefreshed: shouldRefresh,
    parseSummary,
    mine: {
      findings: mineReport.findings.length,
      proposalCandidates: mineReport.proposalCandidates,
      projectCandidates,
      environmentIssues: mineReport.environmentFindings,
      workflowIssues: mineReport.workflowFindings,
    },
    proposal: {
      file: projectDraft?.file,
      proposals: projectDraft?.proposals ?? 0,
      estimatedTokens: projectDraft?.estimatedTokens ?? 0,
      avoidableToolCalls: projectDraft?.avoidableToolCalls ?? 0,
      inspected,
      repositoryMap: repoMap.length,
    },
    runs,
    proposalReportFile,
    probeReportFile: undefined,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputFile = path.join(optimizeDir, `${stamp}-${path.basename(project).replace(/[^A-Za-z0-9._-]+/g, "-")}.json`);

  if (!projectDraft || projectProposals.length === 0) {
    const report: OptimizeReport = {
      ...reportBase,
      probes: { generated: 0, selected: 0, skippedUntracked: 0, plannedCodexInvocations: 0 },
      evaluations: [],
      verdict: "NO_PROPOSALS",
      outputFile,
    };
    fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n", "utf8");
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log();
      console.log(yellow("No high-confidence repository context proposal is available for this project yet."));
      console.log(`${dim("Report:")} ${outputFile}`);
      console.log();
    }
    return;
  }

  if (!options.json) console.log(`${cyan("4/5")} Generating deterministic context probes...`);
  let probeReport: ProbeReport | undefined;
  try {
    probeReport = generateProbes({ project, proposalReportFile, outDir: probeDir, top: Math.max(top * 3, top) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("No repository-map proposals")) throw error;
  }

  const allProbes = probeReport?.probes ?? [];
  const tracked = allProbes.filter((p) => isTracked(project, p.targetRelativePath));
  const selected = tracked.slice(0, top);
  const skippedUntracked = allProbes.length - tracked.length;
  const plannedCodexInvocations = selected.length * runs * 2;
  const reportPlan: OptimizeReport = {
    ...reportBase,
    probeReportFile: probeReport?.outputFile,
    probes: {
      generated: allProbes.length,
      selected: selected.length,
      skippedUntracked,
      plannedCodexInvocations,
    },
    evaluations: [],
    verdict: "PLAN_ONLY",
    outputFile,
  };

  if (!options.json) {
    console.log();
    console.log(bold("Optimization plan"));
    console.log(`${pad("Historical findings", 31)} ${mineReport.findings.length}`);
    console.log(`${pad("Project proposal candidates", 31)} ${projectCandidates}`);
    console.log(`${pad("Context proposals", 31)} ${projectDraft.proposals}`);
    console.log(`${pad("Proposal context", 31)} ~${projectDraft.estimatedTokens} tokens`);
    console.log(`${pad("Source files inspected", 31)} ${inspected}/${repoMap.length}`);
    console.log(`${pad("Historical avoidable calls", 31)} ${projectDraft.avoidableToolCalls}`);
    console.log(`${pad("Deterministic probes", 31)} ${selected.length}`);
    console.log(`${pad("Planned Codex invocations", 31)} ${plannedCodexInvocations}`);
    if (skippedUntracked) console.log(`${pad("Untracked probe targets skipped", 31)} ${skippedUntracked}`);
    console.log();
    for (const p of selected) {
      console.log(`  ${cyan("+")} ${p.targetRelativePath}`);
      console.log(`    ${dim(p.role)}`);
    }
    console.log();
  }

  if (!selected.length) {
    reportPlan.verdict = "NO_PROPOSALS";
    fs.writeFileSync(outputFile, JSON.stringify(reportPlan, null, 2) + "\n", "utf8");
    if (options.json) console.log(JSON.stringify(reportPlan, null, 2));
    else {
      console.log(yellow("No tracked repository-map proposal can be evaluated automatically. The proposal draft is still available for review."));
      console.log(`${dim("Draft:")} ${projectDraft.file}`);
      console.log(`${dim("Report:")} ${outputFile}`);
      console.log();
    }
    return;
  }

  let proceed = Boolean(options.yes);
  if (options.dryRun) proceed = false;
  if (!options.dryRun && !options.yes) proceed = await confirmRun(plannedCodexInvocations);
  if (!proceed) {
    fs.writeFileSync(outputFile, JSON.stringify(reportPlan, null, 2) + "\n", "utf8");
    if (options.json) console.log(JSON.stringify(reportPlan, null, 2));
    else {
      console.log(yellow(options.dryRun ? "Plan only: Codex was not invoked." : "Evaluation not started."));
      console.log(`Run again with ${cyan("--yes")} to execute this plan without an interactive prompt.`);
      console.log(`${dim("Report:")} ${outputFile}`);
      console.log();
    }
    return;
  }

  if (!options.json) console.log(`${cyan("5/5")} Running paired A/B evaluations...`);
  const evaluations: OptimizeEvalSummary[] = [];
  for (let i = 0; i < selected.length; i += 1) {
    const probe = selected[i]!;
    if (!options.json) console.log(`  [${i + 1}/${selected.length}] ${probe.targetRelativePath} (${runs} paired runs)`);
    const evalReport = await evaluateContext({
      project,
      proposal: probe.proposalFile,
      taskFile: probe.taskFile,
      verifyFile: probe.verifierFile,
      runs,
      model: options.model,
      sandbox: options.sandbox ?? "workspace-write",
      timeoutMinutes: options.timeoutMinutes ?? 30,
      outDir: evalDir,
      keepWorktrees: false,
      dryRun: false,
    });
    const roi = evalReport.roi ?? computeContextRoi(evalReport);
    evaluations.push({
      probeId: probe.id,
      target: probe.targetRelativePath,
      role: probe.role,
      reportFile: evalReport.outputFile,
      verdict: evalReport.verdict,
      successBaseline: evalReport.baseline?.successRate ?? 0,
      successCandidate: evalReport.candidate?.successRate ?? 0,
      runs,
      tokenDeltaPct: evalReport.delta?.meanTotalTokensPct,
      observedToolDeltaPct: evalReport.delta?.meanObservedToolCallsPct,
      durationDeltaPct: evalReport.delta?.meanDurationPct,
      roi,
    });
  }

  const report: OptimizeReport = {
    ...reportPlan,
    evaluations,
    verdict: overallVerdict(evaluations),
  };
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n", "utf8");

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log();
  console.log(bold("Optimization results"));
  for (const row of evaluations) {
    const verdictColor = row.verdict.startsWith("KEEP") ? green : row.verdict.startsWith("REJECT") ? red : yellow;
    console.log(`  ${verdictColor(row.verdict)}  ${row.target}`);
    console.log(`    success ${Math.round(row.successBaseline * 100)}% -> ${Math.round(row.successCandidate * 100)}% · tokens ${fmtPct(row.tokenDeltaPct)} · tools ${fmtPct(row.observedToolDeltaPct)} · time ${fmtPct(row.durationDeltaPct)}`);
    if (row.roi?.tokenSavingsPerContextToken !== undefined) {
      console.log(`    leverage ${row.roi.tokenSavingsPerContextToken.toFixed(1)}x · paired token wins ${row.roi.pairedTokenWins}/${row.roi.eligiblePairs}`);
    }
  }
  console.log();
  const overallColor = report.verdict === "KEEP" ? green : report.verdict === "REJECT" ? red : yellow;
  console.log(`${bold("Overall")} ${overallColor(report.verdict)}`);
  if (report.verdict === "KEEP") console.log(`  ${green("Context bundle passed every evaluated probe. Proposal is ready for review/apply.")}`);
  else if (report.verdict === "REJECT") console.log(`  ${red("Context bundle regressed every evaluated probe. Do not apply automatically.")}`);
  else console.log(`  ${yellow("Evidence is mixed or inconclusive. Keep the draft review-only.")}`);
  console.log(`${dim("Draft:")} ${projectDraft.file}`);
  console.log(`${dim("Report:")} ${outputFile}`);
  console.log();
}
