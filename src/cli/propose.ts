import fs from "node:fs";
import path from "node:path";
import { bold, cyan, dim, pad } from "../core/format.js";
import { generateProposalReport } from "../proposals/generator.js";
import type { MineReport } from "../types.js";

export async function proposeCommand(options: {
  input?: string;
  outDir?: string;
  minScore?: number;
  top?: number;
  project?: string;
  json?: boolean;
}): Promise<void> {
  const inputFile = path.resolve(options.input ?? path.join(process.cwd(), ".contextgym", "friction-report.json"));
  const outDir = path.resolve(options.outDir ?? path.join(process.cwd(), ".contextgym", "proposals"));
  const minScore = options.minScore ?? 65;
  const top = options.top ?? 20;
  if (!fs.existsSync(inputFile)) throw new Error(`Friction report not found: ${inputFile}. Run 'contextgym mine' first.`);

  let mine: MineReport;
  try { mine = JSON.parse(fs.readFileSync(inputFile, "utf8")) as MineReport; }
  catch (error) { throw new Error(`Could not read friction report: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(mine.findings)) throw new Error("Invalid friction report: findings[] is missing");

  fs.mkdirSync(outDir, { recursive: true });
  const report = generateProposalReport(mine, inputFile, outDir, { minScore, top, project: options.project });
  for (const project of report.projects) fs.writeFileSync(project.file, project.markdown, "utf8");
  const reportFile = path.join(outDir, "proposals.json");
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", "utf8");

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log();
  console.log(bold("ContextGym Context Proposal Generator"));
  console.log(dim("────────────────────────────────────────────────────────"));
  console.log(`${pad("Findings read", 27)} ${report.findingsRead}`);
  console.log(`${pad("Eligible mine findings", 27)} ${report.eligibleFindings}`);
  console.log(`${pad("Generated proposals", 27)} ${cyan(String(report.proposals.length))}`);
  console.log(`${pad("Skipped / filtered", 27)} ${report.skippedFindings}`);
  console.log(`${pad("Projects", 27)} ${report.projects.length}`);
  console.log(`${pad("Min proposal score", 27)} ${report.minScore}`);
  console.log(`${pad("Estimated context tokens", 27)} ${report.projects.reduce((s, p) => s + p.estimatedTokens, 0)}`);
  console.log(`${pad("Historical avoidable calls", 27)} ${report.projects.reduce((s, p) => s + p.avoidableToolCalls, 0)}`);
  console.log(`${pad("Source files inspected", 27)} ${report.proposals.filter((p) => p.kind === "repository_map" && p.inspected).length}/${report.proposals.filter((p) => p.kind === "repository_map").length}`);
  console.log();

  if (report.projects.length === 0) {
    console.log(dim("No proposal survived the safety/value filters. Try --min-score 60 for exploratory output."));
  } else {
    for (const project of report.projects) {
      console.log(bold(project.project));
      console.log(`  ${dim("draft")} ${project.file}`);
      console.log(`  ${dim("proposals")} ${project.proposals} · ${dim("~tokens")} ${project.estimatedTokens} · ${dim("avoidable calls")} ${project.avoidableToolCalls}`);
      for (const proposal of report.proposals.filter((p) => p.project === project.project)) {
        const inspectTag = proposal.kind === "repository_map" ? (proposal.inspected ? "inspected" : "path fallback") : "history";
        console.log(`  ${cyan("+")} ${proposal.title} ${dim(`score ${proposal.score} · ~${proposal.estimatedTokens} tokens · ${inspectTag}`)}`);
      }
      console.log();
    }
  }

  console.log(`${dim("Proposal report:")} ${reportFile}`);
  console.log(dim("Drafts are review-only. ContextGym does not modify AGENTS.md / CLAUDE.md in this step."));
  console.log();
}
