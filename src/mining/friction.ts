import path from "node:path";
import type { AgentEvent, EvidenceLevel, FrictionAction, FrictionFinding, FrictionScope, MineReport } from "../types.js";
import { commandCategory, displayCommand, inferReadPaths, normalizeCommand } from "./command.js";

interface CommandCall {
  index: number;
  project: string;
  projectLabel: string;
  sessionId: string;
  sourceFile: string;
  turnKey: string;
  turnId?: string;
  timestamp?: string;
  tool?: string;
  command: string;
  canonical: string;
  display: string;
  category: ReturnType<typeof commandCategory>;
  success?: boolean;
  exitCode?: number;
  resultKnown: boolean;
  nested: boolean;
  cwd?: string;
}

function projectKey(event: AgentEvent): { key: string; label: string } {
  const cwd = event.cwd?.trim();
  if (!cwd) return { key: "<unknown-project>", label: "<unknown-project>" };
  const normalized = path.resolve(cwd).replace(/[\\/]+$/, "").toLowerCase();
  return { key: normalized, label: cwd };
}

function logicalTurnKey(event: AgentEvent): string {
  return `${event.sessionId}::${event.turnId ?? `source:${event.sourceFile}`}`;
}

function severityFromCount(count: number): FrictionFinding["severity"] {
  if (count >= 8) return "critical";
  if (count >= 4) return "high";
  if (count >= 2) return "medium";
  return "low";
}

function confidenceForCalls(calls: CommandCall[]): number {
  if (calls.length === 0) return 0;
  const direct = calls.filter((c) => !c.nested).length;
  const known = calls.filter((c) => c.resultKnown).length;
  const quality = 0.65 + 0.2 * (direct / calls.length) + 0.15 * (known / calls.length);
  return Math.min(0.99, Math.round(quality * 100) / 100);
}

function makeId(kind: string, project: string, payload: string): string {
  let hash = 2166136261;
  const s = `${kind}\u0000${project}\u0000${payload}`;
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${kind}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function evidenceLevel(sessions: number, turns: number, occurrences: number): EvidenceLevel {
  if (sessions >= 2 || turns >= 5 || occurrences >= 8) return "strong";
  if (turns >= 2 || occurrences >= 3) return "moderate";
  return "weak";
}

function proposalScore(params: { sessions: number; turns: number; occurrences: number; confidence: number; recovery?: boolean }): number {
  const session = Math.min(25, params.sessions * 15);
  const turn = Math.min(25, params.turns * 4);
  const occurrence = Math.min(20, params.occurrences * 2);
  const confidence = Math.round(params.confidence * 20);
  const recovery = params.recovery ? 10 : 0;
  return Math.min(100, session + turn + occurrence + confidence + recovery);
}

function pairCalls(events: AgentEvent[]): CommandCall[] {
  const results = new Map<string, AgentEvent[]>();
  for (const event of events) {
    if (event.type !== "tool_result" || !event.callId) continue;
    const key = `${event.sourceFile}\u0000${event.callId}`;
    const bucket = results.get(key) ?? [];
    bucket.push(event);
    results.set(key, bucket);
  }

  const calls: CommandCall[] = [];
  let index = 0;
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const commands = event.commands?.length ? event.commands : event.command ? [event.command] : [];
    if (commands.length === 0) continue;
    const result = event.callId ? results.get(`${event.sourceFile}\u0000${event.callId}`)?.[0] : undefined;
    const project = projectKey(event);
    const ambiguousNestedResult = (event.commands?.length ?? 0) > 1;

    for (const command of commands) {
      if (!command.trim()) continue;
      calls.push({
        index: index++,
        project: project.key,
        projectLabel: project.label,
        sessionId: event.sessionId,
        sourceFile: event.sourceFile,
        turnKey: logicalTurnKey(event),
        turnId: event.turnId,
        timestamp: event.timestamp,
        tool: event.tool,
        command,
        canonical: normalizeCommand(command),
        display: displayCommand(command),
        category: commandCategory(command),
        success: ambiguousNestedResult ? undefined : result?.success,
        exitCode: ambiguousNestedResult ? undefined : result?.exitCode,
        resultKnown: !ambiguousNestedResult && (result?.success !== undefined || result?.exitCode !== undefined),
        nested: (event.commands?.length ?? 0) > 1 || event.tool?.toLowerCase() === "exec",
        cwd: event.workdir ?? event.cwd,
      });
    }
  }
  return calls;
}

