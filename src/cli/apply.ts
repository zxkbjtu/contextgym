import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { bold, cyan, dim, green, pad, yellow } from "../core/format.js";
import type { OptimizeReport } from "./optimize.js";

const START = "<!-- contextgym:start -->";
const END = "<!-- contextgym:end -->";

function readOptimizeReport(file: string): OptimizeReport {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`Optimization report not found: ${resolved}`);
  let report: OptimizeReport;
  try { report = JSON.parse(fs.readFileSync(resolved, "utf8")) as OptimizeReport; }
  catch (error) { throw new Error(`Could not read optimization report: ${error instanceof Error ? error.message : String(error)}`); }
  if (!report || !report.project || !report.proposal?.file || !report.verdict) {
    throw new Error(`Not a ContextGym optimization report: ${resolved}`);
  }
  return report;
}

function stripDraftHeader(markdown: string): string {
  return markdown
    .replace(/^\uFEFF/, "")
    .replace(/^<!--\s*ContextGym draft:[\s\S]*?-->\s*/i, "")
    .trim();
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function managedBlock(body: string, reportFile: string): string {
  const source = path.basename(reportFile);
  const hash = hashText(body);
  return `${START}\n<!-- source: ${source} · proposal-sha256: ${hash} -->\n${body}\n${END}`;
}

function replaceOrAppend(existing: string, block: string): { next: string; mode: "create" | "append" | "replace" } {
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start >= 0 || end >= 0) {
    if (start < 0 || end < 0 || end < start) throw new Error("AGENTS.md contains an incomplete ContextGym managed block. Repair/remove it before applying.");
    const after = end + END.length;
    return { next: `${existing.slice(0, start)}${block}${existing.slice(after)}`.replace(/\s+$/, "") + "\n", mode: "replace" };
  }
  const normalized = existing.replace(/\s+$/, "");
  if (!normalized) return { next: `${block}\n`, mode: "create" };
  return { next: `${normalized}\n\n${block}\n`, mode: "append" };
}

function previewLines(before: string, after: string, maxLines = 80): string[] {
  if (before === after) return ["(no changes)"];
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const start = Math.max(0, beforeLines.findIndex((line, i) => line !== afterLines[i]) - 2);
  const lines = afterLines.slice(start, start + maxLines).map((line) => `+ ${line}`);
  if (afterLines.length > start + maxLines) lines.push("  ... preview truncated ...");
  return lines;
}

async function confirmApply(target: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`Apply validated ContextGym block to ${target}? [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function applyCommand(options: {
  report: string;
  target?: string;
  yes?: boolean;
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
}): Promise<void> {
  const reportFile = path.resolve(options.report);
  const report = readOptimizeReport(reportFile);
  if (report.verdict !== "KEEP" && !options.force) {
    throw new Error(`Optimization verdict is ${report.verdict}, not KEEP. Refusing to apply automatically. Use --force only after manual review.`);
  }

  const proposalFile = path.resolve(report.proposal.file!);
  if (!fs.existsSync(proposalFile)) throw new Error(`Proposal draft not found: ${proposalFile}`);
  const proposal = stripDraftHeader(fs.readFileSync(proposalFile, "utf8"));
  if (!proposal) throw new Error(`Proposal draft is empty: ${proposalFile}`);

  const project = path.resolve(report.project);
  if (!fs.existsSync(project)) throw new Error(`Optimized project no longer exists: ${project}`);
  const headCheck = spawnSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8", windowsHide: true });
  const currentHead = headCheck.status === 0 ? `${headCheck.stdout ?? ""}`.trim() : undefined;
  if (currentHead && report.gitHead && currentHead !== report.gitHead && !options.force) {
    throw new Error(`Project HEAD changed since optimization (${report.gitHead.slice(0, 12)} -> ${currentHead.slice(0, 12)}). Re-run optimize before apply, or use --force only after manual review.`);
  }
  const target = path.resolve(options.target ?? path.join(project, "AGENTS.md"));
  const relativeTarget = path.relative(project, target);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) throw new Error(`Apply target must be inside the optimized project: ${project}`);

  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8").replace(/^\uFEFF/, "") : "";
  const block = managedBlock(proposal, reportFile);
  const update = replaceOrAppend(existing, block);
  const changed = existing !== update.next;

  const result = {
    schemaVersion: 1,
    report: reportFile,
    project,
    verdict: report.verdict,
    optimizedGitHead: report.gitHead,
    currentGitHead: currentHead,
    proposal: proposalFile,
    target,
    mode: update.mode,
    changed,
    dryRun: Boolean(options.dryRun),
    applied: false,
  };

  if (!options.json) {
    console.log();
    console.log(bold("ContextGym Apply"));
    console.log(dim("────────────────────────────────────────────────────────"));
    console.log(`${pad("Project", 28)} ${project}`);
    console.log(`${pad("Optimization verdict", 28)} ${report.verdict}`);
    console.log(`${pad("Proposal", 28)} ${proposalFile}`);
    console.log(`${pad("Target", 28)} ${target}`);
    console.log(`${pad("Mode", 28)} ${update.mode}`);
    console.log(`${pad("Managed markers", 28)} ${START} … ${END}`);
    console.log();
    console.log(bold("Preview"));
    for (const line of previewLines(existing, update.next)) console.log(dim(line));
    console.log();
  }

  if (!changed) {
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(green("No change needed; the managed ContextGym block is already up to date."));
    return;
  }

  let proceed = Boolean(options.yes);
  if (options.dryRun) proceed = false;
  if (!options.dryRun && !options.yes) proceed = await confirmApply(target);
  if (!proceed) {
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(yellow(options.dryRun ? "Dry run only; no file was modified." : "Apply cancelled; no file was modified."));
      console.log(`Run again with ${cyan("--yes")} to apply non-interactively.`);
    }
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, update.next, "utf8");
  result.applied = true;
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(green(`Applied validated ContextGym context to ${target}`));
    console.log(dim("Re-running apply after a future optimization replaces only the managed block; surrounding human-authored content is preserved."));
  }
}
