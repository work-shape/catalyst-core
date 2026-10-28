import { createElement, createRef } from "react";
import { describe, expect, it } from "vitest";
import { AgentEditor, agentConfigToForm } from "@work-shape/catalyst-chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The page of an agent that ships with the platform, such as Workshaper (SA-1): it says so in
// the head, and under each field the instance changed it says that the field differs from what
// the platform ships and offers to reset it. Fails without the change: the page showed a
// shipped agent like any other.

const noop = () => undefined;

const render = (node: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(TranslationProvider, { children: null, locale: "en" }, node));

function page(config: Record<string, unknown>, editable: string[]): string {
  return render(
    createElement(AgentEditor, {
      frame: {
        page: { ref: createRef<HTMLDivElement>(), above: null, shown: noop },
        asset: {
          id: "asset_agent",
          kind: "agent",
          name: String(config.name),
          scope: { kind: "instance" },
          revision: 2,
          config,
          updatedAt: "2026-10-21T10:00:00.000Z"
        },
        start: undefined,
        canWrite: true,
        instanceWrite: true,
        back: null,
        actions: {},
        notice: null,
        onUnsavedChange: noop,
        save: async () => ({ ok: true as const })
      },
      initialForm: agentConfigToForm(config),
      isDefault: false,
      references: {
        modelProviderIds: [],
        modelBindingIds: [],
        modelBindings: [],
        fastModeModelBindingIds: [],
        reasoningEfforts: [],
        enabledToolNames: []
      },
      editableAgentFields: editable,
      canManageAgentModels: false,
      skillChoice: { options: [], onSearch: noop }
    })
  );
}

const shippedFields = {
  displayName: { en: "Workshaper", de: "Workshaper" },
  instructions: "As shipped.",
  toolNames: ["platform.context", "read_skill"],
  skillNames: [],
  initialPrompts: []
};

describe("the page of an agent that ships with the platform", () => {
  it("marks the fields the instance changed and offers their reset to who may change them", () => {
    const config = {
      name: "workshaper",
      ...shippedFields,
      instructions: "Our own.",
      // The same tools in another order are as shipped.
      toolNames: ["read_skill", "platform.context"],
      shipped: shippedFields
    };
    const markup = page(config, ["instructions", "toolNames"]);
    expect(markup).toContain("Ships with the platform");
    expect(markup).toContain('data-shipped-group="instructions"');
    expect(markup).not.toContain('data-shipped-group="toolNames"');
    expect(markup).not.toContain('data-shipped-group="displayName"');
    expect(markup).toContain("Differs from what the platform ships");
    expect(markup).toContain("Reset to shipped");
    // A reader who may not change the field reads that it differs, with no reset.
    expect(page(config, [])).not.toContain("Reset to shipped");
  });

  it("keeps the platform's instructions closed and takes the instance's own as additions", () => {
    const markup = page(
      {
        name: "workshaper",
        ...shippedFields,
        additionalInstructions: "Answer in short sentences.",
        shipped: shippedFields
      },
      ["instructions"]
    );
    expect(markup).toContain("Platform instructions");
    expect(markup).toContain("Change platform text");
    expect(markup).toMatch(/<textarea[^>]*readOnly=""[^>]*>As shipped\.<\/textarea>/u);
    expect(markup).toContain("Additions of this instance");
    expect(markup).toMatch(
      /<textarea[^>]*data-additional-instructions=""[^>]*>Answer in short sentences\.<\/textarea>/u
    );
    expect(markup).not.toMatch(/data-additional-instructions=""[^>]*readOnly/u);
  });

  it("offers a release's new version of a field the instance changed, to take or keep", () => {
    const config = {
      name: "workshaper",
      ...shippedFields,
      instructions: "Our own.",
      shipped: { ...shippedFields, instructions: "The new release's text." },
      shippedNewer: ["instructions"]
    };
    const markup = page(config, ["instructions"]);
    expect(markup).toContain('data-shipped-newer="instructions"');
    expect(markup).toContain("The platform has a new version of this field.");
    expect(markup).toContain("The new release&#x27;s text.");
    expect(markup).toContain("Take new version");
    expect(markup).toContain("Keep mine");
    expect(markup).not.toContain("Reset to shipped");
    // Who may not change the field reads both versions and decides nothing.
    expect(page(config, [])).not.toContain("Keep mine");
  });

  it("shows any other agent as before", () => {
    const markup = page({ name: "assistant", ...shippedFields }, ["instructions"]);
    expect(markup).not.toContain("Ships with the platform");
    expect(markup).not.toContain("data-shipped-group");
    expect(markup).not.toContain("Additions of this instance");
  });
});