function crossProjectFailureKeys(calls: CommandCall[]): Map<string, { calls: CommandCall[]; projects: Set<string>; turns: Set<string>; sessions: Set<string> }> {
  const groups = new Map<string, { calls: CommandCall[]; projects: Set<string>; turns: Set<string>; sessions: Set<string> }>();
  for (const call of calls) {
    if (call.success !== false) continue;
    const existing = groups.get(call.canonical) ?? { calls: [], projects: new Set<string>(), turns: new Set<string>(), sessions: new Set<string>() };
    existing.calls.push(call);
    existing.projects.add(call.project);
    existing.turns.add(call.turnKey);
    existing.sessions.add(call.sessionId);
    groups.set(call.canonical, existing);
  }
  return groups;
}

function crossProjectFailures(calls: CommandCall[], minCount: number): { findings: FrictionFinding[]; suppressedKeys: Set<string> } {
  const groups = crossProjectFailureKeys(calls);
  const findings: FrictionFinding[] = [];
  const suppressedKeys = new Set<string>();

  for (const [canonical, item] of groups.entries()) {
    if (item.projects.size < 2 || item.calls.length < minCount) continue;
    const first = item.calls[0]!;
    suppressedKeys.add(canonical);
    const confidence = confidenceForCalls(item.calls);
    findings.push({
      id: makeId("cross-project-failure", "<global>", canonical),
      kind: "cross_project_command_failure",
      severity: severityFromCount(item.calls.length),
      confidence,
      project: "<global>",
      title: "Cross-project failing command",
      summary: `The same command failed ${item.calls.length} times across ${item.projects.size} projects and ${item.turns.size} turn(s).`,
      command: first.display,
      category: first.category,
      occurrences: item.calls.length,
      sessions: item.sessions.size,
      turns: item.turns.size,
      avoidableToolCalls: Math.max(0, item.calls.length - item.projects.size),
      scope: "environment",
      action: "investigate",
      evidenceLevel: evidenceLevel(item.sessions.size, item.turns.size, item.calls.length),
      projectsAffected: item.projects.size,
      suggestion: "Treat this as a machine/toolchain or global-agent issue first. Do not duplicate it into every repository's AGENTS.md unless the prerequisite truly differs by repo.",
    });
  }

  return { findings, suppressedKeys };
}

