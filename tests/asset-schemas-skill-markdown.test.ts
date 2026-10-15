import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseSkillMarkdown, SkillMarkdownError } from "@work-shape/catalyst-asset-schemas";
import { describe, expect, it } from "vitest";

const unnamed = "---\ntitle: Tax review\ndescription: Reviews a tax file.\n---\nRead the file.";

function nameFrom(skillPath: string): unknown {
  return parseSkillMarkdown(unnamed, "SKILL.md", skillPath);
}

describe("the name of a skill file that states none", () => {
  it.each([
    // A SKILL.md takes the name of its folder, whatever the case of the file name.
    ["skills/tax-review/SKILL.md", "tax_review"],
    ["/srv/working copy/skills/Tax Review/skill.md", "tax_review"],
    ["skills//tax-review//SKILL.md", "tax_review"],
    ["skills/tax-review/SKILL.md/", "tax_review"],
    // Any other file takes its own name without the last extension.
    ["skills/tax-review.md", "tax_review"],
    ["/srv/skills/notes.v2.md", "notes_v2"],
    ["skills/readme", "readme"],
    ["skills/tax-review/", "tax_review"],
    ["skills/name.", "name"],
    // A leading dot is part of the name, not an extension.
    ["skills/.hidden", "hidden"],
    // No folder to take a name from. The skill schema refuses the empty name afterwards.
    ["SKILL.md", ""],
    ["/SKILL.md", ""],
    ["", ""]
  ])("reads %j as %j", (skillPath, name) => {
    expect(nameFrom(skillPath)).toMatchObject({ name });
  });

  it("keeps a stated name and never reads the path", () => {
    const named = unnamed.replace("title:", "name: stated\ntitle:");
    expect(parseSkillMarkdown(named, "SKILL.md", "skills/other/SKILL.md")).toMatchObject({
      name: "stated",
      content: "Read the file."
    });
  });

  it("refuses a file without frontmatter", () => {
    expect(() => parseSkillMarkdown("Read the file.", "skills/a/SKILL.md", "")).toThrow(
      SkillMarkdownError
    );
  });
});

describe("the packages a browser bundle loads", () => {
  // chat-ui imports core and api-contract, and both import asset-schemas. A Node module in
  // any of them fails every page when the bundle loads it.
  it.each(["asset-schemas", "core", "api-contract"])(
    "%s imports no Node module",
    async (packageName) => {
      const source = resolve(import.meta.dirname, "../packages", packageName, "src");
      const files = await readdir(source, { recursive: true });
      const offenders: string[] = [];
      for (const file of files.filter((name) => /\.tsx?$/u.test(name))) {
        const text = await readFile(join(source, file), "utf8");
        if (/\bfrom\s+"node:|\bimport\(\s*"node:|\brequire\(\s*"node:/u.test(text)) {
          offenders.push(file);
        }
      }
      expect(offenders).toEqual([]);
    }
  );
});
