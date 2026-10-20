import { describe, expect, it } from "vitest";
import {
  canonicalizeAgentConfig,
  canonicalizeSkillConfig,
  parseAgentYaml,
  parseSkillFile,
  serializeAgentYaml,
  serializeSkillMarkdown
} from "@work-shape/catalyst-cli";
import { agentConfig } from "../support/config-cli";

describe("config CLI serialization", () => {
  it("deterministically round-trips agent YAML and ignores provenance comments", () => {
    const input = {
      ...agentConfig("First line\nSecond line"),
      description: { en: "Help with documents.", de: "Hilfe bei Unterlagen." },
      reasoningEffort: "xhigh" as const
    };
    const serialized = serializeAgentYaml(input, { instance: "local", version: 12 });

    expect(serialized).toMatch(/^# Pulled from local \(config version 12\)\./u);
    expect(serialized).toMatch(/instructions: \|[-+]?\n/u);
    expect(parseAgentYaml(serialized)).toEqual(canonicalizeAgentConfig(input));
    expect(parseAgentYaml(serialized).description).toEqual(input.description);
    expect(serializeAgentYaml(parseAgentYaml(serialized))).toBe(
      serializeAgentYaml(canonicalizeAgentConfig(input))
    );
    expect(Object.keys(canonicalizeAgentConfig(input))).toEqual([
      "name",
      "displayName",
      "description",
      "instructions",
      "modelProviderId",
      "reasoningEffort",
      "toolNames",
      "skillNames",
      "initialPrompts"
    ]);
  });

  it("round-trips fastMode including an explicit false", () => {
    const fast = { ...agentConfig("Fast"), modelBindingId: "primary", fastMode: true };
    const serialized = serializeAgentYaml(fast);

    expect(serialized).toContain("fastMode: true\n");
    expect(parseAgentYaml(serialized)).toMatchObject({ fastMode: true });
    expect(serializeAgentYaml(parseAgentYaml(serialized))).toBe(serialized);
    expect(serializeAgentYaml({ ...fast, fastMode: false })).toContain("fastMode: false");
    expect(parseAgentYaml(serializeAgentYaml({ ...fast, fastMode: false })).fastMode).toBe(false);
  });

  it("round-trips selectable models including explicit empty lists and maps", () => {
    const agent = { ...agentConfig("Chooser"), modelBindingId: "primary" };
    const serialized = serializeAgentYaml({
      ...agent,
      userSelectableModelBindingIds: ["fast", "cheap"]
    });

    expect(serialized).toContain("userSelectableModelBindingIds:\n  - fast\n  - cheap\n");
    expect(parseAgentYaml(serialized)).toMatchObject({
      userSelectableModelBindingIds: ["fast", "cheap"]
    });
    expect(serializeAgentYaml(parseAgentYaml(serialized))).toBe(serialized);
    expect(
      parseAgentYaml(serializeAgentYaml({ ...agent, userSelectableModelBindingIds: [] }))
        .userSelectableModelBindingIds
    ).toEqual([]);

    const withEfforts = serializeAgentYaml({
      ...agent,
      userSelectableModelBindingIds: ["fast", "cheap"],
      modelReasoningEfforts: { fast: "low" }
    });
    expect(withEfforts).toContain("modelReasoningEfforts:\n  fast: low\n");
    expect(serializeAgentYaml(parseAgentYaml(withEfforts))).toBe(withEfforts);
    expect(
      parseAgentYaml(serializeAgentYaml({ ...agent, modelReasoningEfforts: {} }))
        .modelReasoningEfforts
    ).toEqual({});
  });

  it("round-trips SKILL.md with provenance comments inside frontmatter", () => {
    const skill = {
      name: "review",
      title: "Review",
      description: "Review a workflow",
      content: "# Review\n\nCheck the workflow."
    };
    const serialized = serializeSkillMarkdown(skill, { instance: "staging", version: 4 });

    expect(serialized).toContain("---\n# Pulled from staging (config version 4).\n");
    expect(parseSkillFile(serialized)).toEqual(skill);
    expect(serializeSkillMarkdown(parseSkillFile(serialized))).toBe(serializeSkillMarkdown(skill));
  });

  it("keeps a skill's summary through a pull and a push, and writes none where there is none", () => {
    const skill = {
      name: "review",
      title: "Review",
      description: "Review a workflow",
      content: "# Review"
    };
    const summary = "Knows how to review a workflow and name what is missing.";
    const serialized = serializeSkillMarkdown({ ...skill, summary });

    expect(serialized).toContain(`summary: ${summary}\n`);
    expect(parseSkillFile(serialized)).toEqual({ ...skill, summary });
    expect(canonicalizeSkillConfig({ ...skill, summary })).toEqual({ ...skill, summary });
    expect(serializeSkillMarkdown(skill)).not.toContain("summary");
  });

  it("keeps starters through a pull and a push and writes none where there are none", () => {
    const plain = { name: "sheets", title: "Sheets", description: "When.", content: "# Text" };
    const starters = [
      { title: { en: "Build", de: "Bauen" }, hint: "Short", prompt: "Build it.", tools: ["a.b"] }
    ];
    const serialized = serializeSkillMarkdown({ ...plain, starters });

    expect(parseSkillFile(serialized)).toEqual({ ...plain, starters });
    expect(canonicalizeSkillConfig({ ...plain, starters })).toEqual({ ...plain, starters });
    expect(serializeSkillMarkdown(plain)).not.toContain("starters");
  });
});