function repeatedFailures(calls: CommandCall[], minCount: number, suppressedKeys: Set<string>): FrictionFinding[] {
  const groups = new Map<string, CommandCall[]>();
  for (const call of calls) {
    if (call.success !== false || suppressedKeys.has(call.canonical)) continue;
    const key = `${call.project}\u0000${call.canonical}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(call);
    groups.set(key, bucket);
  }

  const findings: FrictionFinding[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length < minCount) continue;
    const first = bucket[0]!;
    const sessions = new Set(bucket.map((c) => c.sessionId));
    const turns = new Set(bucket.map((c) => c.turnKey));
    const confidence = confidenceForCalls(bucket);
    const scope: FrictionScope = "repository";
    const action: FrictionAction = "investigate";
    const categoryLabel = first.category === "other" ? "" : `${first.category} `;
    findings.push({
      id: makeId("repeated-failure", first.project, first.canonical),
      kind: "repeated_command_failure",
      severity: severityFromCount(bucket.length),
      confidence,
      project: first.projectLabel,
      title: `Repeated failing ${categoryLabel}command`,
      summary: `The same command failed ${bucket.length} times across ${turns.size} turn(s).`,
      command: first.display,
      category: first.category,
      occurrences: bucket.length,
      sessions: sessions.size,
      turns: turns.size,
      avoidableToolCalls: Math.max(0, bucket.length - 1),
      scope,
      action,
      evidenceLevel: evidenceLevel(sessions.size, turns.size, bucket.length),
      suggestion: first.category === "test" || first.category === "lint" || first.category === "build"
        ? `Find the successful ${first.category} command or missing prerequisite before generating a repository instruction.`
        : "Investigate the root cause before turning this failure into persistent context; repeated failure alone does not reveal the correct rule.",
    });
  }
  return findings;
}

function recoveryPatterns(calls: CommandCall[], minCount: number): FrictionFinding[] {
  const byTurn = new Map<string, CommandCall[]>();
  for (const call of calls) {
    const bucket = byTurn.get(call.turnKey) ?? [];
    bucket.push(call);
    byTurn.set(call.turnKey, bucket);
  }

  const pairs = new Map<string, { failed: CommandCall; success: CommandCall; count: number; sessions: Set<string>; turns: Set<string> }>();
  for (const turnCalls of byTurn.values()) {
    turnCalls.sort((a, b) => a.index - b.index);
    for (let i = 0; i < turnCalls.length; i += 1) {
      const failed = turnCalls[i]!;
      if (failed.success !== false) continue;
      for (let j = i + 1; j < Math.min(turnCalls.length, i + 7); j += 1) {
        const success = turnCalls[j]!;
        if (success.success !== true) continue;
        if (success.project !== failed.project) continue;
        if (success.canonical === failed.canonical) continue;
        if (failed.category !== success.category) continue;
        if (failed.category === "other" || failed.category === "git" || failed.category === "read" || failed.category === "search") continue;

        const key = `${failed.project}\u0000${failed.canonical}\u0000${success.canonical}`;
        const existing = pairs.get(key) ?? { failed, success, count: 0, sessions: new Set<string>(), turns: new Set<string>() };
        existing.count += 1;
        existing.sessions.add(failed.sessionId);
        existing.turns.add(failed.turnKey);
        pairs.set(key, existing);
        break;
      }
    }
  }

  const findings: FrictionFinding[] = [];
  for (const pair of pairs.values()) {
    const repeatedFailed = calls.filter((c) => c.project === pair.failed.project && c.canonical === pair.failed.canonical && c.success === false).length;
    if (pair.count < minCount && repeatedFailed < minCount) continue;
    const occurrences = pair.count;
    const confidence = Math.min(0.98, confidenceForCalls([pair.failed, pair.success]) + (occurrences >= 2 ? 0.03 : 0));
    const sessions = pair.sessions.size;
    const turns = pair.turns.size;
    findings.push({
      id: makeId("recovery", pair.failed.project, `${pair.failed.canonical}->${pair.success.canonical}`),
      kind: "command_recovery",
      severity: severityFromCount(Math.max(2, occurrences + repeatedFailed - 1)),
      confidence,
      project: pair.failed.projectLabel,
      title: `${pair.failed.category} command recovery pattern`,
      summary: `A failing command was followed by a successful alternative ${occurrences} time(s).`,
      command: pair.failed.display,
      recoveryCommand: pair.success.display,
      category: pair.failed.category,
      occurrences,
      sessions,
      turns,
      avoidableToolCalls: Math.max(1, repeatedFailed),
      scope: "repository",
      action: "propose",
      evidenceLevel: evidenceLevel(sessions, turns, Math.max(occurrences, repeatedFailed)),
      proposalScore: proposalScore({ sessions, turns, occurrences: Math.max(occurrences, repeatedFailed), confidence, recovery: true }),
      suggestion: `Prefer \`${pair.success.display}\` for ${pair.failed.category} and document it in repository instructions; discourage \`${pair.failed.display}\` when applicable.`,
    });
  }
  return findings;
}

