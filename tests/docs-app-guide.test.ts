import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compiledActionsOf } from "@work-shape/catalyst-app-build";
import { buildPage } from "@work-shape/catalyst-app-build/build";
import { pageFiles } from "./support/page-build";

// The docs page an agent reads before it writes an App's actions. Every example on it is built
// here as the build builds a saved Page: the code blocks with a `title` under one `##` heading
// are the files of one App, the title being the file's path. An example that does not build
// fails here, so the page cannot teach a manifest or an action file the build refuses.

const guide = fileURLToPath(
  new URL("../packages/docs/src/content/docs/apps/build.md", import.meta.url)
);

/**
 * The titled code blocks of the page, as files by path, per `##` section, and the untitled
 * blocks that show one action file on its own.
 */
function examplesOf(markdown: string): {
  examples: Map<string, Record<string, string>>;
  shownAlone: string[];
} {
  const examples = new Map<string, Record<string, string>>();
  const shownAlone: string[] = [];
  let section = "";
  let block: { title: string | undefined; lines: string[] } | undefined;
  for (const line of markdown.split("\n")) {
    if (block) {
      if (line.startsWith("```")) {
        const text = `${block.lines.join("\n")}\n`;
        if (block.title !== undefined) {
          const files = examples.get(section) ?? {};
          files[block.title] = text;
          examples.set(section, files);
        } else if (/^(connection|workflow):|^-- @param/u.test(text)) {
          shownAlone.push(text);
        }
        block = undefined;
      } else {
        block.lines.push(line);
      }
      continue;
    }
    if (line.startsWith("## ")) section = line.slice(3).trim();
    if (line.startsWith("```")) block = { title: /title="([^"]+)"/u.exec(line)?.[1], lines: [] };
  }
  return { examples, shownAlone };
}

describe("the docs page on building an App", () => {
  it("has examples that build, each with a manifest, and together every kind of action", async () => {
    const { examples, shownAlone } = examplesOf(await readFile(guide, "utf8"));
    expect(examples.size).toBeGreaterThanOrEqual(2);
    // An action file the page shows on its own is one the examples build.
    const built = [...examples.values()].flatMap((files) => Object.values(files));
    expect(shownAlone.length).toBeGreaterThanOrEqual(3);
    for (const text of shownAlone) expect(built).toContain(text);

    const kinds = new Set<string>();
    for (const [section, files] of examples) {
      expect(Object.keys(files), `the example under '${section}'`).toContain("app.yaml");
      const result = await buildPage({ files: pageFiles(files) });
      if (result.status !== "built") {
        throw new Error(
          `The example under '${section}' does not build: ${JSON.stringify(result.errors)}`
        );
      }
      for (const action of compiledActionsOf(result.manifest)) kinds.add(action.kind);
    }

    expect([...kinds].sort()).toEqual(["connection", "sql", "workflow"]);
  });
});
