import path from "node:path";
import { bold, dim, pad } from "../core/format.js";
import { generateProbes } from "../probes/generator.js";

export function probeCommand(options: { project: string; proposalReport?: string; outDir?: string; top?: number; json?: boolean }): void {
  const report = generateProbes({
    project: options.project,
    proposalReportFile: options.proposalReport ?? path.join(process.cwd(), ".contextgym", "proposals", "proposals.json"),
    outDir: options.outDir ?? path.join(process.cwd(), ".contextgym", "probes"),
    top: options.top ?? 3,
  });
  if (options.json) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log();
  console.log(bold("ContextGym Auto Context Probe Generator"));
  console.log(dim("────────────────────────────────────────────────────────"));
  console.log(`${pad("Project", 28)} ${report.project}`);
  console.log(`${pad("Generated probes", 28)} ${report.probes.length}`);
  console.log();
  for (const p of report.probes) {
    console.log(`  ${p.id}`);
    console.log(`    role     ${p.role}`);
    console.log(`    target   ${p.targetRelativePath}`);
    console.log(`    task     ${p.taskFile}`);
    console.log(`    verifier ${p.verifierFile}`);
    console.log(`    eval     node dist/index.js eval --project "${p.project}" --proposal "${p.proposalFile}" --task-file "${p.taskFile}" --verify-file "${p.verifierFile}" --runs 3`);
    console.log();
  }
  console.log(`${dim("Probe report:")} ${report.outputFile}`);
  console.log();
}
