import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "./chat-ui-render-harness";
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

  it("shows a tool of a module that is off as selected, unavailable and removable", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentEditor, {
        initialForm: agentConfigToForm({
          name: "assistant",
          displayName: "Assistant",
          instructions: "Help the user.",
          modelProviderId: "azure-eu",
          toolNames: ["read_skill", "documents.read"],
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
          reasoningEfforts: [],
          enabledToolNames: ["read_skill"],
          moduleOffTools: [
            { name: "documents.read", module: "documents" },
            { name: "documents.search", module: "documents" }
          ]
        },
        editableAgentFields: ["toolNames"],
        canManageAgentModels: false,
        skillNames: [],
        mutating: false,
        onSave: async () => ({ ok: true }),
        revisions: null
      })
    );

    expect(markup).toContain('data-unavailable-option="documents.read"');
    expect(markup).toContain("Not available: the module Documents is off. Remove it to save.");
    expect(markup).toContain('aria-label="Remove"');
    // A tool of the module that the agent does not name is not shown at all.
    expect(markup).not.toContain("documents.search");
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

    expect(markup).toContain("Instance default (azure-eu)");
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

    const defaultRadio = (markup: string) =>
      /<input type="radio"[^>]*aria-label="GPT-fast: Default"[^>]*>/u.exec(markup)?.[0];

    const editable = render(true);
    expect(defaultRadio(editable)).toContain('checked=""');
    expect(defaultRadio(editable)).not.toContain('disabled=""');
    expect(effortSelect(editable)).not.toContain('disabled=""');
    expect(fastSwitch(editable)).toContain('aria-checked="true"');
    expect(fastSwitch(editable)).not.toContain('disabled=""');
    expect(editable).toContain("Fast runs are billed at a higher rate.");
    expect(editable).toContain("Save changes");

    const readOnly = render(false);
    expect(defaultRadio(readOnly)).toContain('checked=""');
    expect(defaultRadio(readOnly)).toContain('disabled=""');
    expect(readOnly).not.toContain("GPT-plain");
    expect(effortSelect(readOnly)).toContain('disabled=""');
    expect(fastSwitch(readOnly)).toContain('disabled=""');

    // No fast-mode control for a binding that does not support it.
    expect(fastSwitch(render(true, "plain"))).toBeUndefined();
  });

  it("shows the agent's models as one list of default and user-selectable models", () => {
    const render = (
      canManageAgentModels: boolean,
      modelBindingId: string,
      userSelectableModelBindingIds: string[]
    ) =>
      renderToStaticMarkup(
        createElement(AgentEditor, {
          initialForm: agentConfigToForm({
            name: "assistant",
            displayName: "Assistant",
            instructions: "Help the user.",
            ...(modelBindingId ? { modelBindingId } : {}),
            userSelectableModelBindingIds,
            reasoningEffort: "high",
            modelReasoningEfforts: { terra: "low" },
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
            reasoningEfforts: ["low", "high"],
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
    const list = (markup: string) =>
      /<fieldset[^>]*><legend[^>]*>Models<\/legend>.*?<\/fieldset>/u.exec(markup)?.[0] ?? "";
    // Per control: the model, the option, its value or checked state, and whether it is disabled.
    const rows = (markup: string) =>
      [
        ...list(markup).matchAll(
          /<input[^>]*aria-label="([^"]*): ([^"]*)"[^>]*>|<select[^>]*aria-label="([^"]*): ([^"]*)"[^>]*>(.*?)<\/select>/gu
        )
      ].map(([control, model, option, effortModel, effortOption, options]) =>
        [
          model ?? effortModel,
          option ?? effortOption,
          options === undefined
            ? control.includes('checked=""')
              ? "checked"
              : ""
            : (/<option value="([^"]*)" selected="">/u.exec(options)?.[1] ?? ""),
          /^<[^>]*disabled=""/u.test(control) ? "disabled" : ""
        ].join("|")
      );

    const editable = render(true, "sol", ["terra", "retired"]);
    expect(rows(editable)).toEqual([
      "Instance default|Default||",
      "GPT-5.6 Sol|Default|checked|",
      // The default model is always available to users.
      "GPT-5.6 Sol|Selectable by users|checked|disabled",
      "GPT-5.6 Sol|Reasoning effort|high|",
      "GPT-5.6 Terra|Default||",
      "GPT-5.6 Terra|Selectable by users|checked|",
      "GPT-5.6 Terra|Reasoning effort|low|",
      // A model that is not in use has no effort control.
      "GPT-5.6 Luna|Default||",
      "GPT-5.6 Luna|Selectable by users||"
    ]);
    // The effort lives in the list only.
    expect(editable.match(/<select/gu)).toHaveLength(2);
    expect(list(editable)).not.toContain("retired");
    expect(list(editable)).toContain(
      "Users only see a model selector in the chat when at least one additional model is ticked."
    );

    // On the instance default every binding can still be offered.
    expect(rows(render(true, "", ["luna"])).slice(0, 4)).toEqual([
      "Instance default|Default|checked|",
      "Instance default|Reasoning effort|high|",
      "GPT-5.6 Sol|Default||",
      "GPT-5.6 Sol|Selectable by users||"
    ]);

    // Without the permission: only the default and the offered models, all read-only.
    expect(rows(render(false, "sol", ["terra"]))).toEqual([
      "GPT-5.6 Sol|Default|checked|disabled",
      "GPT-5.6 Sol|Selectable by users|checked|disabled",
      "GPT-5.6 Sol|Reasoning effort|high|disabled",
      "GPT-5.6 Terra|Default||disabled",
      "GPT-5.6 Terra|Selectable by users|checked|disabled",
      "GPT-5.6 Terra|Reasoning effort|low|disabled"
    ]);
    expect(rows(render(false, "", []))).toEqual([
      "Instance default|Default|checked|disabled",
      "Instance default|Reasoning effort|high|disabled"
    ]);
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
    { id: "ws_sales", name: "Sales", createdAt: "2026-06-27T00:00:00.000Z" },
    { id: "ws_legal", name: "Legal", createdAt: "2026-06-27T00:00:00.000Z" }
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
