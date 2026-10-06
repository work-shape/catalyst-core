import { describe, expect, it } from "vitest";
import { agentModelSelection } from "../packages/chat-ui/src/workspace/agent-model-selection";

const own = { bindingId: "sol", model: "gpt-5.6-sol" };
const terra = { bindingId: "terra", model: "gpt-5.6-terra" };
const chooser = { selectableModels: [own, terra] };
const fixed = { selectableModels: [{ bindingId: "luna", model: "gpt-5.6-luna" }] };

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
    expect(selection.selectedModel).toEqual({ bindingId: "luna", model: "gpt-5.6-luna" });
  });

  it("selects the own model of an agent on a provider default, which has no binding id", () => {
    const providerDefault = { selectableModels: [{ model: "provider-model" }, terra] };
    expect(agentModelSelection(providerDefault, undefined).selectedModel).toEqual({
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
});