function repeatLoops(calls: CommandCall[], minCount: number): FrictionFinding[] {
  const byTurn = new Map<string, CommandCall[]>();
  for (const call of calls) {
    const bucket = byTurn.get(call.turnKey) ?? [];
    bucket.push(call);
    byTurn.set(call.turnKey, bucket);
  }

  const agg = new Map<string, { sample: CommandCall; streaks: number[]; sessions: Set<string>; turns: Set<string> }>();
  for (const turnCalls of byTurn.values()) {
    turnCalls.sort((a, b) => a.index - b.index);
    let start = 0;
    while (start < turnCalls.length) {
      let end = start + 1;
      while (end < turnCalls.length && turnCalls[end]!.canonical === turnCalls[start]!.canonical) end += 1;
      const streak = end - start;
      if (streak >= Math.max(3, minCount)) {
        const sample = turnCalls[start]!;
        const key = `${sample.project}\u0000${sample.canonical}`;
        const existing = agg.get(key) ?? { sample, streaks: [], sessions: new Set<string>(), turns: new Set<string>() };
        existing.streaks.push(streak);
        existing.sessions.add(sample.sessionId);
        existing.turns.add(sample.turnKey);
        agg.set(key, existing);
      }
      start = end;
    }
  }

  const findings: FrictionFinding[] = [];
  for (const item of agg.values()) {
    const maxStreak = Math.max(...item.streaks);
    const total = item.streaks.reduce((a, b) => a + b, 0);
    findings.push({
      id: makeId("repeat-loop", item.sample.project, item.sample.canonical),
      kind: "repeated_command_loop",
      severity: maxStreak >= 10 ? "critical" : maxStreak >= 6 ? "high" : "medium",
      confidence: 0.97,
      project: item.sample.projectLabel,
      title: "Repeated command loop",
      summary: `The same command was issued consecutively up to ${maxStreak} times in one turn.`,
      command: item.sample.display,
      category: item.sample.category,
      occurrences: total,
      sessions: item.sessions.size,
      turns: item.turns.size,
      avoidableToolCalls: Math.max(0, total - item.streaks.length),
      scope: "workflow",
      action: "investigate",
      evidenceLevel: evidenceLevel(item.sessions.size, item.turns.size, total),
      suggestion: item.sample.category === "read" || item.sample.category === "search"
        ? "This looks like repeated inspection/polling. Improve the agent's wait/check strategy before adding repository context."
        : "Avoid blind polling/retry loops. Prefer bounded waits, backoff, or an explicit completion check; this is usually workflow guidance rather than repository knowledge.",
    });
  }
  return findings;
}

function pathApi(value: string): typeof path.win32 | typeof path.posix {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) ? path.win32 : path.posix;
}

function normalizePathForCompare(value: string): string {
  const api = pathApi(value);
  const resolved = api.resolve(value).replace(/[\\/]+$/, "");
  return api === path.win32 ? resolved.toLowerCase() : resolved;
}

function isPathInsideProject(file: string, project: string): boolean {
  const api = pathApi(project);
  if (api !== pathApi(file)) return false;
  const rel = api.relative(normalizePathForCompare(project), normalizePathForCompare(file));
  return rel === "" || (!rel.startsWith("..") && !api.isAbsolute(rel));
}

function persistentContextValue(file: string): "high" | "medium" | "low" | "exclude" {
  const api = pathApi(file);
  const base = api.basename(file).toLowerCase();
  if ([
    ".gitignore", ".gitattributes", ".gitmodules", ".ds_store",
    "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock",
    "poetry.lock", "uv.lock", "cargo.lock", "composer.lock", "references.bib",
  ].includes(base)) return "exclude";
  if (/^readme(?:\.[a-z0-9]+)?$/i.test(base) || base === "main.tex") return "low";
  if (/(readiness|architecture|roadmap|status|decision|design|overview|guide|gate|plan|workflow|contributing)/i.test(base)) return "high";
  const ext = api.extname(file).toLowerCase();
  if ([".md", ".py", ".ts", ".tsx", ".js", ".jsx", ".rs", ".go", ".java", ".tex"].includes(ext)) return "medium";
  return "low";
}

