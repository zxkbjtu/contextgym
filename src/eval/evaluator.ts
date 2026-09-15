import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  EvalReport,
  EvalRunResult,
  EvalUsage,
  EvalVariant,
  EvalVariantSummary,
  EvalVerdict,
  ProposalReport,
} from "../types.js";
import { locateExecutable, runText } from "../core/command.js";
import { redactCommand } from "../mining/command.js";
import { computeContextRoi } from "../roi/analysis.js";

const ZERO_USAGE: EvalUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

export interface EvalOptions {
  project: string;
  proposal?: string;
  proposalReport?: string;
  task?: string;
  taskFile?: string;
  verify?: string;
  verifyFile?: string;
  runs: number;
  model?: string;
  sandbox: string;
  timeoutMinutes: number;
  outDir: string;
  keepWorktrees: boolean;
  dryRun: boolean;
}

interface ProcessCapture {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function locateCodexExecutable(): string | undefined {
  if (process.platform !== "win32") return locateExecutable("codex");
  const cmd = spawnSync("where.exe", ["codex.cmd"], { encoding: "utf8", windowsHide: true });
  const firstCmd = cmd.status === 0
    ? `${cmd.stdout ?? ""}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    : undefined;
  return firstCmd ? path.normalize(firstCmd) : locateExecutable("codex");
}

function normalizePathForCompare(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function execGit(project: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: project, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    const message = `${result.stderr ?? result.stdout ?? ""}`.trim();
    throw new Error(`git ${args.join(" ")} failed${message ? `: ${message}` : ""}`);
  }
  return `${result.stdout ?? ""}`.trim();
}

function resolveProposal(project: string, explicit: string | undefined, proposalReportFile: string): string {
  if (explicit) {
    const file = path.resolve(explicit);
    if (!fs.existsSync(file)) throw new Error(`Proposal draft not found: ${file}`);
    return file;
  }

  if (!fs.existsSync(proposalReportFile)) {
    throw new Error(`Proposal draft was not provided and proposal report was not found: ${proposalReportFile}. Run 'contextgym propose --project "${project}"' first or pass --proposal FILE.`);
  }

  let report: ProposalReport;
  try {
    report = JSON.parse(fs.readFileSync(proposalReportFile, "utf8")) as ProposalReport;
  } catch (error) {
    throw new Error(`Could not read proposal report: ${error instanceof Error ? error.message : String(error)}`);
  }
  const wanted = normalizePathForCompare(project);
  const match = report.projects.find((p) => normalizePathForCompare(p.project) === wanted);
  if (!match?.file || !fs.existsSync(match.file)) {
    throw new Error(`No generated proposal draft for project ${project}. Run 'contextgym propose --project "${project}"' first or pass --proposal FILE.`);
  }
  return path.resolve(match.file);
}

function resolveTask(task: string | undefined, taskFile: string | undefined): { text: string; source: string } {
  if (task && taskFile) throw new Error("Use either --task or --task-file, not both.");
  if (taskFile) {
    const file = path.resolve(taskFile);
    if (!fs.existsSync(file)) throw new Error(`Task file not found: ${file}`);
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
    if (!text) throw new Error(`Task file is empty: ${file}`);
    return { text, source: file };
  }
  if (task?.trim()) return { text: task.trim(), source: "inline" };
  throw new Error("A task is required. Use --task-file FILE (recommended) or --task TEXT.");
}

function resolveVerifier(verify: string | undefined, verifyFile: string | undefined): {
  command?: string;
  file?: string;
  source?: string;
  hash?: string;
} {
  if (verify && verifyFile) throw new Error("Use either --verify or --verify-file, not both.");
  if (verifyFile) {
    const file = path.resolve(verifyFile);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Verifier file not found: ${file}`);
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    if (!text.trim()) throw new Error(`Verifier file is empty: ${file}`);
    return { file, source: file, hash: hashText(text) };
  }
  if (verify?.trim()) return { command: verify, source: "inline", hash: hashText(verify) };
  return {};
}

