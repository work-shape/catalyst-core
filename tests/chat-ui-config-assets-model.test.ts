import { describe, expect, it } from "vitest";
import {
  agentAvailabilityFormsEqual,
  agentAvailabilitySummary,
  agentAvailabilityToForm,
  agentConfigToForm,
  agentFormToConfig,
  agentModelRows,
  configAssetMutationErrorMessage,
  editedAgentConfig,
  localizedToPair,
  pairToLocalized,
  selectAgentModelBinding,
  setAgentModelReasoningEffort,
  setAgentModelUserSelectable,
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

  it("round-trips fast mode and clears it when the selected binding does not support it", () => {
    const config = {
      name: "a",
      displayName: "Agent",
      instructions: "x",
      modelBindingId: "fast",
      fastMode: true,
      toolNames: [],
      skillNames: [],
      initialPrompts: []
    };
    const form = agentConfigToForm(config);

    expect(agentFormToConfig(form)).toEqual(config);
    expect(agentFormToConfig({ ...form, fastMode: false })).not.toHaveProperty("fastMode");
    const modelBindingIds = ["fast", "alsoFast", "plain"];
    expect(
      selectAgentModelBinding(form, "alsoFast", {
        fastModeModelBindingIds: ["fast", "alsoFast"],
        modelBindingIds
      })
    ).toMatchObject({ modelBindingId: "alsoFast", fastMode: true });
    expect(
      selectAgentModelBinding(form, "plain", { fastModeModelBindingIds: ["fast"], modelBindingIds })
    ).toMatchObject({ modelBindingId: "plain", fastMode: false });
  });

  describe("agent model list", () => {
    const modelBindings = [
      { id: "sol", model: "gpt-5.6-sol" },
      { id: "terra", model: "gpt-5.6-terra" },
      { id: "luna", model: "gpt-5.6-luna" }
    ];
    const references = {
      fastModeModelBindingIds: [],
      modelBindingIds: modelBindings.map((binding) => binding.id)
    };
    const formFor = (modelBindingId: string, userSelectableModelBindingIds: string[]) =>
      agentConfigToForm({
        name: "assistant",
        displayName: "Assistant",
        instructions: "Help the user.",
        ...(modelBindingId ? { modelBindingId } : {}),
        userSelectableModelBindingIds
      });
    const state = (form: ReturnType<typeof formFor>) =>
      agentModelRows(form, modelBindings).map((row) => [
        row.bindingId,
        row.isDefault ? "default" : "",
        row.userSelectable ? "offered" : ""
      ]);

    it("lists every binding with the default always offered", () => {
      expect(state(formFor("sol", ["terra"]))).toEqual([
        ["sol", "default", "offered"],
        ["terra", "", "offered"],
        ["luna", "", ""]
      ]);
      // On the instance default no binding is the default.
      expect(state(formFor("", ["luna"]))).toEqual([
        ["sol", "", ""],
        ["terra", "", ""],
        ["luna", "", "offered"]
      ]);
      // A default that is no longer a usable binding keeps a row.
      expect(state(formFor("retired", []))).toContainEqual(["retired", "default", "offered"]);
    });

    it("keeps the other models' state when the default changes", () => {
      const moved = selectAgentModelBinding(formFor("sol", ["terra"]), "luna", references);
      // The previous default was only offered implicitly, so it is no longer offered.
      expect(state(moved)).toEqual([
        ["sol", "", ""],
        ["terra", "", "offered"],
        ["luna", "default", "offered"]
      ]);
      expect(agentFormToConfig(moved)).toMatchObject({
        modelBindingId: "luna",
        userSelectableModelBindingIds: ["terra"]
      });

      // A listed model that becomes the default is not stored in the list, and is offered
      // again when the default moves on.
      const promoted = selectAgentModelBinding(formFor("sol", ["terra"]), "terra", references);
      expect(agentFormToConfig(promoted)).not.toHaveProperty("userSelectableModelBindingIds");
      expect(state(selectAgentModelBinding(promoted, "sol", references))).toEqual(
        state(formFor("sol", ["terra"]))
      );
    });

    it("keeps each model's reasoning effort with its row when the default changes", () => {
      const form = agentConfigToForm({
        name: "assistant",
        displayName: "Assistant",
        instructions: "Help the user.",
        modelBindingId: "sol",
        reasoningEffort: "high",
        userSelectableModelBindingIds: ["terra"],
        modelReasoningEfforts: { terra: "low" }
      });
      const efforts = (state: typeof form) =>
        Object.fromEntries(
          agentModelRows(state, modelBindings).map((row) => [row.bindingId, row.reasoningEffort])
        );
      expect(efforts(form)).toEqual({ sol: "high", terra: "low", luna: "" });

      // Terra becomes the default: its effort is the agent's, Sol's leaves with Sol.
      const toTerra = selectAgentModelBinding(form, "terra", references);
      expect(efforts(toTerra)).toEqual(efforts(form));
      expect(agentFormToConfig(toTerra)).toMatchObject({
        modelBindingId: "terra",
        reasoningEffort: "low"
      });
      // Sol was only offered implicitly, so nothing of it is saved until it is ticked.
      expect(agentFormToConfig(toTerra)).not.toHaveProperty("modelReasoningEfforts");
      expect(
        agentFormToConfig(
          setAgentModelUserSelectable(toTerra, "sol", true, references.modelBindingIds)
        )
      ).toMatchObject({
        userSelectableModelBindingIds: ["sol"],
        modelReasoningEfforts: { sol: "high" }
      });
      // Moving back restores the loaded config exactly.
      expect(agentFormToConfig(selectAgentModelBinding(toTerra, "sol", references))).toEqual(
        agentFormToConfig(form)
      );
      // A default without an effort of its own leaves `reasoningEffort` unset.
      expect(
        agentFormToConfig(selectAgentModelBinding(form, "luna", references))
      ).not.toHaveProperty("reasoningEffort");
      // The instance default has an effort like any other default.
      const toInstance = selectAgentModelBinding(form, "", references);
      expect(
        agentFormToConfig(setAgentModelReasoningEffort(toInstance, "", "medium"))
      ).toMatchObject({ reasoningEffort: "medium", modelReasoningEfforts: { terra: "low" } });
    });

    it("sets an effort per row and saves it only for offered models", () => {
      const form = formFor("sol", ["terra"]);
      const edited = setAgentModelReasoningEffort(
        setAgentModelReasoningEffort(
          setAgentModelReasoningEffort(form, "sol", "high"),
          "terra",
          "low"
        ),
        "luna",
        "xhigh"
      );
      expect(agentFormToConfig(edited)).toMatchObject({
        reasoningEffort: "high",
        modelReasoningEfforts: { terra: "low" }
      });
      // Unticking drops the effort on save; re-ticking within the edit restores it.
      const unticked = setAgentModelUserSelectable(
        edited,
        "terra",
        false,
        references.modelBindingIds
      );
      expect(agentFormToConfig(unticked)).not.toHaveProperty("modelReasoningEfforts");
      expect(
        agentFormToConfig(
          setAgentModelUserSelectable(unticked, "terra", true, references.modelBindingIds)
        )
      ).toMatchObject({ modelReasoningEfforts: { terra: "low" } });
      // "Model default" removes the entry.
      expect(
        agentFormToConfig(setAgentModelReasoningEffort(edited, "terra", ""))
      ).not.toHaveProperty("modelReasoningEfforts");
    });

    it("ticks and unticks a model and drops ids of bindings that no longer exist", () => {
      const form = formFor("sol", ["terra", "retired"]);
      const ticked = setAgentModelUserSelectable(form, "luna", true, references.modelBindingIds);
      expect(ticked.userSelectableModelBindingIds).toEqual(["terra", "luna"]);
      expect(
        setAgentModelUserSelectable(ticked, "terra", false, references.modelBindingIds)
          .userSelectableModelBindingIds
      ).toEqual(["luna"]);
      expect(
        selectAgentModelBinding(form, "luna", references).userSelectableModelBindingIds
      ).toEqual(["terra"]);
    });
  });

  it("round-trips the models users may choose and omits an empty list", () => {
    const config = {
      name: "assistant",
      displayName: "Assistant",
      instructions: "Help the user.",
      modelBindingId: "sol",
      userSelectableModelBindingIds: ["terra", "luna"],
      toolNames: [],
      skillNames: [],
      initialPrompts: []
    };
    const form = agentConfigToForm(config);

    expect(form.userSelectableModelBindingIds).toEqual(["terra", "luna"]);
    expect(agentFormToConfig(form)).toEqual(config);
    expect(agentFormToConfig({ ...form, userSelectableModelBindingIds: [] })).not.toHaveProperty(
      "userSelectableModelBindingIds"
    );
  });

  it("keeps the stored value of every field the form left untouched", () => {
    // Shapes the form would normalise: equal locales, surrounding whitespace, an empty prompt.
    const stored = {
      name: "assistant",
      displayName: { de: "FIONA", en: "FIONA" },
      description: { de: "Assistentin. ", en: "Assistant." },
      welcomeMessage: { de: "Wie kann ich helfen?", en: "How can I help?" },
      instructions: "Help the user.",
      modelBindingId: "sol",
      toolNames: [],
      skillNames: [],
      initialPrompts: [
        { prompt: { de: "Prüfe.", en: "Check." }, title: "Check" },
        { title: "", prompt: "" }
      ]
    };
    const form = agentConfigToForm(stored);

    expect(
      editedAgentConfig({ ...form, userSelectableModelBindingIds: ["terra"] }, stored)
    ).toEqual({ ...stored, userSelectableModelBindingIds: ["terra"] });
    // An edited field is saved in the form's shape; a new agent has nothing to keep.
    expect(editedAgentConfig({ ...form, description: { en: "New", de: "New" } }, stored)).toEqual({
      ...stored,
      description: "New"
    });
    expect(editedAgentConfig(form, undefined)).toEqual(agentFormToConfig(form));
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

    expect(configAssetMutationErrorMessage(error, "Not saved")).toBe(
      "Agent 'research_assistant' references skills but does not allow 'read_skill'"
    );
  });

  it("surfaces the server's refusal to hide the default agent", () => {
    expect(
      configAssetMutationErrorMessage(
        new Error("Default agent 'assistant' must be available in all workspaces"),
        "Not saved"
      )
    ).toBe("Default agent 'assistant' must be available in all workspaces");
  });

  it("falls back to the caller's translated message when the server sent none", () => {
    expect(configAssetMutationErrorMessage(undefined, "Nicht gespeichert")).toBe(
      "Nicht gespeichert"
    );
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