function repeatedFileReads(calls: CommandCall[], minCount: number): FrictionFinding[] {
  const groups = new Map<string, { project: string; projectLabel: string; file: string; calls: CommandCall[] }>();
  for (const call of calls) {
    for (const file of inferReadPaths(call.command, call.cwd)) {
      const normalized = normalizePathForCompare(file);
      const key = `${call.project}\u0000${normalized}`;
      const existing = groups.get(key) ?? { project: call.project, projectLabel: call.projectLabel, file, calls: [] };
      existing.calls.push(call);
      groups.set(key, existing);
    }
  }

  const findings: FrictionFinding[] = [];
  for (const item of groups.values()) {
    const sessions = new Set(item.calls.map((c) => c.sessionId));
    const turns = new Set(item.calls.map((c) => c.turnKey));
    if (item.calls.length < Math.max(3, minCount) || (sessions.size < 2 && turns.size < 3)) continue;
    const confidence = sessions.size >= 2 ? 0.9 : turns.size >= 5 ? 0.86 : 0.76;
    const rawScore = proposalScore({ sessions: sessions.size, turns: turns.size, occurrences: item.calls.length, confidence });
    const inside = isPathInsideProject(item.file, item.projectLabel);
    const value = persistentContextValue(item.file);

    let scope: FrictionScope = "repository";
    let action: FrictionAction = "investigate";
    let title = "Repeated repository file discovery";
    let suggestion = "Keep as an investigation signal until there is stronger evidence that a compact role hint can replace rediscovery.";
    let score: number | undefined;

    if (!inside) {
      scope = "environment";
      action = "ignore";
      title = "Repeated external file discovery";
      suggestion = "This file is outside the repository root (for example a plugin/runtime cache). Do not copy it into repository instructions.";
    } else if (value === "exclude") {
      action = "ignore";
      suggestion = "This is low-value metadata or a generated/dependency index; repeated reads do not justify persistent repository context.";
    } else if (value === "low") {
      action = "investigate";
      suggestion = "The file role is already obvious (for example README/main entry point). Repeated reads may be legitimate content access, so do not add a redundant context note yet.";
    } else {
      const enoughEvidence = sessions.size >= 2 || turns.size >= 5;
      const enoughValue = value === "high" || rawScore >= 70;
      action = enoughEvidence && enoughValue ? "propose" : "investigate";
      score = action === "propose" ? rawScore : undefined;
      suggestion = action === "propose"
        ? "Candidate for a compact repository map or file-role note. Summarize why/when to read this file; do not copy its contents into AGENTS.md."
        : "Keep as an investigation signal until the file has stronger cross-turn/session evidence or a clearer persistent-context role.";
    }

    findings.push({
      id: makeId("repeated-read", item.project, item.file.toLowerCase()),
      kind: "repeated_file_read",
      severity: item.calls.length >= 10 ? "high" : "medium",
      confidence,
      project: item.projectLabel,
      title,
      summary: `The same file was read ${item.calls.length} times across ${turns.size} turn(s).`,
      file: item.file,
      occurrences: item.calls.length,
      sessions: sessions.size,
      turns: turns.size,
      avoidableToolCalls: Math.max(0, item.calls.length - turns.size),
      scope,
      action,
      evidenceLevel: evidenceLevel(sessions.size, turns.size, item.calls.length),
      proposalScore: score,
      suggestion,
    });
  }
  return findings;
}

