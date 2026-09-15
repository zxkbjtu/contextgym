import os from "node:os";
import path from "node:path";
import { countFilesRecursive, pathExists } from "../core/fs.js";
import type { HistoryDetection } from "../types.js";

export function detectClaudeHistory(): HistoryDetection {
  const historyRoot = path.join(os.homedir(), ".claude", "projects");
  const exists = pathExists(historyRoot);
  const sessionCount = exists
    ? countFilesRecursive(historyRoot, (file) => file.toLowerCase().endsWith(".jsonl"))
    : 0;

  return {
    name: "Claude Code sessions",
    path: historyRoot,
    exists,
    sessionCount,
    notes: "Per-project JSONL transcripts; includes main sessions and may include subagent traces.",
  };
}
