import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// UXA-1a: every asset head names the asset, then says what it does, never its id. The render
// tests of the heads are beside their pages; this one holds every head the interface writes.

/** Every head of a chat-ui source file, as written: from its tag to its own closing line. */
function headsIn(source: string): string[] {
  const lines = source.split("\n");
  const heads: string[] = [];
  for (const [index, line] of lines.entries()) {
    const tag = /^(\s*)<(?:PageHeader|AppHeader)\b/u.exec(line);
    if (!tag) continue;
    const end = lines.findIndex((next, at) => at > index && next === `${tag[1]}/>`);
    heads.push(lines.slice(index, end === -1 ? index + 1 : end + 1).join("\n"));
  }
  return heads;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("the heads of asset pages", () => {
  it("is given no id as its line in any source file of the interface", () => {
    const heads = sourceFiles(join(import.meta.dirname, "../packages/chat-ui/src")).flatMap(
      (path) => headsIn(readFileSync(path, "utf8")).map((head) => ({ path, head }))
    );

    expect(heads.length).toBeGreaterThan(10);
    for (const { path, head } of heads) {
      const line = /description=\{([^}]*)\}/u.exec(head)?.[1] ?? "";
      expect(line, path).not.toMatch(/\.name$|\bname$|\bid$|Id$|<code/u);
    }
  });
});
