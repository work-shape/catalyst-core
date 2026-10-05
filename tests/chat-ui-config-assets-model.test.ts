import { describe, expect, it } from "vitest";
import {
  agentAvailabilityFormsEqual,
  agentAvailabilitySummary,
  agentAvailabilityToForm,
  agentConfigToForm,
  agentFormToConfig,
  configAssetMutationErrorMessage,
  localizedToPair,
  pairToLocalized,
  skillConfigToForm,
  skillFormToConfig
} from "../packages/chat-ui/src/control-plane/config-assets-model";

describe("config assets form model", () => {
  it("round-trips a full agent config through the form state", () => {
    const config = {
      name: "workflow_assistant",
      displayName: { de: "Workflow-Assistent", en: "Workflow Assistant" },
      description: { de: "Hilfe beim Workflow.", en: "Help with the workflow." },
      welcomeMessage: { de: "Wie kann ich helfen?", en: "How can I help?" },
      instructions: "Help the user.\nBe concise.",
      modelProviderId: "openai",
      maxSteps: 32,
      toolNames: ["read_skill", "show_view"],
      skillNames: ["generic_workflow_review"],
      initialPrompts: [
        {
          title: { de: "Wetter", en: "Weather" },
          prompt: { de: "Prüfe das Wetter.", en: "Check the weather." }
        }
      ]
    };

    expect(agentFormToConfig(agentConfigToForm(config))).toEqual(config);
  });

  it("maps a model binding selection to modelBindingId only", () => {
    const form = agentConfigToForm({
      name: "a",
      displayName: "Agent",
      instructions: "x",
      toolNames: [],
      skillNames: [],
      initialPrompts: []
    });
    form.modelBindingId = "fast";
    form.reasoningEffort = "xhigh";

    const config = agentFormToConfig(form);
    expect(config.modelBindingId).toBe("fast");
    expect(config.reasoningEffort).toBe("xhigh");
    expect(config).not.toHaveProperty("modelProviderId");
  });

  it("collapses identical locales to a plain string and drops empty localized fields", () => {
    expect(pairToLocalized({ en: "Same", de: "Same" })).toBe("Same");
    expect(pairToLocalized({ en: "Only English", de: "" })).toEqual({ en: "Only English" });
    expect(pairToLocalized({ en: " ", de: "" })).toBeUndefined();
    expect(localizedToPair("Plain")).toEqual({ en: "Plain", de: "Plain" });
  });

  it("drops fully empty initial prompts on save", () => {
    const form = agentConfigToForm({
      name: "a",
      displayName: "Agent",
      instructions: "x",
      toolNames: [],
      skillNames: [],
      initialPrompts: []
    });
    form.initialPrompts = [
      { title: { en: "", de: "" }, prompt: { en: "", de: "" } },
      { title: { en: "Keep", de: "" }, prompt: { en: "Do it", de: "" } }
    ];

    const config = agentFormToConfig(form);
    expect(config.initialPrompts).toEqual([{ title: { en: "Keep" }, prompt: { en: "Do it" } }]);
  });

  it("round-trips a skill config", () => {
    const config = {
      name: "review",
      title: "Review",
      description: "How to review",
      content: "# Steps\n1. Read.",
      resources: [
        {
          path: "references/checks.md",
          mediaType: "text/markdown",
          content: "# Checks"
        }
      ]
    };
    expect(skillFormToConfig(skillConfigToForm(config))).toEqual(config);
  });

  it("surfaces config validation issues instead of the generic API message", () => {
    const error = Object.assign(new Error("Config asset bundle is invalid"), {
      payload: {
        error: {
          details: {
            issues: [
              {
                message:
                  "Agent 'research_assistant' references skills but does not allow 'read_skill'"
              }
            ]
          }
        }
      }
    });

    expect(configAssetMutationErrorMessage(error)).toBe(
      "Agent 'research_assistant' references skills but does not allow 'read_skill'"
    );
  });

  it("surfaces the server's refusal to hide the default agent", () => {
    expect(
      configAssetMutationErrorMessage(
        new Error("Default agent 'assistant' must be available in all workspaces")
      )
    ).toBe("Default agent 'assistant' must be available in all workspaces");
  });
});

describe("agent availability model", () => {
  const selected = (personalWorkspaces: boolean, collaborationWorkspaceIds: string[]) => ({
    mode: "selected" as const,
    personalWorkspaces,
    collaborationWorkspaceIds
  });

  it("summarises availability for the agent list", () => {
    expect(
      agentAvailabilitySummary({
        mode: "all",
        personalWorkspaces: false,
        collaborationWorkspaceIds: []
      })
    ).toEqual({ kind: "all" });
    expect(agentAvailabilitySummary(selected(false, ["a", "b", "c"]))).toEqual({
      kind: "workspaces",
      count: 3,
      personalWorkspaces: false
    });
    expect(agentAvailabilitySummary(selected(true, ["a"]))).toEqual({
      kind: "workspaces",
      count: 1,
      personalWorkspaces: true
    });
    expect(agentAvailabilitySummary(selected(true, []))).toEqual({ kind: "personal" });
    expect(agentAvailabilitySummary(selected(false, []))).toEqual({ kind: "hidden" });
  });

  it("treats an agent without stored availability as hidden", () => {
    expect(agentAvailabilitySummary(undefined)).toEqual({ kind: "hidden" });
    expect(agentAvailabilityToForm(undefined)).toEqual(selected(false, []));
  });

  it("compares selections regardless of order and ignores them for all workspaces", () => {
    expect(
      agentAvailabilityFormsEqual(selected(true, ["a", "b"]), selected(true, ["b", "a"]))
    ).toBe(true);
    expect(agentAvailabilityFormsEqual(selected(true, ["a"]), selected(false, ["a"]))).toBe(false);
    expect(agentAvailabilityFormsEqual(selected(true, ["a"]), selected(true, ["b"]))).toBe(false);
    expect(
      agentAvailabilityFormsEqual(
        { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] },
        { mode: "all", personalWorkspaces: true, collaborationWorkspaceIds: ["a"] }
      )
    ).toBe(true);
  });
});
