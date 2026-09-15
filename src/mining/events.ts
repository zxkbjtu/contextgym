import fs from "node:fs";
import readline from "node:readline";
import type { AgentEvent } from "../types.js";

export interface EventReadResult {
  events: AgentEvent[];
  lines: number;
  parseErrors: number;
}

export async function readAgentEvents(file: string): Promise<EventReadResult> {
  if (!fs.existsSync(file)) {
    throw new Error(`Event file not found: ${file}. Run \`contextgym sessions parse\` first.`);
  }

  const input = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const events: AgentEvent[] = [];
  let lines = 0;
  let parseErrors = 0;

  for await (let line of rl) {
    lines += 1;
    if (lines === 1 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as AgentEvent;
      if (value && typeof value === "object" && typeof value.type === "string" && typeof value.sessionId === "string") {
        events.push(value);
      } else {
        parseErrors += 1;
      }
    } catch {
      parseErrors += 1;
    }
  }

  return { events, lines, parseErrors };
}
