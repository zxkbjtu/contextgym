import fs from "node:fs";
import path from "node:path";
import type {
  ContextProposal,
  FrictionFinding,
  MineReport,
  ProjectProposalDraft,
  ProposalReport,
} from "../types.js";

interface FileInspection {
  role: string;
  when: string;
  inspected: boolean;
  notes: string[];
}

function hashId(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function pathApi(value: string): typeof path.win32 | typeof path.posix {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) ? path.win32 : path.posix;
}

function normalizeForCompare(value: string): string {
  const api = pathApi(value);
  const resolved = api.resolve(value).replace(/[\\/]+$/, "");
  return api === path.win32 ? resolved.toLowerCase() : resolved;
}

function isInsideProject(file: string, project: string): boolean {
  const api = pathApi(project);
  if (api !== pathApi(file)) return false;
  const p = normalizeForCompare(project);
  const f = normalizeForCompare(file);
  const rel = api.relative(p, f);
  return rel === "" || (!rel.startsWith("..") && !api.isAbsolute(rel));
}

function relativePath(project: string, file: string): string {
  const api = pathApi(project);
  return api.relative(api.resolve(project), api.resolve(file)).replace(/\\/g, "/");
}

function basenameLower(file: string): string {
  return pathApi(file).basename(file).toLowerCase();
}

