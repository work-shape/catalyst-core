import { describe, expect, it } from "vitest";
import { parsePageManifest } from "@vivd-catalyst/app-build/build";
import { parseSkillManifest, skillConfigSchema } from "@vivd-catalyst/config-schema";
import { yamlValueIssue } from "@vivd-catalyst/core";
import { readWorkflowManifest } from "@vivd-catalyst/workflows";

// A YAML reader answers an alias as the object its anchor made, so a few hundred bytes of
// nested aliases are a value that doubles with each level for whatever walks it as a tree.
// Every reader of YAML on a write path refuses such a file before anything walks it, in a
// time that does not depend on its levels.

/** `levels` anchors, each a list of ten aliases of the one before: ten to the power of them. */
function nested(levels: number, key: string): string {
  const lines = ["l0: &l0 [x, x, x, x, x, x, x, x, x, x]"];
  for (let level = 1; level < levels; level += 1) {
    const before = `*l${level - 1}`;
    lines.push(`l${level}: &l${level} [${Array.from({ length: 10 }, () => before).join(", ")}]`);
  }
  return `${lines.join("\n")}\n${key}: *l${levels - 1}\n`;
}

/** How long a read took, in milliseconds, with what it answered or threw. */
function timed<Result>(read: () => Result): { ms: number; result?: Result; error?: unknown } {
  const start = performance.now();
  try {
    const result = read();
    return { ms: performance.now() - start, result };
  } catch (error) {
    return { ms: performance.now() - start, error };
  }
}

/** A read of a file of a few hundred bytes that takes longer was walking what it should refuse. */
const REFUSED_WITHIN_MS = 1_000;
const LEVELS = [5, 6, 7, 12];

describe("a YAML file of nested aliases", () => {
  it("is no value by the walk that meets one object twice, and a file without an alias is", () => {
    const shared = { a: 1 };
    expect(yamlValueIssue({ one: shared, two: shared })).toBe("alias");
    expect(yamlValueIssue({ one: { a: 1 }, two: { a: 1 }, list: [1, "x", null] })).toBeUndefined();
    expect(yamlValueIssue({ a: { b: { c: {} } } }, 2)).toBe("depth");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(yamlValueIssue(cycle)).toBe("alias");
  });

  it.each(LEVELS)("is refused as the frontmatter of a SKILL.md at %i levels, at once", (levels) => {
    const file = `---\nname: bomb\ndescription: d\n${nested(levels, "metadata")}---\n\nText.\n`;
    expect(Buffer.byteLength(file)).toBeLessThan(2_000);
    const read = timed(() => parseSkillManifest(file, "SKILL.md", "bomb/SKILL.md"));
    expect(read.ms).toBeLessThan(REFUSED_WITHIN_MS);
    expect(read.error).toMatchObject({
      name: "SkillMarkdownError",
      reason: "skill_frontmatter_alias"
    });
  });

  it("holds the frontmatter a SKILL.md keeps to a depth and a size, as a file and as a config", () => {
    const deep = `---\nname: s\ndescription: d\nmetadata: ${"{a: ".repeat(9)}1${"}".repeat(9)}\n---\n\nT.\n`;
    expect(timed(() => parseSkillManifest(deep, "SKILL.md", "s/SKILL.md")).error).toMatchObject({
      reason: "skill_frontmatter_too_deep"
    });
    const large = `---\nname: s\ndescription: d\nnotes: "${"n".repeat(9_000)}"\n---\n\nT.\n`;
    expect(timed(() => parseSkillManifest(large, "SKILL.md", "s/SKILL.md")).error).toMatchObject({
      reason: "skill_frontmatter_too_large"
    });
    const kept = `---\nname: s\ndescription: d\nlicense: MIT\nmetadata: {a: {b: [1, 2]}}\n---\n\nT.\n`;
    expect(parseSkillManifest(kept, "SKILL.md", "s/SKILL.md")).toMatchObject({
      frontmatter: { license: "MIT", metadata: { a: { b: [1, 2] } } }
    });
    const config = { name: "s", title: "S", description: "d", content: "c" };
    expect(
      skillConfigSchema.safeParse({ ...config, frontmatter: { license: "MIT" } }).success
    ).toBe(true);
    expect(
      skillConfigSchema.safeParse({ ...config, frontmatter: { notes: "n".repeat(9_000) } }).success
    ).toBe(false);
  });

  it("is refused, never thrown, where it is no YAML at all: workflow.yaml and app.yaml", () => {
    for (const [shape, text] of [
      ["an unquoted colon", "id: w\nname: Use this when: the user asks\n"],
      ["a key written twice", "id: w\nname: W\nname: X\n"],
      ["a tag the reader does not know", "id: w\nname: !!python/object:os.system x\n"],
      ["5,000 levels", `id: w\nname: ${"[".repeat(5_000)}${"]".repeat(5_000)}\n`]
    ] as const) {
      const workflow = timed(() => readWorkflowManifest(text));
      expect(workflow.error, shape).toBeUndefined();
      expect(workflow.result, shape).toMatchObject({ ok: false });
      const app = timed(() => parsePageManifest(new TextEncoder().encode(text)));
      expect(app.error, shape).toBeUndefined();
      expect(app.result, shape).toMatchObject({ status: "errors" });
    }
  });

  it.each(LEVELS)(
    "is refused as workflow.yaml and app.yaml at %i levels, at once (store.yaml: data-store-engine.test.ts)",
    (levels) => {
      const workflow = timed(() =>
        readWorkflowManifest(`id: w\nname: W\n${nested(levels, "inputs")}`)
      );
      expect(workflow.ms).toBeLessThan(REFUSED_WITHIN_MS);
      expect(workflow.result).toMatchObject({
        ok: false,
        issues: [{ message: expect.stringContaining("anchor") }]
      });

      const app = timed(() =>
        parsePageManifest(new TextEncoder().encode(`id: a\nname: A\n${nested(levels, "actions")}`))
      );
      expect(app.ms).toBeLessThan(REFUSED_WITHIN_MS);
      expect(app.result).toMatchObject({
        status: "errors",
        errors: [{ message: expect.stringContaining("anchor") }]
      });
    }
  );
});
