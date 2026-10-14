import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  createAssetKindRegistry,
  defineAssetKind,
  findNamespaceOfAssetName,
  type AssetValidationContext,
  type RegisteredAssetKind
} from "@vivd-catalyst/core";
import { createAgentAssetKind, createSkillAssetKind } from "@vivd-catalyst/chat-server";

// A third kind as a later slice would write it: everything it is stands in this one
// definition, and nothing outside it names the kind.
const widgetKind = defineAssetKind({
  kind: "widget",
  plural: "widgets",
  schema: z.object({ name: z.string(), title: z.string(), skillName: z.string().optional() }),
  nameRule: { pattern: /^[a-z][a-z0-9-]*$/u, maxLength: 12, description: "Widget name is invalid" },
  actions: { read: "widget.read", write: "widget.write", delete: "widget.delete" },
  validate: (context, widgets) =>
    widgets.flatMap((widget) =>
      widget.skillName === undefined ||
      context
        .definitions("skill")
        .some((skill) => z.object({ name: z.string() }).parse(skill).name === widget.skillName)
        ? []
        : [{ message: `Widget '${widget.name}' references missing skill '${widget.skillName}'` }]
    ),
  summarize: (widget) => ({ name: widget.name, title: widget.title })
});

const config = parseClientInstanceConfig({
  version: 1,
  clientInstance: { id: "kinds", displayName: "Kinds", environment: "development" },
  auth: {},
  infrastructure: { models: { local: { provider: "deterministic", model: "local" } } }
});
const validationRefs = {
  modelProviderIds: ["local"],
  modelBindingIds: [],
  modelBindings: [],
  fastModeModelBindingIds: [],
  reasoningEfforts: [],
  enabledToolNames: ["read_skill"]
};
const agentKind = createAgentAssetKind({ config, validationRefs });
const skillKind = createSkillAssetKind({ config, shippedSkillNames: [] });
const skill = { name: "research", title: "Research", description: "How to", content: "Read." };
const withSkills = (...skills: unknown[]): AssetValidationContext => ({
  definitions: (kind) => (kind === "skill" ? skills : []),
  changes: () => true
});
/** What the write path asks of a kind for one definition: read it, then check what was accepted. */
const issuesOf = (
  kind: RegisteredAssetKind,
  context: AssetValidationContext,
  definition: unknown
) => {
  const reading = kind.read([definition]);
  return [...reading.refused.flatMap((refused) => refused.issues), ...reading.validate(context)];
};

function agent(overrides: Record<string, unknown> = {}) {
  return {
    name: "assistant",
    displayName: { en: "Assistant", de: "Assistentin" },
    description: "Answers",
    instructions: "Help.",
    modelProviderId: "local",
    toolNames: [],
    skillNames: [],
    initialPrompts: [],
    ...overrides
  };
}

