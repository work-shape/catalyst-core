import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { hash } from "./safety.mjs";

export function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10000
  }).trim();
}
export async function treeHash(root, roots) {
  const entries = [];
  async function walk(path) {
    const info = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of info.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) entries.push([relative(root, file), hash(await readFile(file))]);
    }
  }
  for (const path of roots) await walk(join(root, path));
  return hash(JSON.stringify(entries));
}
export async function sourceFingerprint(root) {
  const files = git(root, "ls-files", "-co", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean)
    .sort();
  const entries = [];
  for (const file of files) {
    if (file.startsWith(".env") || /(^|\/)\.env(?:\.|$)/u.test(file)) continue;
    entries.push([
      file,
      hash(await readFile(join(root, file)).catch(() => Buffer.from("[deleted]")))
    ]);
  }
  return { head: git(root, "rev-parse", "HEAD"), dirty: hash(JSON.stringify(entries)) };
}
