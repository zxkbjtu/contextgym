import { spawnSync } from "node:child_process";
import path from "node:path";
import type { CliDetection } from "../types.js";

function locatorCommand(): { command: string; args: (name: string) => string[] } {
  if (process.platform === "win32") {
    return { command: "where.exe", args: (name) => [name] };
  }
  return { command: "which", args: (name) => [name] };
}

export function locateExecutable(name: string): string | undefined {
  const locator = locatorCommand();
  const result = spawnSync(locator.command, locator.args(name), {
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.status !== 0 || !result.stdout) return undefined;

  const first = result.stdout
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .find(Boolean);

  return first ? path.normalize(first) : undefined;
}

export function getCommandVersion(command: string): string | undefined {
  const attempts = [["--version"], ["-V"], ["version"]];

  for (const args of attempts) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 4000,
    });

    if (result.status === 0) {
      const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      const line = text.split(/\r?\n/).map((v) => v.trim()).find(Boolean);
      if (line) return line;
    }
  }

  return undefined;
}

export function detectCli(name: string, command = name): CliDetection {
  try {
    const executablePath = locateExecutable(command);
    if (!executablePath) {
      return { name, command, installed: false };
    }

    return {
      name,
      command,
      installed: true,
      path: executablePath,
      version: getCommandVersion(command),
    };
  } catch (error) {
    return {
      name,
      command,
      installed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function runText(command: string, args: string[], cwd?: string): string | undefined {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });

  if (result.status !== 0) return undefined;
  const text = result.stdout?.trim();
  return text || undefined;
}
