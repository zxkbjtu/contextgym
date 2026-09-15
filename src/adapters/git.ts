import path from "node:path";
import { findExistingFiles } from "../core/fs.js";
import { runText } from "../core/command.js";
import type { RepoDetection } from "../types.js";

const ROOT_INSTRUCTIONS = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  "GEMINI.md",
];

export function detectRepo(cwd: string): RepoDetection {
  const root = runText("git", ["rev-parse", "--show-toplevel"], cwd);
  if (!root) {
    return {
      isGitRepo: false,
      instructionFiles: findExistingFiles(cwd, ROOT_INSTRUCTIONS),
    };
  }

  const branch = runText("git", ["branch", "--show-current"], root);
  const remote = runText("git", ["remote", "get-url", "origin"], root);

  return {
    isGitRepo: true,
    root: path.normalize(root),
    branch,
    remote,
    instructionFiles: findExistingFiles(root, ROOT_INSTRUCTIONS),
  };
}
