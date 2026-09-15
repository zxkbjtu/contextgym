import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RolloutFile {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

export function codexSessionRoot(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

export function listCodexRollouts(root = codexSessionRoot(), limit?: number): RolloutFile[] {
  if (!fs.existsSync(root)) return [];

  const out: RolloutFile[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (!lower.startsWith("rollout-") || !lower.endsWith(".jsonl")) continue;

      try {
        const stat = fs.statSync(full);
        out.push({ path: full, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore files racing with Codex writes/deletes.
      }
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return typeof limit === "number" ? out.slice(0, Math.max(0, limit)) : out;
}

export function compactHome(input: string): string {
  const home = os.homedir();
  if (input === home) return "~";
  if (input.startsWith(home + path.sep)) return `~${input.slice(home.length)}`;
  return input;
}
