import { describe, expect, it } from "vitest";
import {
  applySkillChange,
  createSkillChangePreview,
  SKILL_CHANGE_MAX_OPERATION_TEXT,
  SKILL_CHANGE_MAX_CONTENT,
  SKILL_CHANGE_MAX_RESOURCES,
  type SkillChangeOperation
} from "@vivd-catalyst/config-schema";
import type { SkillConfig } from "@vivd-catalyst/core";

const skill: SkillConfig = {
  name: "review",
  title: "Review",
  description: "Review guidance",
  content: "# Review\n\nCheck the facts. Ask when uncertain.\n\nKeep evidence.",
  resources: [{ path: "notes.md", mediaType: "text/markdown", content: "Resource guidance." }]
};
const replace = (oldText: string, newText = "Verify", target = "root"): SkillChangeOperation => ({
  type: "replace_text",
  target,
  oldText,
  newText
});

describe("skill changes", () => {
  it("replaces exactly once without mutating input and expands full paragraphs in preview", () => {
    expect(applySkillChange(skill, [replace("Check")]).content).toContain("Verify the facts.");
    expect(skill.content).toContain("Check");
    expect(createSkillChangePreview(skill, [replace("Check")]).changes).toEqual([
      {
        type: "replace",
        target: "root",
        before: "Check the facts. Ask when uncertain.",
        after: "Verify the facts. Ask when uncertain."
      }
    ]);
    expect(
      createSkillChangePreview(skill, [replace("uncertain.\n\nKeep", "unsure.\n\nRetain")])
        .changes[0]
    ).toMatchObject({
      before: "Check the facts. Ask when uncertain.\n\nKeep evidence.",
      after: "Check the facts. Ask when unsure.\n\nRetain evidence."
    });
  });
  it.each(["missing", "e", ""])("rejects non-unique or empty oldText %j", (text) => {
    expect(() => applySkillChange(skill, [replace(text)])).toThrow(
      text ? "exactly once" : /at least|small/i
    );
  });
  it("counts overlapping matches", () => {
    expect(() => applySkillChange({ ...skill, content: "aaa" }, [replace("aa")])).toThrow(
      "exactly once"
    );
  });
  it("edits resources and creates resources using the existing media type rules", () => {
    const changed = applySkillChange(skill, [
      replace("guidance", "details", "notes.md"),
      { type: "create_resource", resourcePath: "references/data.json", content: "{}" }
    ]);
    expect(changed.resources).toEqual([
      { path: "notes.md", mediaType: "text/markdown", content: "Resource details." },
      { path: "references/data.json", mediaType: "application/json", content: "{}" }
    ]);
    expect(
      createSkillChangePreview(skill, [
        { type: "create_resource", resourcePath: "new.txt", content: "Hello" }
      ]).changes
    ).toEqual([{ type: "new_resource", target: "new.txt", after: "Hello" }]);
  });
  it.each(["../bad.md", "/bad.md", "SKILL.md", "bad.exe"])(
    "rejects invalid resource %s",
    (resourcePath) => {
      expect(() =>
        applySkillChange(skill, [{ type: "create_resource", resourcePath, content: "text" }])
      ).toThrow();
    }
  );
  it("rejects missing targets, duplicate resources, binary resource text and missing headings", () => {
    expect(() => applySkillChange(skill, [replace("text", "x", "missing.md")])).toThrow(
      "does not exist"
    );
    expect(() =>
      applySkillChange(skill, [{ type: "create_resource", resourcePath: "NOTES.md", content: "x" }])
    ).toThrow("already exists");
    expect(() =>
      applySkillChange(skill, [{ type: "create_resource", resourcePath: "bad.txt", content: "\0" }])
    ).toThrow("binary");
    expect(() =>
      applySkillChange(skill, [
        { type: "append_text", target: "root", sectionHeading: "Missing", text: "x" }
      ])
    ).toThrow("does not exist");
    expect(() => applySkillChange(undefined, [replace("x")])).toThrow("does not exist");
  });
  it("appends to the end or named section, including its subsections, ignoring fenced headings", () => {
    const original = {
      ...skill,
      content: "## First\n\nOne.\n\n### Child\n\nTwo.\n\n## Next\n\nThree."
    };
    const operations: SkillChangeOperation[] = [
      { type: "append_text", target: "root", sectionHeading: "First", text: "Added." }
    ];
    expect(applySkillChange(original, operations).content).toBe(
      "## First\n\nOne.\n\n### Child\n\nTwo.\n\nAdded.\n\n## Next\n\nThree."
    );
    expect(createSkillChangePreview(original, operations).changes[0]).toEqual({
      type: "add",
      target: "root",
      sectionHeading: "First",
      after: "Added."
    });
    expect(
      applySkillChange(skill, [{ type: "append_text", target: "notes.md", text: "Added." }])
        .resources?.[0]?.content
    ).toBe("Resource guidance.\n\nAdded.");
    expect(() =>
      applySkillChange({ ...skill, content: "```md\n## Fake\n```" }, [
        { type: "append_text", target: "root", sectionHeading: "Fake", text: "x" }
      ])
    ).toThrow("does not exist");
    expect(() =>
      applySkillChange({ ...skill, content: "## Same\n\n## Same" }, [
        { type: "append_text", target: "root", sectionHeading: "Same", text: "x" }
      ])
    ).toThrow("ambiguous");
  });
  it("enforces operation, root, resource and resource-count caps", () => {
    expect(() =>
      applySkillChange(skill, [replace("Check", "x".repeat(SKILL_CHANGE_MAX_OPERATION_TEXT + 1))])
    ).toThrow();
    expect(() =>
      applySkillChange({ ...skill, content: "x".repeat(SKILL_CHANGE_MAX_CONTENT) }, [
        { type: "append_text", target: "root", text: "x" }
      ])
    ).toThrow("60000");
    expect(() =>
      applySkillChange(
        {
          ...skill,
          resources: [
            {
              path: "big.txt",
              mediaType: "text/plain",
              content: "x".repeat(SKILL_CHANGE_MAX_CONTENT)
            }
          ]
        },
        [{ type: "append_text", target: "big.txt", text: "x" }]
      )
    ).toThrow("60000");
    const resources = Array.from({ length: SKILL_CHANGE_MAX_RESOURCES }, (_, index) => ({
      path: `${index}.txt`,
      mediaType: "text/plain" as const,
      content: "x"
    }));
    expect(() =>
      applySkillChange({ ...skill, resources }, [
        { type: "create_resource", resourcePath: "extra.txt", content: "x" }
      ])
    ).toThrow("30 resources");
    expect(
      applySkillChange(skill, [replace("Check", "x".repeat(SKILL_CHANGE_MAX_OPERATION_TEXT))])
        .content
    ).toContain("x".repeat(4000));
  });
  it("creates a skill only as an exclusive operation", () => {
    const create = {
      type: "create_skill" as const,
      name: "new",
      title: "New",
      description: "New guidance",
      content: "Guidance"
    };
    expect(applySkillChange(undefined, [create])).toEqual({
      name: "new",
      title: "New",
      description: "New guidance",
      content: "Guidance"
    });
    expect(createSkillChangePreview(undefined, [create])).toMatchObject({
      isNewSkill: true,
      newSkill: { name: "new", content: "Guidance" }
    });
    expect(() => applySkillChange(undefined, [create, replace("x")])).toThrow("only operation");
    expect(() => applySkillChange(skill, [create])).toThrow("already exists");
  });
});
