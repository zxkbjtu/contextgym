import os from "node:os";
import path from "node:path";
import { detectClaudeHistory } from "../adapters/claude.js";
import { detectCodexHistories } from "../adapters/codex.js";
import { detectRepo } from "../adapters/git.js";
import { detectCli } from "../core/command.js";
import { bold, cyan, dim, pad, status, yellow } from "../core/format.js";
import type { DoctorReport } from "../types.js";

function compactPath(value: string): string {
  const home = os.homedir();
  if (value === home) return "~";
  if (value.startsWith(home + path.sep)) return `~${value.slice(home.length)}`;
  return value;
}

export function collectDoctorReport(cwd = process.cwd()): DoctorReport {
  const repo = detectRepo(cwd);
  const tools = [
    detectCli("Git", "git"),
    detectCli("Claude Code", "claude"),
    detectCli("Codex", "codex"),
  ];

  const histories = [detectClaudeHistory(), ...detectCodexHistories()];

  return {
    platform: process.platform,
    nodeVersion: process.version,
    cwd: path.resolve(cwd),
    repo,
    tools,
    histories,
  };
}

export function doctorCommand(options: { json?: boolean }): void {
  const report = collectDoctorReport();

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log();
  console.log(bold("ContextGym Doctor"));
  console.log(dim("────────────────────────────────────────────────────────"));
  console.log(`${pad("Platform", 20)} ${report.platform}`);
  console.log(`${pad("Node", 20)} ${report.nodeVersion}`);
  console.log(`${pad("Working directory", 20)} ${compactPath(report.cwd)}`);
  console.log();

  console.log(bold("Repository"));
  console.log(`${status(report.repo.isGitRepo)} ${pad("Git repository", 24)} ${report.repo.isGitRepo ? compactPath(report.repo.root!) : "not detected"}`);

  if (report.repo.isGitRepo) {
    console.log(`  ${pad("Branch", 24)} ${report.repo.branch || yellow("detached / unknown")}`);
    console.log(`  ${pad("Origin", 24)} ${report.repo.remote || dim("none")}`);
  }

  const instructions = report.repo.instructionFiles;
  console.log(
    `${status(instructions.length > 0)} ${pad("Agent instructions", 24)} ${
      instructions.length > 0
        ? instructions.map(compactPath).join(", ")
        : dim("none found at repository root")
    }`,
  );
  console.log();

  console.log(bold("Agent CLIs"));
  for (const tool of report.tools) {
    const details = tool.installed
      ? [tool.version, tool.path ? compactPath(tool.path) : undefined].filter(Boolean).join(" · ")
      : dim("not found in PATH");
    console.log(`${status(tool.installed)} ${pad(tool.name, 24)} ${details}`);
  }
  console.log();

  console.log(bold("Local history"));
  for (const history of report.histories) {
    const count = history.exists ? cyan(`${history.sessionCount} JSONL${history.sessionCount === 1 ? "" : " files"}`) : dim("not found");
    console.log(`${status(history.exists)} ${pad(history.name, 24)} ${count}`);
    console.log(`  ${pad("Path", 24)} ${compactPath(history.path)}`);
  }

  console.log();
  const fullSessionSources = report.histories.filter(
    (item) => item.name === "Claude Code sessions" || item.name === "Codex rollout sessions",
  );
  const usable = fullSessionSources.some((item) => item.exists && item.sessionCount > 0);

  if (usable) {
    console.log(`${status(true)} ${bold("Ready for Step 2: session parsing")}`);
  } else {
    console.log(`${yellow("!")} ${bold("No full Claude/Codex session traces found yet.")}`);
    console.log(dim("  Run at least one Claude Code or Codex session, then re-run `contextgym doctor`."));
  }
  console.log();
}
