import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compiledActionsOf } from "@work-shape/catalyst-app-build";
import { buildPage } from "@work-shape/catalyst-app-build/build";
import { THEME_TOKEN_NAMES } from "@work-shape/catalyst-ui/theme";
import { pageFiles } from "./support/page-build";

// The docs pages an agent reads before it writes an App's actions, one per task. Every example
// on them is built here as the build builds a saved Page: the code blocks with a `title` under
// one `##` heading of one page are the files of one App, the title being the file's path. An
// example that does not build fails here, so no page can teach a manifest or an action file the
// build refuses.

const guideDirectory = fileURLToPath(
  new URL("../packages/docs/src/content/docs/apps/", import.meta.url)
);

/** Every page of the App guide, one after another, each section named by its page. */
async function guidePages(): Promise<string> {
  const pages = (await readdir(guideDirectory)).filter((name) => name.endsWith(".md")).sort();
  const texts = await Promise.all(
    pages.map(async (name) =>
      (await readFile(`${guideDirectory}${name}`, "utf8")).replaceAll(/^## /gmu, `## ${name}: `)
    )
  );
  return texts.join("\n");
}

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

describe("the docs pages on building an App", () => {
  it("has examples that build, each with a manifest, and together every kind of action", async () => {
    const { examples, shownAlone } = examplesOf(await guidePages());
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

  it("names only theme variables the kit keeps on a page, and Workshaper builds from them", async () => {
    // APP-THEME-1: an App follows light and dark when its own rules read these variables.
    const sandbox = await readFile(`${guideDirectory}sandbox.md`, "utf8");
    const section = sandbox.slice(
      sandbox.indexOf("## Light and dark"),
      sandbox.indexOf("## Fonts and libraries")
    );
    const named = new Set(
      [...section.matchAll(/`(--[a-z-]+)`|var\((--[a-z-]+)\)/gu)].map(
        (match) => match[1] ?? match[2] ?? ""
      )
    );
    expect(named.size).toBeGreaterThan(8);
    const kept = new Set<string>(THEME_TOKEN_NAMES);
    expect([...named].filter((name) => !kept.has(name))).toEqual([]);
    const workshaper = await readFile(
      new URL("../packages/client-assembly/src/workshaper.ts", import.meta.url),
      "utf8"
    );
    const guided = [...workshaper.matchAll(/var\((--[a-z-]+)\)/gu)].map((match) => match[1]);
    expect(guided).toContain("--background");
    expect(guided.filter((name) => name === undefined || !kept.has(name))).toEqual([]);
  });
});
