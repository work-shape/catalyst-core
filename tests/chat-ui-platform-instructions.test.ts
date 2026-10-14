import { createElement, createRef } from "react";
import { describe, expect, it } from "vitest";
import {
  AgentEditor,
  PlatformInstructionsBody,
  agentConfigToForm
} from "@vivd-catalyst/chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The agent page shows what the platform tells the agent before its own instructions: the rules
// every agent gets, and the orientation only while the agent's saved tools name a platform
// tool. Read-only. Fails without the change: the page showed the agent's own instructions only.

const noop = () => undefined;

const instructions = {
  rules: "You act as the signed-in user.",
  orientation: "You run on a platform where people build and use agents.",
  toolNames: ["platform.context", "platform.assets.list"]
};

const render = (node: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(TranslationProvider, { children: null, locale: "en" }, node));

/** The Instructions section of the page of an agent that lists `toolNames`. */
function instructionsSection(toolNames: string[], withInstructions = true): string {
  const config = {
    name: "assistant",
    displayName: "Assistant",
    instructions: "Help the user.",
    toolNames,
    skillNames: [],
    initialPrompts: []
  };
  const markup = render(
    createElement(AgentEditor, {
      frame: {
        page: { ref: createRef<HTMLDivElement>(), above: null, shown: noop },
        asset: {
          id: "asset_agent",
          kind: "agent",
          name: config.name,
          scope: { kind: "instance" },
          revision: 1,
          config,
          updatedAt: "2026-10-14T10:00:00.000Z"
        },
        start: undefined,
        canWrite: true,
        instanceWrite: true,
        back: null,
        actions: null,
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
        enabledToolNames: [],
        ...(withInstructions ? { platformInstructions: instructions } : {})
      },
      editableAgentFields: ["instructions", "toolNames"],
      canManageAgentModels: false,
      skillChoice: { options: [], onSearch: noop }
    })
  );
  return /<section[^>]*id="instructions">.*?<\/section>/su.exec(markup)?.[0] ?? "";
}

describe("the platform instructions on an agent's page", () => {
  it("fold away above the agent's own instructions, and are absent where the instance names none", () => {
    const section = instructionsSection([]);
    expect(section).toContain("data-platform-instructions");
    expect(section).toContain("Platform instructions");
    expect(section.indexOf("Platform instructions")).toBeLessThan(section.indexOf("System prompt"));
    expect(instructionsSection([], false)).not.toContain("Platform instructions");
  });

  it("show the rules to every agent and the orientation only to one that holds a platform tool, with no field to edit", () => {
    const without = render(
      createElement(PlatformInstructionsBody, { instructions, toolNames: ["show_view"] })
    );
    expect(without).toContain("You act as the signed-in user.");
    expect(without).not.toContain("You run on a platform");
    expect(without).toContain("This agent holds none");

    const holding = render(
      createElement(PlatformInstructionsBody, {
        instructions,
        toolNames: ["show_view", "platform.assets.list"]
      })
    );
    expect(holding).toContain("You act as the signed-in user.");
    expect(holding).toContain("You run on a platform where people build and use agents.");
    for (const markup of [without, holding]) {
      expect(markup).not.toMatch(/<(textarea|input|button)/u);
    }
  });
});