function abortedTurns(events: AgentEvent[], minCount: number): FrictionFinding[] {
  const groups = new Map<string, { label: string; events: AgentEvent[] }>();
  for (const event of events) {
    if (event.type !== "turn_end" || event.success !== false) continue;
    const project = projectKey(event);
    const bucket = groups.get(project.key) ?? { label: project.label, events: [] };
    bucket.events.push(event);
    groups.set(project.key, bucket);
  }

  const findings: FrictionFinding[] = [];
  for (const [project, item] of groups.entries()) {
    if (item.events.length < minCount) continue;
    const sessions = new Set(item.events.map((e) => e.sessionId));
    findings.push({
      id: makeId("aborted-turn", project, String(item.events.length)),
      kind: "aborted_turns",
      severity: severityFromCount(item.events.length),
      confidence: 0.99,
      project: item.label,
      title: "Repeated aborted turns",
      summary: `${item.events.length} Codex turns were explicitly aborted in this project.`,
      occurrences: item.events.length,
      sessions: sessions.size,
      turns: item.events.length,
      avoidableToolCalls: 0,
      scope: "investigate",
      action: "investigate",
      evidenceLevel: evidenceLevel(sessions.size, item.events.length, item.events.length),
      suggestion: "Treat this as an investigation signal rather than an automatic context fix. Compare aborted turns with retry loops and repeated failures before changing repository instructions.",
    });
  }
  return findings;
}

export function mineFriction(events: AgentEvent[], inputFile: string, minCount = 2): MineReport {
  const calls = pairCalls(events);
  const sourceFiles = new Set(events.map((e) => e.sourceFile));
  const logicalSessions = new Set(events.map((e) => e.sessionId));
  const projects = new Set(events.map((e) => projectKey(e).key));
  const crossProject = crossProjectFailures(calls, minCount);

  const recoveries = recoveryPatterns(calls, minCount);
  const recoveredFailureKeys = new Set(
    recoveries.map((f) => `${f.project.toLowerCase()}\u0000${normalizeCommand(f.command ?? "")}`),
  );
  const failures = repeatedFailures(calls, minCount, crossProject.suppressedKeys).filter(
    (f) => !recoveredFailureKeys.has(`${f.project.toLowerCase()}\u0000${normalizeCommand(f.command ?? "")}`),
  );

  const findings = [
    ...recoveries,
    ...crossProject.findings,
    ...failures,
    ...repeatLoops(calls, minCount),
    ...repeatedFileReads(calls, minCount),
    ...abortedTurns(events, minCount),
  ];

  const kindPriority: Record<FrictionFinding["kind"], number> = {
    command_recovery: 0,
    repeated_file_read: 1,
    cross_project_command_failure: 2,
    repeated_command_failure: 3,
    repeated_command_loop: 4,
    aborted_turns: 5,
  };
  const actionPriority: Record<FrictionAction, number> = { propose: 0, investigate: 1, ignore: 2 };
  const severityPriority = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  findings.sort((a, b) =>
    actionPriority[a.action] - actionPriority[b.action] ||
    (b.proposalScore ?? 0) - (a.proposalScore ?? 0) ||
    severityPriority[a.severity] - severityPriority[b.severity] ||
    kindPriority[a.kind] - kindPriority[b.kind] ||
    b.occurrences - a.occurrences ||
    a.project.localeCompare(b.project),
  );

  const byKind: Record<string, number> = {};
  const byScope: Record<string, number> = {};
  for (const finding of findings) {
    byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
    byScope[finding.scope] = (byScope[finding.scope] ?? 0) + 1;
  }

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    inputFile,
    eventsRead: events.length,
    rolloutFiles: sourceFiles.size,
    logicalSessions: logicalSessions.size,
    projects: projects.size,
    toolCalls: events.filter((e) => e.type === "tool_call").length,
    commandCalls: calls.length,
    failedCommandCalls: calls.filter((c) => c.success === false).length,
    successfulCommandCalls: calls.filter((c) => c.success === true).length,
    unknownCommandResults: calls.filter((c) => c.success === undefined).length,
    findings,
    proposalCandidates: findings.filter((f) => f.action === "propose").length,
    investigationFindings: findings.filter((f) => f.action === "investigate").length,
    environmentFindings: findings.filter((f) => f.scope === "environment").length,
    workflowFindings: findings.filter((f) => f.scope === "workflow").length,
    byKind,
    byScope,
  };
}
