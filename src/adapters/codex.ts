import os from "node:os";
import path from "node:path";
import { countFilesRecursive, pathExists } from "../core/fs.js";
import type { HistoryDetection } from "../types.js";

export function detectCodexHistories(): HistoryDetection[] {
  const home = os.homedir();
  const sessionRoot = path.join(home, ".codex", "sessions");
  const archiveRoot = path.join(home, ".codex", "archived_sessions");
  const historyFile = path.join(home, ".codex", "history.jsonl");

  return [
    {
      name: "Codex rollout sessions",
      path: sessionRoot,
      exists: pathExists(sessionRoot),
      sessionCount: pathExists(sessionRoot)
        ? countFilesRecursive(sessionRoot, (file) =>
            path.basename(file).toLowerCase().startsWith("rollout-") &&
            file.toLowerCase().endsWith(".jsonl"),
          )
        : 0,
      notes: "Full rollout JSONL; primary source for future ContextGym mining.",
    },
    {
      name: "Codex archived sessions",
      path: archiveRoot,
      exists: pathExists(archiveRoot),
      sessionCount: pathExists(archiveRoot)
        ? countFilesRecursive(archiveRoot, (file) => file.toLowerCase().endsWith(".jsonl"))
        : 0,
      notes: "Archived rollout sessions, when present.",
    },
    {
      name: "Codex prompt history",
      path: historyFile,
      exists: pathExists(historyFile),
      sessionCount: pathExists(historyFile) ? 1 : 0,
      notes: "Global message history only; useful as a fallback, not the main trace source.",
    },
  ];
}
