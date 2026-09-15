export interface CliDetection {
  name: string;
  command: string;
  installed: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export interface HistoryDetection {
  name: string;
  path: string;
  exists: boolean;
  sessionCount: number;
  notes?: string;
}

export interface RepoDetection {
  isGitRepo: boolean;
  root?: string;
  branch?: string;
  remote?: string;
  instructionFiles: string[];
}

export interface DoctorReport {
  platform: string;
  nodeVersion: string;
  cwd: string;
  repo: RepoDetection;
  tools: CliDetection[];
  histories: HistoryDetection[];
}

export type AgentName = "codex" | "claude";

export type AgentEventType =
  | "session_start"
  | "turn_start"
  | "turn_end"
  | "message"
  | "tool_call"
  | "tool_result"
  | "file_edit"
  | "token_usage";

export interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

export interface AgentEvent {
  schemaVersion: 1;
  agent: AgentName;
  type: AgentEventType;
  timestamp?: string;
  sessionId: string;
  turnId?: string;
  cwd?: string;
  sourceFile: string;
  sourceLine: number;

  role?: "user" | "assistant" | "system" | "developer" | "unknown";
  text?: string;
  textLength?: number;
  textHash?: string;

  tool?: string;
  namespace?: string;
  callId?: string;
  command?: string;
  commands?: string[];
  workdir?: string;
  input?: string;
  inputLength?: number;

  success?: boolean;
  exitCode?: number;
  output?: string;
  outputLength?: number;

  files?: string[];
  usage?: TokenUsage;

  meta?: Record<string, unknown>;
}

export interface SessionMetaSummary {
  sessionId: string;
  cwd?: string;
  cliVersion?: string;
  source?: string;
  modelProvider?: string;
  gitBranch?: string;
  gitRepo?: string;
}

export interface SessionSchemaSummary {
  file: string;
  sizeBytes: number;
  modifiedAt: string;
  lines: number;
  parseErrors: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  envelopeTypes: Record<string, number>;
  payloadTypes: Record<string, number>;
  responseItemTypes: Record<string, number>;
  eventMsgTypes: Record<string, number>;
  meta?: SessionMetaSummary;
}

export interface SessionInspectReport {
  root: string;
  scannedFiles: number;
  totalLines: number;
  totalParseErrors: number;
  envelopeTypes: Record<string, number>;
  payloadTypes: Record<string, number>;
  responseItemTypes: Record<string, number>;
  eventMsgTypes: Record<string, number>;
  sessions: SessionSchemaSummary[];
}

export interface SessionParseSummary {
  inputRoot: string;
  filesParsed: number;
  linesRead: number;
  parseErrors: number;
  eventsWritten: number;
  eventTypes: Record<string, number>;
  sessions: number;
  outputFile: string;
  includeText: boolean;
}

export type FrictionKind =
  | "cross_project_command_failure"
  | "repeated_command_failure"
  | "command_recovery"
  | "repeated_command_loop"
  | "repeated_file_read"
  | "aborted_turns";

export type FrictionScope = "repository" | "environment" | "workflow" | "investigate";
export type FrictionAction = "propose" | "investigate" | "ignore";
export type EvidenceLevel = "weak" | "moderate" | "strong";

export interface FrictionFinding {
  id: string;
  kind: FrictionKind;
  severity: "low" | "medium" | "high" | "critical";
  confidence: number;
  project: string;
  title: string;
  summary: string;
  command?: string;
  recoveryCommand?: string;
  file?: string;
  category?: string;
  occurrences: number;
  sessions: number;
  turns: number;
  avoidableToolCalls: number;
  scope: FrictionScope;
  action: FrictionAction;
  evidenceLevel: EvidenceLevel;
  proposalScore?: number;
  projectsAffected?: number;
  suggestion?: string;
}

export interface MineReport {
  schemaVersion: 2;
  generatedAt: string;
  inputFile: string;
  eventsRead: number;
  rolloutFiles: number;
  logicalSessions: number;
  projects: number;
  toolCalls: number;
  commandCalls: number;
  failedCommandCalls: number;
  successfulCommandCalls: number;
  unknownCommandResults: number;
  findings: FrictionFinding[];
  proposalCandidates: number;
  investigationFindings: number;
  environmentFindings: number;
  workflowFindings: number;
  byKind: Record<string, number>;
  byScope: Record<string, number>;
}


export type ProposalKind = "repository_map" | "command_rule";

export interface ContextProposal {
  id: string;
  sourceFindingId: string;
  kind: ProposalKind;
  project: string;
  score: number;
  title: string;
  rationale: string;
  markdown: string;
  estimatedTokens: number;
  avoidableToolCalls: number;
  file?: string;
  relativePath?: string;
  command?: string;
  recoveryCommand?: string;
  inspected: boolean;
  inspectionNotes?: string[];
}

export interface ProjectProposalDraft {
  project: string;
  file: string;
  proposals: number;
  estimatedTokens: number;
  avoidableToolCalls: number;
  markdown: string;
}

export interface ProposalReport {
  schemaVersion: 1;
  generatedAt: string;
  inputFile: string;
  findingsRead: number;
  eligibleFindings: number;
  skippedFindings: number;
  minScore: number;
  proposals: ContextProposal[];
  projects: ProjectProposalDraft[];
  skipped: Array<{ findingId: string; project: string; reason: string }>;
}

export interface EvalUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export type EvalVariant = "baseline" | "candidate";

export interface EvalRunResult {
  run: number;
  variant: EvalVariant;
  order: number;
  cwd: string;
  codexExitCode: number | null;
  completed: boolean;
  failed: boolean;
  durationMs: number;
  usage: EvalUsage;
  observedToolCalls: number;
  observedItemTypes: Record<string, number>;
  changedFiles: number;
  changedFileList: string[];
  verifierConfigured: boolean;
  verifierExitCode?: number | null;
  verifierPassed?: boolean;
  verifierDurationMs?: number;
  verifierStdoutTail?: string;
  verifierStderrTail?: string;
  success: boolean;
  successBasis: "verifier" | "agent_completion";
  stderrLines: number;
}

export interface EvalVariantSummary {
  variant: EvalVariant;
  runs: number;
  successes: number;
  successRate: number;
  meanTotalTokens: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanObservedToolCalls: number;
  meanDurationMs: number;
  meanChangedFiles: number;
}

export type EvalVerdict =
  | "SMOKE_ONLY"
  | "KEEP_SUCCESS"
  | "KEEP_EFFICIENCY"
  | "REJECT_REGRESSION"
  | "REJECT_EFFICIENCY"
  | "INCONCLUSIVE";

export interface ContextRoi {
  eligiblePairs: number;
  proposalTokens: number;
  meanTokensSaved: number;
  meanObservedToolCallsSaved: number;
  meanDurationMsSaved: number;
  tokenSavingsPerContextToken?: number;
  observedToolCallsSavedPer100ContextTokens?: number;
  pairedTokenWins: number;
  pairedObservedToolWins: number;
  pairedDurationWins: number;
  successNonRegression: boolean;
}

export interface EvalReport {
  schemaVersion: 1 | 2;
  generatedAt: string;
  id: string;
  project: string;
  gitHead: string;
  proposalFile: string;
  proposalBytes: number;
  estimatedProposalTokens: number;
  taskSource: string;
  taskHash: string;
  taskLength: number;
  verifierConfigured: boolean;
  verifier?: string;
  verifierSource?: string;
  verifierHash?: string;
  runsRequested: number;
  model?: string;
  sandbox: string;
  observedToolCallsComplete: boolean;
  observedToolCallsNote: string;
  dryRun: boolean;
  results: EvalRunResult[];
  baseline?: EvalVariantSummary;
  candidate?: EvalVariantSummary;
  delta?: {
    successRate: number;
    meanTotalTokensPct?: number;
    meanObservedToolCallsPct?: number;
    meanDurationPct?: number;
  };
  roi?: ContextRoi;
  verdict: EvalVerdict;
  verdictReason: string;
  outputFile: string;
}


export interface ContextProbe {
  id: string;
  project: string;
  proposalId: string;
  proposalFile: string;
  targetRelativePath: string;
  role: string;
  score: number;
  estimatedProposalTokens: number;
  answerFile: string;
  taskFile: string;
  verifierFile: string;
}

export interface ProbeReport {
  schemaVersion: 1;
  generatedAt: string;
  project: string;
  proposalReportFile: string;
  probes: ContextProbe[];
  outputFile: string;
}
