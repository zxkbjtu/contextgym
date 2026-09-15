import fs from "node:fs";
import path from "node:path";
import { bold, cyan, dim, pad, status, yellow } from "../core/format.js";
import { parseCodexRollout, makeParseSummary } from "../sessions/codex-parser.js";
import { codexSessionRoot, compactHome, listCodexRollouts } from "../sessions/scan.js";
import type { SessionInspectReport } from "../types.js";

function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function sortedCounts(input: Record<string, number>): Array<[string, number]> {
  return Object.entries(input).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function printCountSection(title: string, values: Record<string, number>): void {
  console.log(bold(title));
  const rows = sortedCounts(values);
  if (rows.length === 0) {
    console.log(dim("  none"));
    return;
  }
  for (const [name, count] of rows) {
    console.log(`  ${pad(name, 30)} ${cyan(String(count))}`);
  }
}

export async function sessionsInspectCommand(options: { limit?: number; json?: boolean }): Promise<void> {
  const root = codexSessionRoot();
  const files = listCodexRollouts(root, options.limit);
  const report: SessionInspectReport = {
    root,
    scannedFiles: 0,
    totalLines: 0,
    totalParseErrors: 0,
    envelopeTypes: {},
    payloadTypes: {},
    responseItemTypes: {},
    eventMsgTypes: {},
    sessions: [],
  };

  for (const file of files) {
    const parsed = await parseCodexRollout(file.path, { includeText: false });
    report.scannedFiles += 1;
    report.totalLines += parsed.summary.lines;
    report.totalParseErrors += parsed.summary.parseErrors;
    mergeCounts(report.envelopeTypes, parsed.summary.envelopeTypes);
    mergeCounts(report.payloadTypes, parsed.summary.payloadTypes);
    mergeCounts(report.responseItemTypes, parsed.summary.responseItemTypes);
    mergeCounts(report.eventMsgTypes, parsed.summary.eventMsgTypes);
    report.sessions.push(parsed.summary);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log();
  console.log(bold("ContextGym Session Inspector"));
  console.log(dim("────────────────────────────────────────────────────────"));
  console.log(`${pad("Codex session root", 24)} ${compactHome(root)}`);
  console.log(`${pad("Rollouts scanned", 24)} ${report.scannedFiles}`);
  console.log(`${pad("JSONL lines", 24)} ${report.totalLines}`);
  console.log(`${pad("Parse errors", 24)} ${report.totalParseErrors === 0 ? "0" : yellow(String(report.totalParseErrors))}`);
  console.log();

  printCountSection("Response item schema", report.responseItemTypes);
  console.log();
  printCountSection("Event message schema", report.eventMsgTypes);
  console.log();

  console.log(bold("Recent sessions"));
  for (const session of report.sessions.slice(0, 8)) {
    const name = path.basename(session.file);
    const cwd = session.meta?.cwd ? compactHome(session.meta.cwd) : dim("unknown cwd");
    const version = session.meta?.cliVersion ? ` · Codex ${session.meta.cliVersion}` : "";
    console.log(`${status(session.parseErrors === 0)} ${name}`);
    console.log(`  ${pad("cwd", 18)} ${cwd}${version}`);
    console.log(`  ${pad("lines/events", 18)} ${session.lines} lines · ${session.parseErrors} parse errors`);
  }

  console.log();
  console.log(`${status(report.scannedFiles > 0)} ${bold("Schema fingerprint complete — no prompt/assistant text was printed.")}`);
  console.log();
}

export async function sessionsParseCommand(options: {
  limit?: number;
  out?: string;
  includeText?: boolean;
  json?: boolean;
}): Promise<void> {
  const root = codexSessionRoot();
  const files = listCodexRollouts(root, options.limit);
  const outputFile = path.resolve(options.out ?? path.join(process.cwd(), ".contextgym", "events.jsonl"));
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });

  const tempFile = `${outputFile}.tmp`;
  const output = fs.createWriteStream(tempFile, { encoding: "utf8" });
  const eventTypes: Record<string, number> = {};
  const sessionIds = new Set<string>();
  let linesRead = 0;
  let parseErrors = 0;
  let eventsWritten = 0;

  try {
    for (const file of files) {
      const parsed = await parseCodexRollout(file.path, { includeText: Boolean(options.includeText) });
      linesRead += parsed.summary.lines;
      parseErrors += parsed.summary.parseErrors;

      for (const event of parsed.events) {
        output.write(`${JSON.stringify(event)}\n`);
        eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
        sessionIds.add(event.sessionId);
        eventsWritten += 1;
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      output.end(() => resolve());
      output.on("error", reject);
    });
  }

  fs.renameSync(tempFile, outputFile);
  const summary = makeParseSummary(
    root,
    files.length,
    linesRead,
    parseErrors,
    eventsWritten,
    eventTypes,
    sessionIds.size,
    outputFile,
    Boolean(options.includeText),
  );
  const summaryFile = path.join(path.dirname(outputFile), "parse-summary.json");
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf8");

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log();
  console.log(bold("ContextGym Session Parser"));
  console.log(dim("────────────────────────────────────────────────────────"));
  console.log(`${pad("Rollouts parsed", 24)} ${summary.filesParsed}`);
  console.log(`${pad("Logical sessions", 24)} ${summary.sessions}`);
  console.log(`${pad("JSONL lines", 24)} ${summary.linesRead}`);
  console.log(`${pad("Parse errors", 24)} ${summary.parseErrors === 0 ? "0" : yellow(String(summary.parseErrors))}`);
  console.log(`${pad("AgentEvents", 24)} ${cyan(String(summary.eventsWritten))}`);
  console.log(`${pad("Message text", 24)} ${summary.includeText ? yellow("included") : "private by default (hash + length only)"}`);
  console.log();
  printCountSection("Normalized events", summary.eventTypes);
  console.log();
  console.log(`${status(true)} ${pad("Events", 20)} ${outputFile}`);
  console.log(`${status(true)} ${pad("Summary", 20)} ${summaryFile}`);
  console.log();
}