function fileContextClass(file: string): "high" | "medium" | "low" | "exclude" {
  const base = basenameLower(file);
  if ([
    ".gitignore", ".gitattributes", ".gitmodules", ".ds_store",
    "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock",
    "poetry.lock", "uv.lock", "cargo.lock", "composer.lock", "references.bib",
  ].includes(base)) return "exclude";
  if (/^(readme)(\.[a-z0-9]+)?$/i.test(base) || base === "main.tex") return "low";
  if (/(readiness|architecture|roadmap|status|decision|design|overview|guide|gate|plan|workflow|contributing)/i.test(base)) return "high";
  const ext = pathApi(file).extname(file).toLowerCase();
  if ([".md", ".py", ".ts", ".tsx", ".js", ".jsx", ".rs", ".go", ".java", ".tex"].includes(ext)) return "medium";
  return "low";
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function cleanInline(value: string, max = 180): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function firstMarkdownHeading(text: string): string | undefined {
  const match = text.match(/^#{1,3}\s+(.+)$/m);
  return match?.[1] ? cleanInline(match[1]) : undefined;
}

function stemWords(base: string): string {
  return base.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function fallbackSummary(file: string): FileInspection {
  const api = pathApi(file);
  const base = api.basename(file);
  const lower = base.toLowerCase();
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  const stem = stemWords(base);

  if (/paper_readiness|readiness/.test(lower)) {
    return {
      role: "paper readiness, blockers, and next-step status",
      when: "Read before assessing submission readiness or deciding the next manuscript task",
      inspected: false,
      notes: ["role inferred from file name"],
    };
  }
  if (/(next_.*gate|redesign_gate|decision|gate)/.test(lower)) {
    return {
      role: "method/redesign decision gate",
      when: "Read before proposing the next experiment, redesign, or direction change",
      inspected: false,
      notes: ["role inferred from file name"],
    };
  }
  if (/experimental_results\.tex$/.test(lower)) {
    return {
      role: "manuscript experimental-results section",
      when: "Read before changing reported results, comparisons, tables, or result claims",
      inspected: false,
      notes: ["role inferred from file name"],
    };
  }
  if (normalized.includes("/models/")) {
    if (/ndffn_v2\.py$/.test(lower)) {
      return { role: "NDFFN v2 model implementation", when: "Read before changing the v2 architecture or adding a model variant", inspected: false, notes: ["role inferred from path/file name"] };
    }
    if (/ndffn\.py$/.test(lower)) {
      return { role: "baseline/core NDFFN model implementation", when: "Read before comparing with or changing the original model behavior", inspected: false, notes: ["role inferred from path/file name"] };
    }
    if (/layers?_v?\d*\.py$/.test(lower)) {
      return { role: "model layer definitions", when: "Read before changing layer composition, tensor flow, or reusable model blocks", inspected: false, notes: ["role inferred from path/file name"] };
    }
    if (/dynamics?_v?\d*\.py$/.test(lower)) {
      return { role: "model dynamics implementation", when: "Read before changing dynamic-state behavior or related v2 dynamics", inspected: false, notes: ["role inferred from path/file name"] };
    }
    return { role: `model implementation module (${stem})`, when: "Read before changing the model behavior owned by this module", inspected: false, notes: ["role inferred from directory"] };
  }
  if (normalized.includes("/experiments/")) {
    if (/routing[_-]?controls?/.test(lower)) {
      return { role: "routing-control experiment logic", when: "Read before changing routing controls or interpreting routing ablations", inspected: false, notes: ["role inferred from path/file name"] };
    }
    const exp = lower.match(/^exp(\d+[a-z]?)[_-](.+)\.py$/);
    if (exp) {
      return { role: `experiment ${exp[1]} script (${stemWords(exp[2]!)})`, when: "Read before reproducing, extending, or comparing this experiment", inspected: false, notes: ["role inferred from experiment file name"] };
    }
    return { role: `experiment/control script (${stem})`, when: "Read before reproducing or extending this experiment", inspected: false, notes: ["role inferred from directory"] };
  }
  if (normalized.includes("/manuscript/")) {
    return { role: `manuscript source (${stem})`, when: "Read before editing or validating this manuscript component", inspected: false, notes: ["role inferred from directory"] };
  }
  if (lower.endsWith(".md")) {
    return { role: `repository note (${stem})`, when: "Read when the task touches the topic represented by this note", inspected: false, notes: ["role inferred from extension/file name"] };
  }
  if (lower.endsWith(".py")) {
    return { role: `Python module (${stem})`, when: "Read before changing behavior implemented by this module", inspected: false, notes: ["role inferred from extension/file name"] };
  }
  return { role: `repository file (${stem})`, when: "Read when the task directly touches this file's responsibility", inspected: false, notes: ["generic path-based fallback"] };
}

function pythonSummary(text: string, file: string): FileInspection {
  const fallback = fallbackSummary(file);
  const notes = [...fallback.notes];
  const doc = text.slice(0, 5000).match(/^(?:#!.*\n)?(?:#.*\n|\s)*[rubfRUBF]*(?:"""|''')([\s\S]{1,500}?)(?:"""|''')/m)?.[1];
  if (doc) notes.push(`module docstring: ${cleanInline(doc, 120)}`);
  const classes = [...text.matchAll(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].slice(0, 4).map((m) => m[1]!);
  const funcs = [...text.matchAll(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].slice(0, 5).map((m) => m[1]!);
  if (classes.length) notes.push(`classes: ${classes.join(", ")}`);
  if (funcs.length) notes.push(`functions: ${funcs.join(", ")}`);

  let role = fallback.role;
  if (classes.length) role = `${fallback.role}; defines ${classes.slice(0, 3).map((s) => `\`${s}\``).join(", ")}`;
  else if (funcs.length && !/experiment/.test(fallback.role)) role = `${fallback.role}; exposes ${funcs.slice(0, 3).map((s) => `\`${s}\``).join(", ")}`;
  return { role, when: fallback.when, inspected: true, notes };
}

function texSummary(text: string, file: string): FileInspection {
  const fallback = fallbackSummary(file);
  const notes = [...fallback.notes];
  const title = text.match(/\\title\{([^{}]{1,240})\}/)?.[1];
  const section = text.match(/\\(?:section|subsection)\*?\{([^{}]{1,240})\}/)?.[1];
  const inputs = [...text.matchAll(/\\(?:input|include)\{([^{}]+)\}/g)].slice(0, 6).map((m) => m[1]!);
  if (title) notes.push(`title: ${cleanInline(title, 120)}`);
  if (section) notes.push(`section: ${cleanInline(section, 120)}`);
  if (inputs.length) notes.push(`includes: ${inputs.join(", ")}`);
  const role = section ? `${fallback.role}: ${cleanInline(section, 100)}` : fallback.role;
  return { role, when: fallback.when, inspected: true, notes };
}

function markdownSummary(text: string, file: string): FileInspection {
  const fallback = fallbackSummary(file);
  const heading = firstMarkdownHeading(text);
  const notes = [...fallback.notes];
  if (heading) notes.push(`heading: ${heading}`);
  const role = heading ? `${fallback.role}: ${heading}` : fallback.role;
  return { role, when: fallback.when, inspected: true, notes };
}

function inspectFile(file: string): FileInspection {
  const fallback = fallbackSummary(file);
  if (!fs.existsSync(file)) return { ...fallback, notes: [...fallback.notes, "file not found at proposal-generation time"] };
  let stat: fs.Stats;
  try { stat = fs.statSync(file); }
  catch { return { ...fallback, notes: [...fallback.notes, "file metadata could not be read"] }; }
  if (!stat.isFile()) return { ...fallback, notes: [...fallback.notes, "path is not a regular file"] };

  const maxBytes = 160_000;
  let text = "";
  try {
    const fd = fs.openSync(file, "r");
    const size = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    fs.closeSync(fd);
    text = buf.toString("utf8").replace(/^\uFEFF/, "");
  } catch {
    return { ...fallback, notes: [...fallback.notes, "file content could not be read"] };
  }

  const ext = pathApi(file).extname(file).toLowerCase();
  if (ext === ".md") return markdownSummary(text, file);
  if (ext === ".py") return pythonSummary(text, file);
  if (ext === ".tex") return texSummary(text, file);
  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    const exports = [...text.matchAll(/(?:export\s+)?(?:async\s+)?(?:function|class|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)].slice(0, 5).map((m) => m[1]!);
    return {
      role: exports.length ? `${fallback.role}; exposes ${exports.slice(0, 3).map((s) => `\`${s}\``).join(", ")}` : fallback.role,
      when: fallback.when,
      inspected: true,
      notes: [...fallback.notes, ...(exports.length ? [`symbols: ${exports.join(", ")}`] : [])],
    };
  }
  return { ...fallback, inspected: true };
}

function repositoryMapProposal(finding: FrictionFinding): ContextProposal | { skip: string } {
  if (!finding.file) return { skip: "missing file evidence" };
  if (!isInsideProject(finding.file, finding.project)) return { skip: "file is outside the project root" };
  const value = fileContextClass(finding.file);
  if (value === "exclude") return { skip: "file type is low-value/generated metadata for persistent context" };
  if (value === "low") return { skip: "file role is already obvious; repeated reads do not justify persistent context yet" };
  const score = finding.proposalScore ?? 0;
  if (value === "medium" && score < 70) return { skip: "medium-value file needs proposal score >= 70" };

  const rel = relativePath(finding.project, finding.file);
  const inspection = inspectFile(finding.file);
  // ASCII-only separator/quotes keep drafts readable in Windows PowerShell 5.1.
  const markdown = `- \`${rel}\` - ${inspection.role}. ${inspection.when}.`;
  return {
    id: `proposal-${hashId(finding.id)}`,
    sourceFindingId: finding.id,
    kind: "repository_map",
    project: finding.project,
    score,
    title: `Repository map: ${rel}`,
    rationale: `${finding.occurrences} reads across ${finding.turns} turn(s); a compact role/when-to-read hint may reduce rediscovery without copying file contents into context.`,
    markdown,
    estimatedTokens: estimateTokens(markdown),
    avoidableToolCalls: finding.avoidableToolCalls,
    file: finding.file,
    relativePath: rel,
    inspected: inspection.inspected,
    inspectionNotes: inspection.notes,
  };
}

function commandRuleProposal(finding: FrictionFinding): ContextProposal | { skip: string } {
  if (!finding.command || !finding.recoveryCommand) return { skip: "recovery finding lacks both commands" };
  const category = finding.category ?? "task";
  const markdown = `- For ${category}, prefer \`${finding.recoveryCommand}\`. Avoid \`${finding.command}\` when the same repository conditions apply.`;
  return {
    id: `proposal-${hashId(finding.id)}`,
    sourceFindingId: finding.id,
    kind: "command_rule",
    project: finding.project,
    score: finding.proposalScore ?? 0,
    title: `${category} command rule`,
    rationale: `Observed a failed-to-successful command recovery pattern ${finding.occurrences} time(s).`,
    markdown,
    estimatedTokens: estimateTokens(markdown),
    avoidableToolCalls: finding.avoidableToolCalls,
    command: finding.command,
    recoveryCommand: finding.recoveryCommand,
    inspected: false,
  };
}

function slug(project: string): string {
  const api = pathApi(project);
  const base = api.basename(project) || "project";
  return `${base.replace(/[^A-Za-z0-9._-]+/g, "-")}-${hashId(normalizeForCompare(project)).slice(0, 6)}`;
}

function repoSection(rel: string): string {
  const p = rel.replace(/\\/g, "/").toLowerCase();
  const base = p.split("/").pop() ?? p;
  if (/readiness|gate|decision|status|roadmap|plan/.test(base)) return "Project status and decisions";
  if (p.startsWith("models/")) return "Core model";
  if (p.startsWith("experiments/")) return "Experiments";
  if (p.startsWith("manuscript/")) return "Manuscript";
  return "Repository map";
}

function experimentFamily(rel: string): string | undefined {
  const base = rel.replace(/\\/g, "/").split("/").pop() ?? rel;
  return base.match(/^exp(\d+)[a-z]?[_-]/i)?.[1];
}

function compactRepositoryLines(proposals: ContextProposal[]): string[] {
  const bySection = new Map<string, ContextProposal[]>();
  for (const proposal of proposals) {
    const section = repoSection(proposal.relativePath ?? "");
    const bucket = bySection.get(section) ?? [];
    bucket.push(proposal);
    bySection.set(section, bucket);
  }

  const order = ["Project status and decisions", "Core model", "Experiments", "Manuscript", "Repository map"];
  const parts: string[] = [];
  for (const section of order) {
    const ps = bySection.get(section);
    if (!ps?.length) continue;
    parts.push("", `## ${section}`, "");

    if (section === "Experiments") {
      const families = new Map<string, ContextProposal[]>();
      const singles: ContextProposal[] = [];
      for (const p of ps) {
        const family = experimentFamily(p.relativePath ?? "");
        if (!family) { singles.push(p); continue; }
        const bucket = families.get(family) ?? [];
        bucket.push(p);
        families.set(family, bucket);
      }
      for (const p of singles) parts.push(p.markdown);
      for (const [family, members] of families.entries()) {
        if (members.length < 2) {
          parts.push(members[0]!.markdown);
          continue;
        }
        const paths = members.map((m) => `\`${m.relativePath}\``).join(", ");
        parts.push(`- ${paths} - experiment ${family} variants. Read together before reproducing, extending, or comparing this experiment family.`);
      }
      continue;
    }

    parts.push(...ps.map((p) => p.markdown));
  }
  return parts;
}

function makeProjectDraft(project: string, proposals: ContextProposal[], outDir: string): ProjectProposalDraft {
  const repo = proposals.filter((p) => p.kind === "repository_map");
  const commands = proposals.filter((p) => p.kind === "command_rule");
  const parts: string[] = [
    "<!-- ContextGym draft: review before copying into AGENTS.md / CLAUDE.md. -->",
  ];
  if (repo.length) parts.push(...compactRepositoryLines(repo));
  if (commands.length) parts.push("", "## Repository commands", "", ...commands.map((p) => p.markdown));
  const markdown = `${parts.join("\n").trim()}\n`;
  const file = path.join(outDir, `${slug(project)}.md`);
  return {
    project,
    file,
    proposals: proposals.length,
    estimatedTokens: estimateTokens(markdown),
    avoidableToolCalls: proposals.reduce((sum, p) => sum + p.avoidableToolCalls, 0),
    markdown,
  };
}

export function generateProposalReport(
  mine: MineReport,
  inputFile: string,
  outDir: string,
  options: { minScore: number; top: number; project?: string },
): ProposalReport {
  const skipped: ProposalReport["skipped"] = [];
  const selected: ContextProposal[] = [];
  const projectFilter = options.project ? normalizeForCompare(options.project) : undefined;
  const eligible = mine.findings.filter((f) => f.action === "propose");

  for (const finding of eligible) {
    if (projectFilter && normalizeForCompare(finding.project) !== projectFilter) continue;
    const score = finding.proposalScore ?? 0;
    if (score < options.minScore) {
      skipped.push({ findingId: finding.id, project: finding.project, reason: `proposal score ${score} < min-score ${options.minScore}` });
      continue;
    }
    const result = finding.kind === "repeated_file_read"
      ? repositoryMapProposal(finding)
      : finding.kind === "command_recovery"
        ? commandRuleProposal(finding)
        : { skip: `finding kind ${finding.kind} is not proposal-generatable yet` };
    if ("skip" in result) {
      skipped.push({ findingId: finding.id, project: finding.project, reason: result.skip });
      continue;
    }
    selected.push(result);
  }

  selected.sort((a, b) => b.score - a.score || b.avoidableToolCalls - a.avoidableToolCalls || a.title.localeCompare(b.title));
  const proposals = selected.slice(0, options.top);
  const byProject = new Map<string, ContextProposal[]>();
  for (const proposal of proposals) {
    const bucket = byProject.get(proposal.project) ?? [];
    bucket.push(proposal);
    byProject.set(proposal.project, bucket);
  }
  const projects = [...byProject.entries()].map(([project, ps]) => makeProjectDraft(project, ps, outDir));
  projects.sort((a, b) => b.proposals - a.proposals || b.avoidableToolCalls - a.avoidableToolCalls || a.project.localeCompare(b.project));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    inputFile,
    findingsRead: mine.findings.length,
    eligibleFindings: eligible.length,
    skippedFindings: skipped.length + Math.max(0, selected.length - proposals.length),
    minScore: options.minScore,
    proposals,
    projects,
    skipped,
  };
}
