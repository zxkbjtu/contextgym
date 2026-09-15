import fs from "node:fs";
import path from "node:path";

export function pathExists(target: string): boolean {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

export function countFilesRecursive(
  root: string,
  predicate: (filePath: string) => boolean,
  maxFiles = 100_000,
): number {
  if (!pathExists(root)) return 0;

  let count = 0;
  let visited = 0;
  const stack = [root];

  while (stack.length > 0 && visited < maxFiles) {
    const current = stack.pop()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      visited += 1;

      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        count += 1;
      }

      if (visited >= maxFiles) break;
    }
  }

  return count;
}

export function findExistingFiles(root: string, names: string[]): string[] {
  const found: string[] = [];
  for (const name of names) {
    const candidate = path.join(root, name);
    if (pathExists(candidate)) found.push(candidate);
  }
  return found;
}