function writeCandidateContext(worktree: string, proposal: string): void {
  const agents = path.join(worktree, "AGENTS.md");
  const existing = fs.existsSync(agents) ? fs.readFileSync(agents, "utf8").replace(/\s+$/, "") : "";
  const markerStart = "<!-- contextgym:candidate:start -->";
  const markerEnd = "<!-- contextgym:candidate:end -->";
  const cleanedProposal = proposal
    .replace(/<!--\s*ContextGym draft:[\s\S]*?-->/i, "")
    .trim();
  const addition = `${markerStart}\n# ContextGym candidate context\n\n${cleanedProposal}\n${markerEnd}`;
  const next = existing ? `${existing}\n\n${addition}\n` : `${addition}\n`;
  fs.writeFileSync(agents, next, "utf8");
}

function localEvalCommit(worktree: string, allowEmpty: boolean): void {
  const args = [
    "-c", "user.name=ContextGym",
    "-c", "user.email=contextgym@local",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=.contextgym-no-hooks",
    "commit",
    ...(allowEmpty ? ["--allow-empty"] : []),
    "--no-verify",
    "-m", "contextgym: eval context",
  ];
  const commit = spawnSync("git", args, { cwd: worktree, encoding: "utf8", windowsHide: true });
  if (commit.status !== 0) throw new Error(`Could not create local eval context commit: ${`${commit.stderr ?? commit.stdout ?? ""}`.trim()}`);
}

function commitCandidateContext(worktree: string): void {
  const add = spawnSync("git", ["add", "AGENTS.md"], { cwd: worktree, encoding: "utf8", windowsHide: true });
  if (add.status !== 0) throw new Error(`Could not stage candidate AGENTS.md: ${`${add.stderr ?? add.stdout ?? ""}`.trim()}`);
  localEvalCommit(worktree, false);
}

