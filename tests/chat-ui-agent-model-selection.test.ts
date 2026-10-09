import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPicker } from "../packages/chat-ui/src/assistant/model-picker";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import {
  agentModelSelection,
  conversationModelPicks,
  modelReasoningEffortSelection,
  type AgentSelectableModel
} from "../packages/chat-ui/src/workspace/agent-model-selection";

const own: AgentSelectableModel = {
  bindingId: "sol",
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
  selectableReasoningEfforts: ["low", "medium", "high"]
};
const terra: AgentSelectableModel = {
  bindingId: "terra",
  model: "gpt-5.6-terra",
  reasoningEffort: "low",
  selectableReasoningEfforts: []
};
const chooser = { selectableModels: [own, terra] };
const fixed = {
  selectableModels: [{ bindingId: "luna", model: "gpt-5.6-luna", selectableReasoningEfforts: [] }]
};

describe("agent model selection", () => {
  it("offers the agent's own model first and uses it without a pick", () => {
    expect(agentModelSelection(chooser, undefined)).toEqual({
      selectableModels: [own, terra],
      selectedModel: own
    });
  });

  it("uses the user's pick while the agent offers it", () => {
    expect(agentModelSelection(chooser, "terra").selectedModel).toEqual(terra);
  });

  it("falls back to the new agent's own model when it does not offer the pick", () => {
    const selection = agentModelSelection(fixed, "terra");
    // A single model renders no selector in the composer.
    expect(selection.selectableModels).toHaveLength(1);
    expect(selection.selectedModel).toMatchObject({ bindingId: "luna", model: "gpt-5.6-luna" });
  });

  it("selects the own model of an agent on a provider default, which has no binding id", () => {
    const providerDefault = {
      selectableModels: [{ model: "provider-model", selectableReasoningEfforts: [] }, terra]
    };
    expect(agentModelSelection(providerDefault, undefined).selectedModel).toMatchObject({
      model: "provider-model"
    });
    expect(agentModelSelection(providerDefault, "terra").selectedModel).toEqual(terra);
  });

  it("offers nothing while the agent is unknown", () => {
    expect(agentModelSelection(undefined, "terra")).toEqual({
      selectableModels: [],
      selectedModel: undefined
    });
  });

  it("requests an effort only when the user moved the model off its default", () => {
    expect(modelReasoningEffortSelection(own, {})).toEqual({
      reasoningEffort: "medium",
      requested: undefined
    });
    expect(modelReasoningEffortSelection(own, { sol: "high" })).toEqual({
      reasoningEffort: "high",
      requested: "high"
    });
    // Back on the default nothing is requested, so a later default change still applies.
    expect(modelReasoningEffortSelection(own, { sol: "medium" }).requested).toBeUndefined();
  });

  it("keeps an effort pick with the model it was made for", () => {
    const picks = { sol: "high", terra: "high" } as const;

    // Terra offers no choice, and "xhigh" is not among the efforts Sol offers.
    expect(modelReasoningEffortSelection(terra, picks)).toEqual({
      reasoningEffort: "low",
      requested: undefined
    });
    expect(modelReasoningEffortSelection(own, { sol: "xhigh" })).toEqual({
      reasoningEffort: "medium",
      requested: undefined
    });
    expect(modelReasoningEffortSelection(undefined, picks)).toEqual({
      reasoningEffort: undefined,
      requested: undefined
    });
  });
});

function renderPicker(models: AgentSelectableModel[]) {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" as const },
      createElement(ModelPicker, {
        models,
        selectedModelBindingId: models[0]?.bindingId,
        reasoningEffort: models[0]?.reasoningEffort,
        onSelectModelBinding: () => undefined,
        onSelectReasoningEffort: () => undefined
      })
    )
  );
}

describe("conversation model picks", () => {
  const userDefault = { modelBindingId: "terra", reasoningEfforts: { sol: "high" as const } };

  it("starts a conversation without a run from the user's default", () => {
    expect(
      conversationModelPicks({
        agent: chooser,
        changed: undefined,
        latestRun: undefined,
        userDefault
      })
    ).toEqual(userDefault);
  });

  it("keeps a conversation on what its latest run used, not on the user's default", () => {
    // The run followed the configured defaults: the agent's own model at its own effort.
    expect(
      conversationModelPicks({ agent: chooser, changed: undefined, latestRun: {}, userDefault })
    ).toEqual({ reasoningEfforts: {} });
    expect(
      conversationModelPicks({
        agent: chooser,
        changed: undefined,
        latestRun: { reasoningEffort: "low" },
        userDefault
      })
    ).toEqual({ reasoningEfforts: { sol: "low" } });
    // Efforts picked for other models stay available when the user switches within it.
    expect(
      conversationModelPicks({
        agent: chooser,
        changed: undefined,
        latestRun: { modelBindingId: "terra" },
        userDefault
      })
    ).toEqual({ modelBindingId: "terra", reasoningEfforts: { sol: "high" } });
  });

  it("lets a change made in the open conversation win over its latest run", () => {
    const changed = { reasoningEfforts: { sol: "low" as const } };
    expect(
      conversationModelPicks({
        agent: chooser,
        changed,
        latestRun: { modelBindingId: "terra" },
        userDefault
      })
    ).toBe(changed);
  });
});

describe("composer model picker", () => {
  it("names the selected model and its effort on the trigger", () => {
    const markup = renderPicker([own, terra]);

    expect(markup).toContain('aria-label="Select model"');
    expect(markup).toContain(">GPT-5.6 Sol<");
    expect(markup).toContain(">Medium<");
    // The list stays closed until asked for.
    expect(markup).not.toContain("GPT-5.6 Terra");
  });

  it("offers a single model only for its reasoning effort", () => {
    expect(renderPicker([own])).toContain(">GPT-5.6 Sol<");
    expect(renderPicker([terra])).toBe("");
    expect(renderPicker([])).toBe("");
  });

  it("leaves the effort off the trigger for a model without a choice", () => {
    const markup = renderPicker([terra, own]);

    expect(markup).toContain(">GPT-5.6 Terra<");
    expect(markup).not.toContain(">Low<");
  });
});
