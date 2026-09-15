import fs from "node:fs";
import path from "node:path";
import { bold, cyan, dim, pad, yellow } from "../core/format.js";
import { readAgentEvents } from "../mining/events.js";
import { mineFriction } from "../mining/friction.js";
import type { FrictionFinding } from "../types.js";

function severityMark(severity: FrictionFinding["severity"]): string {
  if (severity === "critical") return "!!!";
  if (severity === "high") return "!! ";
  if (severity === "medium") return "!  ";
  return "·  ";
}

function findingDetail(finding: FrictionFinding): void {
  console.log(`${severityMark(finding.severity)} ${bold(finding.title)} ${dim(`[${finding.severity}]`)}`);
  console.log(`    ${dim("Project:")} ${finding.project}`);
  console.log(`    ${dim("Class:")} ${finding.scope} · ${finding.action} · evidence ${finding.evidenceLevel}${finding.proposalScore !== undefined ? ` · proposal ${finding.proposalScore}/100` : ""}`);
  console.log(`    ${finding.summary}`);
  if (finding.projectsAffected) console.log(`    ${dim("Projects affected:")} ${finding.projectsAffected}`);
  if (finding.command) console.log(`    ${dim("Command:")} ${finding.command}`);
  if (finding.recoveryCommand) console.log(`    ${dim("Recovered with:")} ${cyan(finding.recoveryCommand)}`);
  if (finding.file) console.log(`    ${dim("File:")} ${finding.file}`);
  console.log(`    ${dim("Evidence:")} ${finding.occurrences} occurrence(s) · ${finding.sessions} session(s) · ${finding.turns} turn(s) · confidence ${finding.confidence.toFixed(2)}`);
  if (finding.avoidableToolCalls > 0) console.log(`    ${dim("Potentially avoidable tool calls:")} ${finding.avoidableToolCalls}`);
  if (finding.suggestion) console.log(`    ${dim("Next:")} ${finding.suggestion}`);
}

export async function mineCommand(options: {
  input?: string;
  out?: string;
  minCount?: number;
  top?: number;
  json?: boolean;
  proposalsOnly?: boolean;
}): Promise<void> {
  const inputFile = path.resolve(options.input ?? path.join(process.cwd(), ".contextgym", "events.jsonl"));
  const outputFile = path.resolve(options.out ?? path.join(process.cwd(), ".contextgym", "friction-report.json"));
  const minCount = options.minCount ?? 2;
  const top = options.top ?? 15;

  const read = await readAgentEvents(inputFile);
  const report = mineFriction(read.events, inputFile, minCount);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + "\n", "utf8");

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log();
  console.log(bold("ContextGym Friction Miner"));
  console.log(dim("────────────────────────────────────────────────────────"));
  console.log(`${pad("Input events", 25)} ${report.eventsRead}`);
  console.log(`${pad("Rollout files", 25)} ${report.rolloutFiles}`);
  console.log(`${pad("Logical sessions", 25)} ${report.logicalSessions}`);
  console.log(`${pad("Projects", 25)} ${report.projects}`);
  console.log(`${pad("Tool calls", 25)} ${report.toolCalls}`);
  console.log(`${pad("Command observations", 25)} ${report.commandCalls}`);
  console.log(`${pad("Known failed commands", 25)} ${report.failedCommandCalls}`);
  console.log(`${pad("Unknown command results", 25)} ${report.unknownCommandResults}`);
  if (read.parseErrors > 0) console.log(`${pad("Event parse errors", 25)} ${yellow(String(read.parseErrors))}`);
  console.log(`${pad("Proposal candidates", 25)} ${cyan(String(report.proposalCandidates))}`);
  console.log(`${pad("Needs investigation", 25)} ${report.investigationFindings}`);
  console.log(`${pad("Environment issues", 25)} ${report.environmentFindings}`);
  console.log(`${pad("Workflow issues", 25)} ${report.workflowFindings}`);
  console.log(`${pad("Friction findings", 25)} ${cyan(String(report.findings.length))}`);
  console.log();

  const pool = options.proposalsOnly ? report.findings.filter((f) => f.action === "propose") : report.findings;
  const shown = pool.slice(0, Math.max(0, top));
  if (shown.length === 0) {
    console.log(dim(options.proposalsOnly
      ? "No findings currently qualify as repository-context proposal candidates."
      : `No findings met min-count=${minCount}. Try --min-count 1 for exploratory output.`));
  } else {
    console.log(bold(`${options.proposalsOnly ? "Proposal candidates" : "Top findings"} (${shown.length}/${pool.length})`));
    console.log();
    for (let i = 0; i < shown.length; i += 1) {
      console.log(`${String(i + 1).padStart(2, "0")}.`);
      findingDetail(shown[i]!);
      console.log();
    }
  }

  console.log(`${dim("Full report:")} ${outputFile}`);
  console.log(dim("Commands are redacted for common token/key/password patterns before being written to the report."));
  console.log();
}
