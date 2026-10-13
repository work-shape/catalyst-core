import { describe, expect, it } from "vitest";
import {
  parseSkillMarkdown,
  skillConfigSchema,
  SKILL_SUMMARY_MAX_LENGTH
} from "@vivd-catalyst/asset-schemas";
import { createSkillSourceVersion } from "@vivd-catalyst/tool-execution";
import {
  skillConfigToForm,
  skillFacts,
  skillFormToConfig
} from "@vivd-catalyst/chat-ui/build-area";

// A skill's `summary`: the sentence for people, from the skill file to the row that shows it.

const skill = {
  name: "plain-language",
  title: "Plain language",
  description: "Use when a text should be short and easy to read.",
  content: "One thought per sentence."
};
const summary = "Knows how to write short, easy sentences in German and English.";

describe("the summary of a skill file", () => {
  const file = (frontmatter: string) =>
    `---\ntitle: Plain language\ndescription: Use for short texts.\n${frontmatter}---\nWrite.`;

  it("is read from the front matter and stays apart from the description", () => {
    expect(
      parseSkillMarkdown(file(`summary: ${summary}\n`), "SKILL.md", "skills/plain/SKILL.md")
    ).toMatchObject({ summary, description: "Use for short texts." });
  });

  it("is optional", () => {
    const parsed = skillConfigSchema.parse(skill);

    expect(parsed).not.toHaveProperty("summary");
  });

  it("holds one line of at most 120 characters", () => {
    const issuesOf = (value: string) =>
      skillConfigSchema
        .safeParse({ ...skill, summary: value })
        .error?.issues.map((issue) => [issue.path.join("."), issue.message]);

    expect(SKILL_SUMMARY_MAX_LENGTH).toBe(120);
    expect(issuesOf("a".repeat(120))).toBeUndefined();
    expect(issuesOf("a".repeat(121))).toEqual([
      ["summary", "Skill summary must be at most 120 characters"]
    ]);
    expect(issuesOf("Knows how to write.\nAnd more.")).toEqual([
      ["summary", "Skill summary must be one line"]
    ]);
    expect(issuesOf("")).toHaveLength(1);
  });

  it("changes the version a proposed change is checked against, and only where it is set", () => {
    const before = createSkillSourceVersion(skill);

    expect(createSkillSourceVersion({ ...skill, summary })).not.toBe(before);
    expect(createSkillSourceVersion({ ...skill, summary: undefined })).toBe(before);
  });
});

describe("the summary in the skill form", () => {
  it("is kept by a save and left out where the field is empty", () => {
    expect(skillFormToConfig(skillConfigToForm({ ...skill, summary }))).toEqual({
      ...skill,
      summary
    });
    expect(skillFormToConfig({ ...skillConfigToForm(skill), summary: "  " })).toEqual(skill);
  });
});

describe("what a list shows of a skill", () => {
  it("shows the summary where the skill has one", () => {
    expect(skillFacts({ attributes: { summary } })).toEqual({ summary });
    expect(skillFacts({ attributes: { summary: " " } })).toEqual({});
    expect(skillFacts({})).toEqual({});
  });

  it("takes the icon the skill names, whoever ships it, and never reads its name for one", () => {
    expect(skillFacts({ attributes: { origin: "release", icon: "pdf" } })).toEqual({
      icon: "pdf"
    });
    expect(skillFacts({ attributes: { origin: "instance", icon: "pdf" } })).toEqual({
      icon: "pdf"
    });
    expect(skillFacts({ attributes: { origin: "instance" } })).toEqual({});
    expect(skillFacts({ attributes: { icon: "" } })).toEqual({});
  });

  it("keeps the icon a builder chose through the form, and none where none is chosen", () => {
    const skill = { name: "sheets", title: "Sheets", description: "When.", content: "# Text" };
    expect(skillFormToConfig(skillConfigToForm({ ...skill, icon: "spreadsheet" }))).toEqual({
      ...skill,
      icon: "spreadsheet"
    });
    expect(skillFormToConfig({ ...skillConfigToForm(skill), icon: "" })).toEqual(skill);
  });
});
