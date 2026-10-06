import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgentAvailabilityEditor,
  AgentEditor,
  configRevisionAction,
  SkillEditor
} from "../packages/chat-ui/src/control-plane/config-asset-editors";
import { agentConfigToForm } from "../packages/chat-ui/src/control-plane/config-assets-model";

describe("config asset editors", () => {
  it("shows configured runtime values while the agent is read-only", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentEditor, {
        initialForm: agentConfigToForm({
          name: "assistant",
          displayName: "Assistant",
          description: "Help with the workflow.",
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
          fastModeModelBindingIds: [],
          userSelectableModelBindings: [],
          reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
          enabledToolNames: []
        },
        editableAgentFields: [],
        canManageAgentModels: false,
        skillNames: [],
        mutating: false,
        onSave: async () => ({ ok: true }),
        revisions: null
      })
    );

    expect(markup).toContain("azure-eu");
    expect(markup).toContain('value="Help with the workflow."');
    expect(markup).toContain('<option value="high" selected="">high</option>');
    expect(markup).toContain('value="128"');
    expect(markup).not.toContain("Save changes");
  });

  it("does not expose a model binding control for a legacy provider-only edit policy", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentEditor, {
        initialForm: agentConfigToForm({
          name: "assistant",
          displayName: "Assistant",
          instructions: "Help the user.",
          modelProviderId: "azure-eu",
          toolNames: [],
          skillNames: [],
          initialPrompts: []
        }),
        isNew: false,
        isDefault: true,
        references: {
          modelProviderIds: ["azure-eu"],
          modelBindingIds: ["reasoning"],
          modelBindings: [{ id: "reasoning", model: "gpt-5" }],
          fastModeModelBindingIds: [],
          userSelectableModelBindings: [],
          reasoningEfforts: [],
          enabledToolNames: []
        },
        editableAgentFields: ["modelProviderId"],
        canManageAgentModels: false,
        skillNames: [],
        mutating: false,
        onSave: async () => ({ ok: true }),
        revisions: null
      })
    );

    expect(markup).toContain('value="azure-eu"');
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("reasoning");
  });

  it("makes model, reasoning effort and fast mode editable by permission, not by edit policy", () => {
    const render = (canManageAgentModels: boolean, modelBindingId = "fast") =>
      renderToStaticMarkup(
        createElement(AgentEditor, {
          initialForm: agentConfigToForm({
            name: "assistant",
            displayName: "Assistant",
            instructions: "Help the user.",
            modelBindingId,
            reasoningEffort: "high",
            fastMode: modelBindingId === "fast",
            toolNames: [],
            skillNames: [],
            initialPrompts: []
          }),
          isNew: false,
          isDefault: true,
          references: {
            modelProviderIds: ["azure-eu"],
            modelBindingIds: ["fast", "plain"],
            modelBindings: [
              { id: "fast", model: "gpt-fast" },
              { id: "plain", model: "gpt-plain" }
            ],
            fastModeModelBindingIds: ["fast"],
            userSelectableModelBindings: [],
            reasoningEfforts: ["low", "high"],
            enabledToolNames: []
          },
          // The legacy entries no longer make the model settings editable.
          editableAgentFields: canManageAgentModels ? [] : ["modelBindingId", "reasoningEffort"],
          canManageAgentModels,
          skillNames: [],
          mutating: false,
          onSave: async () => ({ ok: true }),
          revisions: null
        })
      );
    const fastSwitch = (markup: string) => /<button[^>]*role="switch"[^>]*>/u.exec(markup)?.[0];
    const effortSelect = (markup: string) =>
      /<select[^>]*>(?=<option value="">Model default)/u.exec(markup)?.[0];

    const editable = render(true);
    expect(editable).toContain('<option value="fast" selected="">');
    expect(effortSelect(editable)).not.toContain('disabled=""');
    expect(fastSwitch(editable)).toContain('aria-checked="true"');
    expect(fastSwitch(editable)).not.toContain('disabled=""');
    expect(editable).toContain("Fast runs are billed at a higher rate.");
    expect(editable).toContain("Save changes");

    const readOnly = render(false);
    expect(readOnly).not.toContain('<option value="fast"');
    expect(readOnly).toContain('value="GPT-fast"');
    expect(effortSelect(readOnly)).toContain('disabled=""');
    expect(fastSwitch(readOnly)).toContain('disabled=""');

    // No fast-mode control for a binding that does not support it.
    expect(fastSwitch(render(true, "plain"))).toBeUndefined();
  });

  it("lists eligible bindings as the models users may choose, editable by permission", () => {
    const render = (canManageAgentModels: boolean, userSelectableModelBindingIds: string[]) =>
      renderToStaticMarkup(
        createElement(AgentEditor, {
          initialForm: agentConfigToForm({
            name: "assistant",
            displayName: "Assistant",
            instructions: "Help the user.",
            modelBindingId: "sol",
            userSelectableModelBindingIds,
            toolNames: [],
            skillNames: [],
            initialPrompts: []
          }),
          isNew: false,
          isDefault: true,
          references: {
            modelProviderIds: ["openai"],
            modelBindingIds: ["sol", "terra", "luna"],
            modelBindings: [
              { id: "sol", model: "gpt-5.6-sol" },
              { id: "terra", model: "gpt-5.6-terra" },
              { id: "luna", model: "gpt-5.6-luna" }
            ],
            fastModeModelBindingIds: [],
            userSelectableModelBindings: [
              { id: "sol", model: "gpt-5.6-sol" },
              { id: "terra", model: "gpt-5.6-terra" }
            ],
            reasoningEfforts: [],
            enabledToolNames: []
          },
          editableAgentFields: [],
          canManageAgentModels,
          skillNames: [],
          mutating: false,
          onSave: async () => ({ ok: true }),
          revisions: null
        })
      );
    const group = (markup: string) =>
      /<fieldset[^>]*><legend[^>]*>Models users may choose<\/legend>.*?<\/fieldset>/u.exec(
        markup
      )?.[0];

    // The agent's own model is always available, so only the other eligible binding is listed.
    // "luna" is not userSelectable in release config and "retired" no longer exists.
    const editable = group(render(true, ["terra", "retired"]));
    expect(editable).toContain("1 selected");
    expect(editable).toContain("GPT-5.6 Terra");
    expect(editable).not.toContain("Sol");
    expect(editable).not.toContain("Luna");
    expect(editable).not.toContain("retired");
    expect(editable).toMatch(/<input type="checkbox"[^>]*checked=""/u);
    expect(editable).not.toContain('disabled=""');

    // The model select shows the chat selector's labels instead of raw model ids.
    expect(render(true, [])).toContain('<option value="sol" selected="">GPT-5.6 Sol</option>');
    expect(group(render(true, []))).toContain("0 selected");

    // Without the permission the list is read-only, and hidden when nothing is offered.
    expect(group(render(false, ["terra"]))).toContain('disabled=""');
    expect(group(render(false, []))).toBeUndefined();
  });

  it("keeps a read-only skill package navigable without mutation controls", () => {
    const markup = renderToStaticMarkup(
      createElement(SkillEditor, {
        initialForm: {
          name: "document_review",
          title: "Document review",
          description: "Review submitted documents.",
          content: "# Review",
          resources: [
            {
              path: "references/checks.md",
              mediaType: "text/markdown",
              content: "# Checks"
            }
          ]
        },
        isNew: false,
        editable: false,
        mutating: false,
        onSave: async () => ({ ok: true }),
        revisions: null
      })
    );

    expect(markup).toContain("SKILL.md");
    expect(markup).toContain("references/checks.md");
    expect(markup).toContain("border-l");
    expect(markup).toContain("lucide-file-text shrink-0");
    expect(markup).toContain("readOnly");
    expect(markup).toContain("flex-1 resize-y");
    expect(markup).toContain("grid-rows-[auto_minmax(24rem,1fr)_auto]");
    expect(markup).not.toContain("Add reference");
    expect(markup).not.toContain("Save changes");
  });

  const workspaces = [
    { id: "ws_sales", name: "Sales" },
    { id: "ws_legal", name: "Legal" }
  ];

  it("offers personal and shared workspaces for a selectively available agent", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentAvailabilityEditor, {
        availability: {
          mode: "selected",
          personalWorkspaces: true,
          collaborationWorkspaceIds: ["ws_legal"]
        },
        isDefault: false,
        workspaces,
        mutating: false,
        onSave: async () => ({ ok: true })
      })
    );

    expect(markup).toContain("Available in");
    expect(markup).toContain("Personal workspaces");
    expect(markup).toContain("Sales");
    expect(markup).toContain("Legal");
    expect(markup).not.toContain("ws_legal");
    expect(markup.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(2);
    expect(markup).toContain("Save availability");
    expect(markup).not.toContain("not available in any workspace");
  });

  it("locks the default agent to all workspaces and explains why", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentAvailabilityEditor, {
        availability: { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] },
        isDefault: true,
        workspaces,
        mutating: false,
        onSave: async () => ({ ok: true })
      })
    );

    expect(markup).toContain("<fieldset");
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("The default agent is always available in all workspaces.");
    expect(markup).not.toContain("Save availability");
  });

  it("warns that an agent without any selection is hidden", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentAvailabilityEditor, {
        availability: undefined,
        isDefault: false,
        workspaces: [],
        mutating: false,
        onSave: async () => ({ ok: true })
      })
    );

    expect(markup).toContain("There are no shared workspaces yet.");
    expect(markup).toContain("this agent is not available in any workspace");
  });

  it("labels only the latest revision as current when restoration is unavailable", () => {
    expect(configRevisionAction(3, 3, false)).toBe("current");
    expect(configRevisionAction(2, 3, false)).toBeUndefined();
    expect(configRevisionAction(2, 3, true)).toBe("restore");
  });
});