function addWorktree(project: string, target: string, head: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const result = spawnSync("git", ["worktree", "add", "--detach", target, head], {
    cwd: project,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Could not create isolated git worktree ${target}: ${`${result.stderr ?? result.stdout ?? ""}`.trim()}`);
  }
}

function removeWorktree(project: string, target: string): void {
  spawnSync("git", ["worktree", "remove", "--force", target], {
    cwd: project,
    encoding: "utf8",
    windowsHide: true,
  });
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
}

function runProcess(command: string, args: string[], cwd: string, input: string | undefined, timeoutMs: number): Promise<ProcessCapture> {
  return new Promise((resolve) => {
    const start = Date.now();
    const useCmdShim = process.platform === "win32" && [".cmd", ".bat"].includes(path.extname(command).toLowerCase());
    const executable = useCmdShim ? (process.env.ComSpec || "cmd.exe") : command;
    const executableArgs = useCmdShim ? ["/d", "/s", "/c", command, ...args] : args;
    const child = spawn(executable, executableArgs, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut, durationMs: Date.now() - start });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - start });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseCodexJsonl(stdout: string): {
  completed: boolean;
  failed: boolean;
  usage: EvalUsage;
  observedToolCalls: number;
  observedItemTypes: Record<string, number>;
} {
  let completed = false;
  let failed = false;
  let usage: EvalUsage = { ...ZERO_USAGE };
  let observedToolCalls = 0;
  const observedItemTypes: Record<string, number> = {};
  const toolish = new Set([
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
    "collab_tool_call",
    "dynamic_tool_call",
  ]);

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: any;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event?.type === "turn.completed") {
      completed = true;
      const u = event.usage ?? {};
      usage = {
        inputTokens: numberField(u.input_tokens),
        cachedInputTokens: numberField(u.cached_input_tokens),
        cacheWriteInputTokens: numberField(u.cache_write_input_tokens),
        outputTokens: numberField(u.output_tokens),
        reasoningOutputTokens: numberField(u.reasoning_output_tokens),
        totalTokens: numberField(u.total_tokens),
      };
      if (!usage.totalTokens) usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.reasoningOutputTokens;
    }
    // Only terminal turn.failed marks the Codex turn as failed.
    // Top-level error events may be recoverable and can be followed by turn.completed.
    if (event?.type === "turn.failed") failed = true;
    if ((event?.type === "item.completed" || event?.type === "item.started") && event.item?.type) {
      const itemType = String(event.item.type);
      observedItemTypes[itemType] = (observedItemTypes[itemType] ?? 0) + 1;
      if (event.type === "item.completed" && toolish.has(itemType)) observedToolCalls += 1;
    }
  }
  return { completed, failed, usage, observedToolCalls, observedItemTypes };
}

function changedFileList(worktree: string): string[] {
  const tracked = runText("git", ["diff", "--name-only"], worktree) ?? "";
  const untracked = runText("git", ["ls-files", "--others", "--exclude-standard"], worktree) ?? "";
  return [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

function tailText(value: string, max = 500): string | undefined {
  const compact = value.trim();
  if (!compact) return undefined;
  return compact.length <= max ? compact : compact.slice(-max);
}

async function runVerifier(options: { command?: string; file?: string }, cwd: string, timeoutMs: number): Promise<{
  code: number | null;
  passed: boolean;
  durationMs: number;
  stdoutTail?: string;
  stderrTail?: string;
}> {
  let shell: { command: string; args: string[] };
  if (options.file) {
    if (process.platform === "win32") {
      shell = { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", options.file] };
    } else {
      shell = { command: "/bin/sh", args: [options.file] };
    }
  } else if (options.command) {
    shell = process.platform === "win32"
      ? { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", options.command] }
      : { command: "/bin/sh", args: ["-lc", options.command] };
  } else {
    throw new Error("Verifier was not configured.");
  }
  const result = await runProcess(shell.command, shell.args, cwd, undefined, timeoutMs);
  return {
    code: result.code,
    passed: result.code === 0 && !result.timedOut,
    durationMs: result.durationMs,
    stdoutTail: tailText(result.stdout),
    stderrTail: tailText(result.stderr),
  };
}

async function runVariant(options: {
  run: number;
  variant: EvalVariant;
  order: number;
  project: string;
  worktree: string;
  head: string;
  proposal: string;
  task: string;
  verify?: string;
  verifyFile?: string;
  model?: string;
  sandbox: string;
  timeoutMs: number;
  codex: string;
}): Promise<EvalRunResult> {
  addWorktree(options.project, options.worktree, options.head);
  if (options.variant === "candidate") {
    writeCandidateContext(options.worktree, options.proposal);
    commitCandidateContext(options.worktree);
  } else {
    // Match candidate history depth while keeping the baseline tree unchanged.
    localEvalCommit(options.worktree, true);
  }

  try {
    const args = ["exec", "--json", "--ephemeral", "--sandbox", options.sandbox, "-C", options.worktree];
    if (options.model) args.push("--model", options.model);
    // stdin avoids Windows command-line length/quoting problems for real task prompts.
    args.push("-");
    const processResult = await runProcess(options.codex, args, options.worktree, options.task, options.timeoutMs);
    const parsed = parseCodexJsonl(processResult.stdout);
    let verifierExitCode: number | null | undefined;
    let verifierPassed: boolean | undefined;
    let verifierDurationMs: number | undefined;
    let verifierStdoutTail: string | undefined;
    let verifierStderrTail: string | undefined;
    const verifierConfigured = Boolean(options.verify || options.verifyFile);
    if (verifierConfigured) {
      const verification = await runVerifier({ command: options.verify, file: options.verifyFile }, options.worktree, options.timeoutMs);
      verifierExitCode = verification.code;
      verifierPassed = verification.passed;
      verifierDurationMs = verification.durationMs;
      verifierStdoutTail = verification.stdoutTail;
      verifierStderrTail = verification.stderrTail;
    }
    const successBasis = verifierConfigured ? "verifier" as const : "agent_completion" as const;
    const codexProcessOk = processResult.code === 0 && !processResult.timedOut;
    // When a deterministic verifier is configured, it is the task-level source of truth.
    // Codex may emit recoverable error events before turn.completed, so those must not
    // override a passing verifier. Without a verifier, require a clean completed turn.
    const success = verifierConfigured
      ? codexProcessOk && verifierPassed === true
      : codexProcessOk && parsed.completed && !parsed.failed;
    const filesChanged = changedFileList(options.worktree);
    return {
      run: options.run,
      variant: options.variant,
      order: options.order,
      cwd: options.worktree,
      codexExitCode: processResult.code,
      completed: parsed.completed,
      failed: parsed.failed || processResult.timedOut,
      durationMs: processResult.durationMs,
      usage: parsed.usage,
      observedToolCalls: parsed.observedToolCalls,
      observedItemTypes: parsed.observedItemTypes,
      changedFiles: filesChanged.length,
      changedFileList: filesChanged,
      verifierConfigured,
      verifierExitCode,
      verifierPassed,
      verifierDurationMs,
      verifierStdoutTail,
      verifierStderrTail,
      success,
      successBasis,
      stderrLines: processResult.stderr.split(/\r?\n/).filter(Boolean).length,
    };
  } finally {
    // cleanup happens in the caller after report capture unless --keep-worktrees was requested
  }
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function summarize(variant: EvalVariant, results: EvalRunResult[]): EvalVariantSummary {
  const rows = results.filter((r) => r.variant === variant);
  return {
    variant,
    runs: rows.length,
    successes: rows.filter((r) => r.success).length,
    successRate: rows.length ? rows.filter((r) => r.success).length / rows.length : 0,
    meanTotalTokens: mean(rows.map((r) => r.usage.totalTokens)),
    meanInputTokens: mean(rows.map((r) => r.usage.inputTokens)),
    meanOutputTokens: mean(rows.map((r) => r.usage.outputTokens)),
    meanObservedToolCalls: mean(rows.map((r) => r.observedToolCalls)),
    meanDurationMs: mean(rows.map((r) => r.durationMs)),
    meanChangedFiles: mean(rows.map((r) => r.changedFiles)),
  };
}

function pct(candidate: number, baseline: number): number | undefined {
  if (!baseline) return undefined;
  return ((candidate - baseline) / baseline) * 100;
}

function verdict(runs: number, baseline: EvalVariantSummary, candidate: EvalVariantSummary): { verdict: EvalVerdict; reason: string } {
  if (runs < 3) {
    return { verdict: "SMOKE_ONLY", reason: "Fewer than 3 paired runs: useful for harness validation, not enough evidence for KEEP/REJECT." };
  }
  const successDelta = candidate.successRate - baseline.successRate;
  if (successDelta >= 0.2) return { verdict: "KEEP_SUCCESS", reason: `Candidate success rate improved by ${(successDelta * 100).toFixed(1)} percentage points.` };
  if (successDelta <= -0.2) return { verdict: "REJECT_REGRESSION", reason: `Candidate success rate regressed by ${Math.abs(successDelta * 100).toFixed(1)} percentage points.` };
  if (candidate.successRate === baseline.successRate && baseline.successRate > 0) {
    const tokenDelta = pct(candidate.meanTotalTokens, baseline.meanTotalTokens);
    if (tokenDelta !== undefined && tokenDelta <= -10) return { verdict: "KEEP_EFFICIENCY", reason: `Success rate tied; candidate used ${Math.abs(tokenDelta).toFixed(1)}% fewer tokens on average.` };
    if (tokenDelta !== undefined && tokenDelta >= 10) return { verdict: "REJECT_EFFICIENCY", reason: `Success rate tied; candidate used ${tokenDelta.toFixed(1)}% more tokens on average.` };
  }
  return { verdict: "INCONCLUSIVE", reason: "No material paired success or token-efficiency difference under the current run count." };
}

export async function evaluateContext(options: EvalOptions): Promise<EvalReport> {
  const project = path.resolve(options.project);
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) {
    throw new Error(`Project directory does not exist: ${project}. Historical findings can remain valid, but A/B evaluation requires a live repository.`);
  }
  if (!locateExecutable("git")) throw new Error("Git was not found in PATH.");
  const codex = locateCodexExecutable();
  if (!codex) throw new Error("Codex CLI was not found in PATH.");

  const root = execGit(project, ["rev-parse", "--show-toplevel"]);
  if (normalizePathForCompare(root) !== normalizePathForCompare(project)) {
    throw new Error(`--project must point to the Git repository root. Detected root: ${root}`);
  }
  const head = execGit(project, ["rev-parse", "HEAD"]);
  const proposalReportFile = path.resolve(options.proposalReport ?? path.join(process.cwd(), ".contextgym", "proposals", "proposals.json"));
  const proposalFile = resolveProposal(project, options.proposal, proposalReportFile);
  const proposal = fs.readFileSync(proposalFile, "utf8").replace(/^\uFEFF/, "").trim();
  if (!proposal) throw new Error(`Proposal draft is empty: ${proposalFile}`);
  const task = resolveTask(options.task, options.taskFile);
  const verifier = resolveVerifier(options.verify, options.verifyFile);
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${hashText(`${project}|${head}|${proposal}|${task.text}`).slice(0, 8)}`;
  const outDir = path.resolve(options.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const outputFile = path.join(outDir, `${id}.json`);

  const baseReport: EvalReport = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    id,
    project,
    gitHead: head,
    proposalFile,
    proposalBytes: Buffer.byteLength(proposal, "utf8"),
    estimatedProposalTokens: Math.ceil(proposal.length / 4),
    taskSource: task.source,
    taskHash: hashText(task.text),
    taskLength: task.text.length,
    verifierConfigured: Boolean(verifier.command || verifier.file),
    verifier: verifier.command ? redactCommand(verifier.command) : undefined,
    verifierSource: verifier.source,
    verifierHash: verifier.hash,
    runsRequested: options.runs,
    model: options.model,
    sandbox: options.sandbox,
    observedToolCallsComplete: false,
    observedToolCallsNote: "Best-effort count from codex exec --json item events. Current Codex JSON streams can omit some unified/multi-agent tool calls, so do not treat this as a complete tool trace.",
    dryRun: options.dryRun,
    results: [],
    verdict: "SMOKE_ONLY",
    verdictReason: options.dryRun ? "Dry run only; Codex was not invoked." : "Evaluation has not run yet.",
    outputFile,
  };

  if (options.dryRun) {
    fs.writeFileSync(outputFile, JSON.stringify(baseReport, null, 2) + "\n", "utf8");
    return baseReport;
  }

  const tempRoot = path.join(os.tmpdir(), "contextgym", id);
  const timeoutMs = options.timeoutMinutes * 60_000;
  try {
    for (let run = 1; run <= options.runs; run += 1) {
      const order: EvalVariant[] = run % 2 === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      for (let i = 0; i < order.length; i += 1) {
        const variant = order[i]!;
        const worktree = path.join(tempRoot, `run-${run}-${variant}`);
        const result = await runVariant({
          run,
          variant,
          order: i + 1,
          project,
          worktree,
          head,
          proposal,
          task: task.text,
          verify: verifier.command,
          verifyFile: verifier.file,
          model: options.model,
          sandbox: options.sandbox,
          timeoutMs,
          codex,
        });
        baseReport.results.push(result);
      }
    }

    const baseline = summarize("baseline", baseReport.results);
    const candidate = summarize("candidate", baseReport.results);
    const decision = verdict(options.runs, baseline, candidate);
    baseReport.baseline = baseline;
    baseReport.candidate = candidate;
    baseReport.delta = {
      successRate: candidate.successRate - baseline.successRate,
      meanTotalTokensPct: pct(candidate.meanTotalTokens, baseline.meanTotalTokens),
      meanObservedToolCallsPct: pct(candidate.meanObservedToolCalls, baseline.meanObservedToolCalls),
      meanDurationPct: pct(candidate.meanDurationMs, baseline.meanDurationMs),
    };
    baseReport.verdict = decision.verdict;
    baseReport.verdictReason = decision.reason;
    baseReport.roi = computeContextRoi(baseReport);
    fs.writeFileSync(outputFile, JSON.stringify(baseReport, null, 2) + "\n", "utf8");
    return baseReport;
  } finally {
    if (!options.keepWorktrees) {
      for (let run = options.runs; run >= 1; run -= 1) {
        for (const variant of ["candidate", "baseline"] as const) {
          removeWorktree(project, path.join(tempRoot, `run-${run}-${variant}`));
        }
      }
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }
      spawnSync("git", ["worktree", "prune"], { cwd: project, encoding: "utf8", windowsHide: true });
    }
  }
}
