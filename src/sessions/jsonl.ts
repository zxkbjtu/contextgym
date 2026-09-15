import fs from "node:fs";
import readline from "node:readline";

export interface JsonlRecord {
  line: number;
  raw: string;
  value?: Record<string, unknown>;
  error?: string;
}

export async function* readJsonl(file: string): AsyncGenerator<JsonlRecord> {
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNo = 0;

  for await (let line of rl) {
    lineNo += 1;
    if (lineNo === 1 && line.charCodeAt(0) === 0xfeff) {
      line = line.slice(1);
    }
    if (!line.trim()) continue;

    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        yield { line: lineNo, raw: line, value: value as Record<string, unknown> };
      } else {
        yield { line: lineNo, raw: line, error: "JSON value is not an object" };
      }
    } catch (error) {
      yield {
        line: lineNo,
        raw: line,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
