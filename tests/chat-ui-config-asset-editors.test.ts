import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgentEditor,
  configRevisionAction
} from "../packages/chat-ui/src/control-plane/config-asset-editors";
import { agentConfigToForm } from "../packages/chat-ui/src/control-plane/config-assets-model";

describe("config asset editors", () => {
  it("shows configured runtime values while the agent is read-only", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentEditor, {
        initialForm: agentConfigToForm({
          name: "assistant",
          displayName: "Assistant",
          instructions: "Help the user.",
          modelProviderId: "azure-eu",
          reasoningEffort: "high",
          maxSteps: 128,
          toolNames: [],
          skillNames: [],
          initialPrompts: []
        }),
        isNew: false,
        isDefault: true,
        references: {
          modelProviderIds: ["azure-eu"],
          modelBindingIds: [],
          modelBindings: [],
          reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
          enabledToolNames: []
        },
        editableAgentFields: [],
        skillNames: [],
        mutating: false,
        onSave: async () => ({ ok: true }),
        revisions: null
      })
    );

    expect(markup).toContain("azure-eu");
    expect(markup).toContain('<option value="high" selected="">high</option>');
    expect(markup).toContain('value="128"');
    expect(markup).not.toContain("Save changes");
  });

  it("labels only the latest revision as current when restoration is unavailable", () => {
    expect(configRevisionAction(3, 3, false)).toBe("current");
    expect(configRevisionAction(2, 3, false)).toBeUndefined();
    expect(configRevisionAction(2, 3, true)).toBe("restore");
  });
});
