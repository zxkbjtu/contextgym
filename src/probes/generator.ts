import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ContextProbe, ContextProposal, ProbeReport, ProposalReport } from "../types.js";

function norm(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function hash(value: string): string { return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8); }
function slug(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project"; }

function extractRole(p: ContextProposal): string {
  const rel = p.relativePath ?? "";
  const prefix = rel ? `- \`${rel}\` - ` : "";
  let text = p.markdown.trim();
  if (prefix && text.startsWith(prefix)) text = text.slice(prefix.length);
  text = text.replace(/^[-*]\s*/, "");
  const read = text.search(/\.\s+Read\b/i);
  if (read >= 0) text = text.slice(0, read);
  return text.replace(/\.$/, "").trim() || p.title;
}

function powershellVerifier(expected: string, answer: string): string {
  const e = expected.replace(/'/g, "''");
  const a = answer.replace(/'/g, "''");
  return `$ErrorActionPreference = "Stop"\n$expected = '${e}'\n$answerFile = '${a}'\nif (-not (Test-Path -LiteralPath $answerFile)) { Write-Error "probe answer file not found"; exit 1 }\n$answer = (Get-Content -LiteralPath $answerFile -Raw).Trim().Replace('\\','/')\nif ($answer -ne $expected) { Write-Error "expected '$expected', got '$answer'"; exit 1 }\n$tracked = @(git diff --name-only | Where-Object { $_ -and $_.Trim() })\nif ($tracked.Count -ne 0) { Write-Error "existing repository files were modified: $($tracked -join ', ')"; exit 1 }\n$untracked = @(git ls-files --others --exclude-standard | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Replace('\\','/') })\n$other = @($untracked | Where-Object { $_ -ne $answerFile })\nif ($other.Count -ne 0) { Write-Error "unexpected files created: $($other -join ', ')"; exit 1 }\nexit 0\n`;
}

function shellVerifier(expected: string, answer: string): string {
  const sq = (v: string) => `'${v.replace(/'/g, `'"'"'`)}'`;
  return `#!/bin/sh\nset -eu\nexpected=${sq(expected)}\nanswer_file=${sq(answer)}\n[ -f "$answer_file" ] || { echo "probe answer file not found" >&2; exit 1; }\nanswer=$(tr '\\\\' '/' < "$answer_file" | tr -d '\\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')\n[ "$answer" = "$expected" ] || { echo "expected '$expected', got '$answer'" >&2; exit 1; }\n[ -z "$(git diff --name-only)" ] || { echo "existing repository files were modified" >&2; exit 1; }\nothers=$(git ls-files --others --exclude-standard | tr '\\\\' '/' | grep -v -F -x "$answer_file" || true)\n[ -z "$others" ] || { echo "unexpected files created: $others" >&2; exit 1; }\n`;
}

export function generateProbes(options: { project: string; proposalReportFile: string; outDir: string; top: number }): ProbeReport {
  const project = path.resolve(options.project);
  const proposalReportFile = path.resolve(options.proposalReportFile);
  if (!fs.existsSync(proposalReportFile)) throw new Error(`Proposal report not found: ${proposalReportFile}`);
  const report = JSON.parse(fs.readFileSync(proposalReportFile, "utf8")) as ProposalReport;
  const draft = report.projects.find((p) => norm(p.project) === norm(project));
  if (!draft) throw new Error(`No proposal draft for project ${project}. Run contextgym propose --project first.`);
  const eligible = report.proposals
    .filter((p) => norm(p.project) === norm(project) && p.kind === "repository_map" && p.relativePath)
    .sort((a, b) => b.score - a.score || b.avoidableToolCalls - a.avoidableToolCalls)
    .slice(0, options.top);
  if (!eligible.length) throw new Error(`No repository-map proposals available for ${project}.`);
  const outDir = path.resolve(options.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const answerFile = ".contextgym-probe-answer.txt";
  const probes: ContextProbe[] = [];
  for (const p of eligible) {
    const expected = p.relativePath!.replace(/\\/g, "/");
    const role = extractRole(p);
    const id = `${slug(path.basename(project))}-${hash(`${p.id}|${expected}|${role}`)}`;
    const taskFile = path.join(outDir, `${id}.task.md`);
    const verifierFile = path.join(outDir, `${id}.verify.${process.platform === "win32" ? "ps1" : "sh"}`);
    const task = `Repository navigation probe.\n\nFind the single repository file whose responsibility best matches this role:\n\n${role}\n\nWrite only its repository-relative path (use forward slashes, no quotes, exactly one non-empty line) to \`${answerFile}\`.\nDo not modify any existing repository file. Do not create any other file.\n`;
    fs.writeFileSync(taskFile, task, "utf8");
    fs.writeFileSync(verifierFile, process.platform === "win32" ? powershellVerifier(expected, answerFile) : shellVerifier(expected, answerFile), "utf8");
    probes.push({ id, project, proposalId: p.id, proposalFile: draft.file, targetRelativePath: expected, role, score: p.score, estimatedProposalTokens: draft.estimatedTokens, answerFile, taskFile, verifierFile });
  }
  const outputFile = path.join(outDir, "probes.json");
  const result: ProbeReport = { schemaVersion: 1, generatedAt: new Date().toISOString(), project, proposalReportFile, probes, outputFile };
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2) + "\n", "utf8");
  return result;
}