describe("asset kind registry", () => {
  it("holds a third kind beside agent and skill without an edit outside its definition", () => {
    const registry = createAssetKindRegistry([agentKind, skillKind, widgetKind]);

    expect(registry.kinds.map((kind) => [kind.kind, kind.plural])).toEqual([
      ["agent", "agents"],
      ["skill", "skills"],
      ["widget", "widgets"]
    ]);
    const widget = registry.require("widget");
    expect(widget.actions).toEqual({
      read: "widget.read",
      write: "widget.write",
      delete: "widget.delete"
    });
    expect(issuesOf(widget, withSkills(skill), { name: "board", title: "Board" })).toEqual([]);
    expect(
      issuesOf(widget, withSkills(skill), { name: "board", title: "Board", skillName: "research" })
    ).toEqual([]);
    expect(
      issuesOf(widget, withSkills(), { name: "board", title: "Board", skillName: "research" })
    ).toEqual([{ message: "Widget 'board' references missing skill 'research'" }]);
    expect(widget.summarize({ name: "board", title: "Board" })).toEqual({
      name: "board",
      title: "Board"
    });
  });

  it("answers a definition its schema or name rule refuses before the kind's own checks", () => {
    expect(issuesOf(widgetKind, withSkills(), { name: "board" })).toEqual([
      expect.objectContaining({ path: ["title"] })
    ]);
    expect(issuesOf(widgetKind, withSkills(), { name: "Board", title: "Board" })).toEqual([
      { message: "Widget name is invalid", path: ["name"] }
    ]);
    expect(issuesOf(widgetKind, withSkills(), { name: "a-very-long-board", title: "B" })).toEqual([
      { message: "Widget name is invalid", path: ["name"] }
    ]);
    expect(() => widgetKind.summarize({ name: "board" })).toThrow(
      "The widget definition is invalid"
    );
  });

  // Fails without the refusal: a kind without a draft goes live with every put and sync,
  // which ask nothing, so its check of who makes a revision live held for a revert alone.
  it("refuses a kind that checks who makes a revision live and has no published revision", () => {
    const authorizeLive = () => undefined;
    expect(() => createAssetKindRegistry([{ ...widgetKind, authorizeLive }])).toThrow(
      "Asset kind 'widget' checks who makes a revision live and has no published revision"
    );
    const drafted = defineAssetKind({
      kind: "gizmo",
      plural: "gizmos",
      lifecycle: "draft_published",
      schema: z.object({ name: z.string() }),
      nameRule: { pattern: /^.+$/u, description: "Gizmo name is invalid" },
      actions: {
        read: "gizmo.read",
        write: "gizmo.write",
        delete: "gizmo.delete",
        publish: "gizmo.publish"
      },
      summarize: (gizmo) => ({ name: gizmo.name, title: gizmo.name }),
      validate: () => []
    });
    expect(
      createAssetKindRegistry([{ ...drafted, authorizeLive }]).require("gizmo").lifecycle
    ).toBe("draft_published");
  });

  it("refuses a kind or a plural that is registered twice, and an unknown kind", () => {
    expect(() => createAssetKindRegistry([agentKind, skillKind, agentKind])).toThrow(
      "Asset kind 'agent' is registered more than once"
    );
    const clash = defineAssetKind({
      kind: "gadget",
      plural: "widgets",
      schema: z.object({ name: z.string() }),
      nameRule: { pattern: /^.+$/u, description: "Gadget name is invalid" },
      actions: { read: "gadget.read", write: "gadget.write", delete: "gadget.delete" },
      validate: () => [],
      summarize: (gadget) => ({ name: gadget.name, title: gadget.name })
    });
    expect(() => createAssetKindRegistry([widgetKind, clash])).toThrow(
      "Asset kind plural 'widgets' is registered more than once"
    );
    expect(() => createAssetKindRegistry([widgetKind]).require("gadget")).toThrow(
      "Asset kind 'gadget' is not registered"
    );
    expect(createAssetKindRegistry([widgetKind]).get("gadget")).toBeUndefined();
    expect(() => defineAssetKind({ ...clashDefinition(), kind: "Data Store" })).toThrow(
      "must be lowercase words joined by underscores"
    );
  });

  it("registers agent and skill with their schemas and reference checks", () => {
    expect(agentKind.actions).toEqual({
      read: "agent.read",
      write: "agent.write",
      delete: "agent.delete"
    });
    expect(skillKind.actions).toEqual({
      read: "skill.read",
      write: "skill.write",
      delete: "skill.delete"
    });
    expect(issuesOf(agentKind, withSkills(), agent())).toEqual([]);
    expect(
      issuesOf(
        agentKind,
        withSkills(skill),
        agent({ skillNames: ["research"], toolNames: ["read_skill"] })
      )
    ).toEqual([]);
    expect(
      issuesOf(agentKind, withSkills(), agent({ skillNames: ["research"], toolNames: ["web"] }))
    ).toEqual([
      { message: "Agent 'assistant' references missing skill 'research'" },
      { message: "Agent 'assistant' references unavailable tool 'web'" },
      { message: "Agent 'assistant' references skills but does not allow 'read_skill'" }
    ]);
    expect(issuesOf(agentKind, withSkills(), agent({ instructions: "" }))).toEqual([
      expect.objectContaining({ path: ["instructions"] })
    ]);
    expect(agentKind.summarize(agent())).toEqual({
      name: "assistant",
      title: "Assistant",
      description: "Answers"
    });
    // A list in another language names the agent in it, and falls back to the default.
    expect(
      agentKind.summarize(agent({ description: { en: "Answers", de: "Antwortet" } }), "de")
    ).toEqual({ name: "assistant", title: "Assistentin", description: "Antwortet" });
    expect(agentKind.summarize(agent({ displayName: "Assistant" }), "de")).toMatchObject({
      title: "Assistant"
    });

    expect(issuesOf(skillKind, withSkills(), skill)).toEqual([]);
    expect(issuesOf(skillKind, withSkills(), { ...skill, name: "1st" })).toEqual([
      expect.objectContaining({ path: ["name"] })
    ]);
    // A list says who ships the skill: every stored skill is the instance's own.
    expect(skillKind.summarize(skill)).toEqual({
      name: "research",
      title: "Research",
      description: "How to",
      attributes: { origin: "instance" }
    });
    // The sentence for people reaches a list beside the name. No skill names an icon itself.
    expect(skillKind.summarize({ ...skill, summary: "Knows how to research a question." })).toEqual(
      {
        name: "research",
        title: "Research",
        description: "How to",
        attributes: { origin: "instance", summary: "Knows how to research a question." }
      }
    );
  });

  it("derives the Namespace of an asset from its name", () => {
    const namespaces = [{ prefix: "kai-" }, { prefix: "team-b-" }];
    expect(findNamespaceOfAssetName(namespaces, "kai-tax")).toEqual({ prefix: "kai-" });
    expect(findNamespaceOfAssetName(namespaces, "team-b-intake")).toEqual({ prefix: "team-b-" });
    expect(findNamespaceOfAssetName(namespaces, "assistant")).toBeUndefined();
  });
});

function clashDefinition() {
  return {
    kind: "gadget",
    plural: "gadgets",
    schema: z.object({ name: z.string() }),
    nameRule: { pattern: /^.+$/u, description: "Gadget name is invalid" },
    actions: { read: "gadget.read", write: "gadget.write", delete: "gadget.delete" },
    validate: () => [],
    summarize: (gadget: { name: string }) => ({ name: gadget.name, title: gadget.name })
  };
}
