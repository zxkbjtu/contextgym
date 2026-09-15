import crypto from "node:crypto";
import path from "node:path";
import { readJsonl } from "./jsonl.js";
import type {
  AgentEvent,
  SessionMetaSummary,
  SessionParseSummary,
  SessionSchemaSummary,
  TokenUsage,
} from "../types.js";

interface ParseOptions {
  includeText: boolean;
}

interface ParsedFile {
  events: AgentEvent[];
  summary: SessionSchemaSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bump(target: Record<string, number>, key: string | undefined): void {
  if (!key) return;
  target[key] = (target[key] ?? 0) + 1;
}

function stableHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function textFields(text: string | undefined, includeText: boolean): Partial<AgentEvent> {
  if (text === undefined) return {};
  return {
    ...(includeText ? { text } : {}),
    textLength: text.length,
    textHash: stableHash(text),
  };
}

function stringifyLoose(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractMessageText(payload: Record<string, unknown>): string | undefined {
  const content = payload.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return asString(payload.text);

  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const text = asString(item.text) ?? asString(item.input_text) ?? asString(item.output_text);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function normalizeRole(value: unknown): AgentEvent["role"] {
  if (value === "user" || value === "assistant" || value === "system" || value === "developer") {
    return value;
  }
  return "unknown";
}

function decodeQuotedJsString(quote: string, body: string): string {
  if (quote === '"') {
    try {
      return JSON.parse(`"${body}"`) as string;
    } catch {
      return body;
    }
  }
  return body
    .replace(/\\'/g, "'")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

function extractNestedCodeModeCommands(rawInput: string): string[] {
  const commands: string[] = [];
  const re = /(?:exec_command|shell_command)\s*\(\s*\{[\s\S]*?(?:cmd|command)\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  for (const match of rawInput.matchAll(re)) {
    const quote = match[1];
    const body = match[2];
    if (quote && body !== undefined) commands.push(decodeQuotedJsString(quote, body));
  }
  return [...new Set(commands)];
}

function extractCommand(tool: string | undefined, rawInput: string | undefined): { command?: string; commands?: string[]; workdir?: string } {
  if (!tool || !rawInput) return {};
  const normalized = tool.toLowerCase();
  const commandLike = ["exec_command", "shell_command", "shell", "terminal", "run_command"];

  if (commandLike.some((name) => normalized === name || normalized.endsWith(`.${name}`))) {
    const args = parseJsonObject(rawInput);
    if (!args) return {};

    const candidate = args.command ?? args.cmd;
    let command: string | undefined;
    if (typeof candidate === "string") command = candidate;
    if (Array.isArray(candidate) && candidate.every((v) => typeof v === "string")) {
      command = candidate.join(" ");
    }
    const workdir = asString(args.workdir) ?? asString(args.cwd) ?? asString(args.working_directory);
    return { command, commands: command ? [command] : undefined, workdir };
  }

  // Newer Codex code-mode stores one outer custom `exec` call whose input is source code.
  // Inner exec_command/shell_command calls are not separate rollout items, so recover them
  // conservatively from the source without evaluating it.
  if (normalized === "exec" || normalized.endsWith(".exec")) {
    const commands = extractNestedCodeModeCommands(rawInput);
    return { command: commands[0], commands: commands.length > 0 ? commands : undefined };
  }

  return {};
}

function extractPatchFiles(tool: string | undefined, rawInput: string | undefined): string[] {
  if (!rawInput) return [];
  const normalized = tool?.toLowerCase() ?? "";
  if (!normalized.includes("apply_patch") && !rawInput.includes("*** Begin Patch")) return [];
  const files: string[] = [];
  const re = /^\*\*\*\s+(?:Add|Update|Delete) File:\s*(.+?)\s*$/gm;
  for (const match of rawInput.matchAll(re)) {
    const file = match[1]?.trim();
    if (file) files.push(file);
  }
  return [...new Set(files)];
}

function outputInfo(value: unknown): { text?: string; exitCode?: number; success?: boolean } {
  if (typeof value === "string") {
    const exitMatch = value.match(/(?:process exited with code|exit code|exit_code)[^0-9-]*(-?\d+)/i);
    const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
    const obviousFailure = /failed to parse|\berror\b|command failed|traceback/i.test(value);
    return {
      text: value,
      exitCode,
      success: exitCode !== undefined ? exitCode === 0 : obviousFailure ? false : undefined,
    };
  }

  if (isRecord(value)) {
    const exitCode =
      asNumber(value.exit_code) ?? asNumber(value.exitCode) ?? asNumber(value.code) ??
      (isRecord(value.metadata) ? asNumber(value.metadata.exit_code) : undefined);
    const successValue = value.success;
    const text =
      asString(value.output) ??
      asString(value.stdout) ??
      asString(value.text) ??
      asString(value.content) ??
      stringifyLoose(value);
    return {
      text,
      exitCode,
      success: typeof successValue === "boolean" ? successValue : exitCode !== undefined ? exitCode === 0 : undefined,
    };
  }

  if (Array.isArray(value)) {
    const textParts: string[] = [];
    let exitCode: number | undefined;
    let success: boolean | undefined;
    for (const item of value) {
      if (isRecord(item)) {
        const text = asString(item.text) ?? asString(item.output) ?? stringifyLoose(item);
        if (text) textParts.push(text);
        const nested = outputInfo(asString(item.text) ?? item.output ?? item);
        if (nested.exitCode !== undefined) exitCode = nested.exitCode;
        if (nested.success !== undefined) success = nested.success;
      } else {
        const text = stringifyLoose(item);
        if (text) textParts.push(text);
      }
    }
    return {
      text: textParts.length > 0 ? textParts.join("\n") : stringifyLoose(value),
      exitCode,
      success: exitCode !== undefined ? exitCode === 0 : success,
    };
  }

  return {};
}

function parseUsage(payload: Record<string, unknown>): TokenUsage | undefined {
  const info = isRecord(payload.info) ? payload.info : undefined;
  const usage =
    (info && isRecord(info.last_token_usage) ? info.last_token_usage : undefined) ??
    (info && isRecord(info.total_token_usage) ? info.total_token_usage : undefined) ??
    (isRecord(payload.usage) ? payload.usage : undefined);
  if (!usage) return undefined;

  const out: TokenUsage = {
    inputTokens: asNumber(usage.input_tokens),
    cachedInputTokens: asNumber(usage.cached_input_tokens),
    cacheWriteInputTokens: asNumber(usage.cache_write_input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    reasoningOutputTokens: asNumber(usage.reasoning_output_tokens),
    totalTokens: asNumber(usage.total_tokens),
  };

  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

function sessionIdFromFilename(file: string): string {
  const base = path.basename(file, ".jsonl");
  const uuid = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[^.]+)?$/i);
  return uuid?.[1] ?? base;
}

function parseMeta(payload: Record<string, unknown>, fallbackId: string): SessionMetaSummary {
  const meta = isRecord(payload.meta) ? payload.meta : payload;
  const git = isRecord(payload.git) ? payload.git : undefined;
  return {
    sessionId: asString(meta.id) ?? asString(meta.session_id) ?? fallbackId,
    cwd: asString(meta.cwd),
    cliVersion: asString(meta.cli_version),
    source: stringifyLoose(meta.source),
    modelProvider: asString(meta.model_provider),
    gitBranch: git ? asString(git.branch) : undefined,
    gitRepo: git ? asString(git.repository_url) ?? asString(git.repo_url) : undefined,
  };
}

function baseEvent(
  file: string,
  line: number,
  sessionId: string,
  timestamp: string | undefined,
  cwd: string | undefined,
): Pick<AgentEvent, "schemaVersion" | "agent" | "sourceFile" | "sourceLine" | "sessionId" | "timestamp" | "cwd"> {
  return {
    schemaVersion: 1,
    agent: "codex",
    sourceFile: file,
    sourceLine: line,
    sessionId,
    timestamp,
    cwd,
  };
}

export async function parseCodexRollout(file: string, options: ParseOptions): Promise<ParsedFile> {
  const stat = await import("node:fs/promises").then((m) => m.stat(file));
  const envelopeTypes: Record<string, number> = {};
  const payloadTypes: Record<string, number> = {};
  const responseItemTypes: Record<string, number> = {};
  const eventMsgTypes: Record<string, number> = {};
  const events: AgentEvent[] = [];

  let lines = 0;
  let parseErrors = 0;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let sessionId = sessionIdFromFilename(file);
  let cwd: string | undefined;
  let metaSummary: SessionMetaSummary | undefined;
  let currentTurnId: string | undefined;

  for await (const record of readJsonl(file)) {
    lines += 1;
    if (!record.value) {
      parseErrors += 1;
      continue;
    }

    const row = record.value;
    const timestamp = asString(row.timestamp);
    if (timestamp && !firstTimestamp) firstTimestamp = timestamp;
    if (timestamp) lastTimestamp = timestamp;

    const envelopeType = asString(row.type) ?? "unknown";
    bump(envelopeTypes, envelopeType);

    // Current rollouts use an envelope {type, payload}; older ones can be raw response items.
    const envelopePayload = isRecord(row.payload) ? row.payload : undefined;
    const payload = envelopePayload ?? row;
    const payloadType = asString(payload.type);
    bump(payloadTypes, payloadType);

    if (envelopeType === "session_meta") {
      metaSummary = parseMeta(payload, sessionId);
      sessionId = metaSummary.sessionId;
      cwd = metaSummary.cwd;
      events.push({
        ...baseEvent(file, record.line, sessionId, timestamp, cwd),
        type: "session_start",
        meta: {
          cliVersion: metaSummary.cliVersion,
          source: metaSummary.source,
          modelProvider: metaSummary.modelProvider,
          gitBranch: metaSummary.gitBranch,
          gitRepo: metaSummary.gitRepo,
        },
      });
      continue;
    }

    if (envelopeType === "turn_context") {
      currentTurnId = asString(payload.turn_id) ?? currentTurnId;
      cwd = asString(payload.cwd) ?? cwd;
      continue;
    }

    const isResponseItemEnvelope = envelopeType === "response_item";
    const isRawResponseItem = [
      "message",
      "function_call",
      "function_call_output",
      "custom_tool_call",
      "custom_tool_call_output",
      "web_search_call",
      "local_shell_call",
      "local_shell_call_output",
      "shell_call",
      "shell_call_output",
      "apply_patch_call",
      "apply_patch_call_output",
    ].includes(envelopeType);

    if (isResponseItemEnvelope || isRawResponseItem) {
      const item = isResponseItemEnvelope ? payload : row;
      const itemType = asString(item.type) ?? envelopeType;
      bump(responseItemTypes, itemType);

      if (itemType === "message") {
        const text = extractMessageText(item);
        events.push({
          ...baseEvent(file, record.line, sessionId, timestamp, cwd),
          type: "message",
          turnId: currentTurnId,
          role: normalizeRole(item.role),
          ...textFields(text, options.includeText),
        });
        continue;
      }

      if (itemType === "function_call" || itemType === "custom_tool_call") {
        const tool = asString(item.name) ?? "unknown_tool";
        const rawInput = asString(item.arguments) ?? asString(item.input) ?? stringifyLoose(item.arguments ?? item.input);
        const command = extractCommand(tool, rawInput);
        const files = extractPatchFiles(tool, rawInput);
        const callId = asString(item.call_id) ?? asString(item.id);

        events.push({
          ...baseEvent(file, record.line, sessionId, timestamp, cwd),
          type: "tool_call",
          turnId: currentTurnId,
          tool,
          namespace: asString(item.namespace),
          callId,
          command: command.command,
          commands: command.commands,
          workdir: command.workdir,
          ...(options.includeText && rawInput ? { input: rawInput } : {}),
          inputLength: rawInput?.length,
        });

        if (files.length > 0) {
          events.push({
            ...baseEvent(file, record.line, sessionId, timestamp, cwd),
            type: "file_edit",
            turnId: currentTurnId,
            tool,
            callId,
            files,
          });
        }
        continue;
      }

      if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
        const output = outputInfo(item.output);
        events.push({
          ...baseEvent(file, record.line, sessionId, timestamp, cwd),
          type: "tool_result",
          turnId: currentTurnId,
          callId: asString(item.call_id) ?? asString(item.id),
          tool: asString(item.name),
          namespace: asString(item.namespace),
          success: output.success,
          exitCode: output.exitCode,
          ...(options.includeText && output.text ? { output: output.text } : {}),
          outputLength: output.text?.length,
        });
        continue;
      }

      if (itemType === "local_shell_call" || itemType === "shell_call") {
        const action = isRecord(item.action) ? item.action : item;
        const candidate = action.command ?? action.cmd;
        const command = typeof candidate === "string"
          ? candidate
          : Array.isArray(candidate) && candidate.every((v) => typeof v === "string")
            ? candidate.join(" ")
            : undefined;
        events.push({
          ...baseEvent(file, record.line, sessionId, timestamp, cwd),
          type: "tool_call",
          turnId: currentTurnId,
          tool: "shell",
          callId: asString(item.call_id) ?? asString(item.id),
          command,
          commands: command ? [command] : undefined,
          workdir: asString(action.working_directory) ?? asString(action.workdir) ?? asString(action.cwd),
        });
        continue;
      }

      if (itemType === "local_shell_call_output" || itemType === "shell_call_output") {
        const output = outputInfo(item.output ?? item);
        events.push({
          ...baseEvent(file, record.line, sessionId, timestamp, cwd),
          type: "tool_result",
          turnId: currentTurnId,
          tool: "shell",
          callId: asString(item.call_id) ?? asString(item.id),
          success: output.success,
          exitCode: output.exitCode,
          ...(options.includeText && output.text ? { output: output.text } : {}),
          outputLength: output.text?.length,
        });
        continue;
      }

      if (itemType === "apply_patch_call") {
        const patch = asString(item.diff) ?? stringifyLoose(item.input) ?? stringifyLoose(item.operation);
        const explicitPath = asString(item.path);
        const files = [...new Set([...(explicitPath ? [explicitPath] : []), ...extractPatchFiles("apply_patch", patch)])];
        const callId = asString(item.call_id) ?? asString(item.id);
        events.push({
          ...baseEvent(file, record.line, sessionId, timestamp, cwd),
          type: "tool_call",
          turnId: currentTurnId,
          tool: "apply_patch",
          callId,
          ...(options.includeText && patch ? { input: patch } : {}),
          inputLength: patch?.length,
        });
        if (files.length > 0) {
          events.push({
            ...baseEvent(file, record.line, sessionId, timestamp, cwd),
            type: "file_edit",
            turnId: currentTurnId,
            tool: "apply_patch",
            callId,
            files,
          });
        }
        continue;
      }

      if (itemType === "apply_patch_call_output") {
        const output = outputInfo(item.output ?? item);
        events.push({
          ...baseEvent(file, record.line, sessionId, timestamp, cwd),
          type: "tool_result",
          turnId: currentTurnId,
          tool: "apply_patch",
          callId: asString(item.call_id) ?? asString(item.id),
          success: output.success,
          exitCode: output.exitCode,
          ...(options.includeText && output.text ? { output: output.text } : {}),
          outputLength: output.text?.length,
        });
        continue;
      }

      if (itemType === "web_search_call") {
        events.push({
          ...baseEvent(file, record.line, sessionId, timestamp, cwd),
          type: "tool_call",
          turnId: currentTurnId,
          tool: "web_search",
          callId: asString(item.call_id) ?? asString(item.id),
        });
        continue;
      }
    }

    if (envelopeType === "event_msg") {
      const eventType = payloadType ?? "unknown";
      bump(eventMsgTypes, eventType);

      if (eventType === "task_started") {
        currentTurnId = asString(payload.turn_id) ?? currentTurnId;
        events.push({
          ...baseEvent(file, record.line, sessionId, timestamp, cwd),
          type: "turn_start",
          turnId: currentTurnId,
        });
        continue;
      }

      if (eventType === "task_complete") {
        events.push({
          ...baseEvent(file, record.line, sessionId, timestamp, cwd),
          type: "turn_end",
          turnId: asString(payload.turn_id) ?? currentTurnId,
          success: true,
        });
        continue;
      }

      if (eventType === "turn_aborted") {
        events.push({
          ...baseEvent(file, record.line, sessionId, timestamp, cwd),
          type: "turn_end",
          turnId: asString(payload.turn_id) ?? currentTurnId,
          success: false,
          meta: { reason: stringifyLoose(payload.reason) ?? stringifyLoose(payload.message) ?? "aborted" },
        });
        continue;
      }

      if (eventType === "token_count") {
        const usage = parseUsage(payload);
        if (usage) {
          events.push({
            ...baseEvent(file, record.line, sessionId, timestamp, cwd),
            type: "token_usage",
            turnId: currentTurnId,
            usage,
          });
        }
        continue;
      }
    }
  }

  return {
    events,
    summary: {
      file,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      lines,
      parseErrors,
      firstTimestamp,
      lastTimestamp,
      envelopeTypes,
      payloadTypes,
      responseItemTypes,
      eventMsgTypes,
      meta: metaSummary,
    },
  };
}

export function makeParseSummary(
  inputRoot: string,
  filesParsed: number,
  linesRead: number,
  parseErrors: number,
  eventsWritten: number,
  eventTypes: Record<string, number>,
  sessions: number,
  outputFile: string,
  includeText: boolean,
): SessionParseSummary {
  return {
    inputRoot,
    filesParsed,
    linesRead,
    parseErrors,
    eventsWritten,
    eventTypes,
    sessions,
    outputFile,
    includeText,
  };
}
