import path from "node:path";

export type CommandCategory = "test" | "lint" | "build" | "install" | "git" | "read" | "search" | "run" | "other";

export function redactCommand(input: string): string {
  let out = input;

  out = out.replace(/((?:--?(?:api[-_]?key|token|password|passwd|secret|authorization)|(?:api[-_]?key|token|password|passwd|secret)\s*=)\s*[=:]?\s*)(["']?)[^\s"']+\2/gi, "$1<redacted>");
  out = out.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY))\s*=\s*([^\s;]+)/gi, "$1=<redacted>");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer <redacted>");
  out = out.replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{16,}\b/g, "<redacted-secret>");
  return out;
}

export function normalizeCommand(input: string): string {
  return redactCommand(input)
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[;&]+\s*$/, "")
    .toLowerCase();
}

export function displayCommand(input: string, max = 180): string {
  const value = redactCommand(input).replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function commandCategory(input: string): CommandCategory {
  const c = normalizeCommand(input);
  if (/(^|\s)(pytest|py\.test|jest|vitest|ctest)(\s|$)|\b(npm|pnpm|yarn)\s+(run\s+)?test\b|\bmvn\s+test\b|\bgradle\w*\s+.*test\b/.test(c)) return "test";
  if (/\b(eslint|ruff|flake8|mypy|pylint)\b|\b(npm|pnpm|yarn)\s+(run\s+)?lint\b|\bprettier\b.*--check/.test(c)) return "lint";
  if (/\b(npm|pnpm|yarn)\s+(run\s+)?build\b|(^|\s)tsc(\s|$)|\bcargo\s+build\b|\bmvn\s+(package|compile)\b|\bcmake\s+--build\b|\blatexmk\b/.test(c)) return "build";
  if (/\b(npm|pnpm|yarn)\s+(i|install|add)\b|\bpip(3)?\s+install\b|\buv\s+pip\b|\bconda\s+install\b/.test(c)) return "install";
  if (/^git\s+/.test(c)) return "git";
  if (/\b(get-content|gc|cat|type|head|tail)\b/.test(c) || /\bsed\s+-n\b/.test(c)) return "read";
  if (/\b(rg|grep|findstr|select-string)\b/.test(c)) return "search";
  if (/^(python|python3|py|node|deno|bun|java|dotnet|cargo\s+run)\b/.test(c)) return "run";
  return "other";
}

function unquote(value: string): string {
  const s = value.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s.replace(/^["']+|["']+$/g, "");
}

function tokenize(segment: string): string[] {
  return [...segment.matchAll(/"[^"]*"|'[^']*'|[^\s]+/g)].map((m) => m[0]!);
}

function looksLikeFileToken(value: string): boolean {
  const v = unquote(value).replace(/[;,|]+$/, "").trim();
  if (!v || v.startsWith("-") || v.includes("$") || v.includes("`")) return false;
  if (/^(null|nul|stdin|stdout|stderr)$/i.test(v)) return false;
  if (/^\d+$/.test(v)) return false;
  if (/^[A-Za-z]+-[A-Za-z][A-Za-z0-9-]*$/.test(v) && !/[\\/]/.test(v)) return false;
  if (/[\\/]/.test(v)) return true;
  if (/\.[A-Za-z0-9][A-Za-z0-9._-]{0,12}$/.test(v)) return true;
  if (/^(readme|license|makefile|dockerfile|agents\.md|claude\.md|gemini\.md)$/i.test(v)) return true;
  return false;
}

function pushPath(found: string[], token: string | undefined, cwd?: string): void {
  if (!token || !looksLikeFileToken(token)) return;
  const v = unquote(token).replace(/[;,|]+$/, "").trim();
  const winAbs = /^[A-Za-z]:[\\/]/.test(v) || /^\\\\/.test(v);
  const posixAbs = path.posix.isAbsolute(v) && !winAbs;
  const cwdIsWin = cwd ? (/^[A-Za-z]:[\\/]/.test(cwd) || /^\\\\/.test(cwd)) : false;
  const absolute = winAbs
    ? path.win32.normalize(v)
    : posixAbs
      ? path.posix.normalize(v)
      : cwd && cwdIsWin
        ? path.win32.resolve(cwd, v)
        : cwd && !path.isAbsolute(v)
          ? path.resolve(cwd, v)
          : v;
  found.push(absolute);
}

function parseGetContent(segment: string, cwd?: string): string[] {
  const found: string[] = [];
  const explicit = segment.match(/-(?:LiteralPath|Path)\s+("[^"]+"|'[^']+'|[^\s;|]+)/i);
  if (explicit?.[1]) {
    pushPath(found, explicit[1], cwd);
    return found;
  }

  const tokens = tokenize(segment);
  const valueOptions = new Set(["-encoding", "-readcount", "-totalcount", "-tail", "-delimiter", "-filter", "-include", "-exclude"]);
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith("-")) {
      if (valueOptions.has(token.toLowerCase())) i += 1;
      continue;
    }
    if (looksLikeFileToken(token)) {
      pushPath(found, token, cwd);
      break;
    }
  }
  return found;
}

function parseUnixRead(segment: string, cwd?: string): string[] {
  const found: string[] = [];
  const tokens = tokenize(segment);
  if (tokens.length < 2) return found;
  const cmd = unquote(tokens[0]!).toLowerCase().replace(/^.*[\\/]/, "");
  const valueOptions = cmd === "head" || cmd === "tail"
    ? new Set(["-n", "--lines", "-c", "--bytes"])
    : new Set<string>();

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith("-")) {
      const lower = token.toLowerCase();
      if (valueOptions.has(lower)) i += 1;
      continue;
    }
    if (looksLikeFileToken(token)) pushPath(found, token, cwd);
  }
  return found;
}

export function inferReadPaths(command: string, cwd?: string): string[] {
  const text = command.replace(/\r?\n/g, " ");
  const found: string[] = [];

  for (const match of text.matchAll(/\bGet-Content\b[^|;&]*/gi)) {
    found.push(...parseGetContent(match[0], cwd));
  }

  for (const match of text.matchAll(/(?:^|[;&|]\s*)\b(?:cat|type|head|tail)\b[^|;&]*/gi)) {
    const segment = match[0]!.replace(/^[;&|]\s*/, "");
    found.push(...parseUnixRead(segment, cwd));
  }

  for (const match of text.matchAll(/\bsed\s+-n\s+(?:"[^"]+"|'[^']+'|[^\s]+)\s+("[^"]+"|'[^']+'|[^\s|;]+)/gi)) {
    pushPath(found, match[1], cwd);
  }

  return [...new Set(found)];
}
