import { describe, expect, it } from "vitest";
import {
  agentConfigToForm,
  agentFormToConfig,
  configAssetMutationErrorMessage,
  localizedToPair,
  pairToLocalized,
  skillConfigToForm,
  skillFormToConfig
} from "../packages/chat-ui/src/config-assets-model";

describe("config assets form model", () => {
  it("round-trips a full agent config through the form state", () => {
    const config = {
      name: "workflow_assistant",
      displayName: { de: "Workflow-Assistent", en: "Workflow Assistant" },
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
    form.model = "binding:fast";

    const config = agentFormToConfig(form);
    expect(config.modelBindingId).toBe("fast");
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
    expect(config.initialPrompts).toEqual([
      { title: { en: "Keep" }, prompt: { en: "Do it" } }
    ]);
  });

  it("round-trips a skill config", () => {
    const config = {
      name: "review",
      title: "Review",
      description: "How to review",
      content: "# Steps\n1. Read."
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
});
