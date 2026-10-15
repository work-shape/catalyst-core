import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { LocaleCode } from "@work-shape/catalyst-api-client";
import {
  AgentUnavailableNotices,
  savedAgentUnavailable
} from "@work-shape/catalyst-chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

type Status = Parameters<typeof AgentUnavailableNotices>[0]["status"];

function notices(status: Status, locale: LocaleCode = "en"): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(AgentUnavailableNotices, { status })
    )
  );
}

describe("the top of an agent's page", () => {
  it("names every unavailable tool, skill and model with its reason in one line", () => {
    const status: Status = {
      chatAvailable: true,
      unavailableTools: [
        { name: "crm.lookup", reason: "unknown_tool" },
        { name: "documents.read", reason: "module_off", module: "documents" }
      ],
      unavailableSkills: [{ name: "tax-old", reason: "unknown_skill" }],
      unavailableModels: [
        { name: "retired", field: "userSelectableModelBindingIds", reason: "unknown_model" }
      ]
    };

    const english = notices(status);
    expect(english).toContain('data-agent-unavailable=""');
    expect(english).toContain('aria-label="Not available"');
    expect(english).toContain("crm.lookup</span> (tool does not exist on this instance), ");
    expect(english).toContain("documents.read</span> (module Documents is off), ");
    expect(english).toContain("tax-old</span> (skill does not exist on this instance), ");
    expect(english).toContain("retired</span> (model does not exist on this instance)</li>");
    // Only the primary model stops the chat: a model people may pick instead does not.
    expect(english).not.toContain("data-agent-chat-unavailable");
    const german = notices(status, "de");
    expect(german).toContain('aria-label="Nicht verfügbar"');
    expect(german).toContain("crm.lookup</span> (Werkzeug gibt es auf dieser Instanz nicht)");
    expect(german).toContain("documents.read</span> (Modul Dokumente ist aus)");
    expect(german).toContain("tax-old</span> (Skill gibt es auf dieser Instanz nicht)");
    expect(german).toContain("retired</span> (Modell gibt es auf dieser Instanz nicht)");
  });

  it("says that the agent cannot chat until its model is changed", () => {
    const blocked = notices(
      {
        chatAvailable: false,
        unavailableModels: [{ name: "removed", field: "modelBindingId", reason: "unknown_model" }]
      },
      "de"
    );

    expect(blocked).toContain("data-agent-chat-unavailable");
    expect(blocked).toContain("Dieser Agent kann nicht chatten");
    expect(blocked).toContain("Bis sein Modell geändert ist, kann niemand mit ihm chatten.");
    expect(blocked).toContain('data-unavailable-reference="model:modelBindingId:removed"');
  });

  it("says nothing of an agent whose references all run, or of a new one", () => {
    expect(
      notices({
        chatAvailable: true,
        unavailableTools: [],
        unavailableSkills: [],
        unavailableModels: []
      })
    ).toBe("");
    expect(notices(undefined)).toBe("");
  });
});

describe("what stays unavailable after a save", () => {
  const status: Status = {
    chatAvailable: false,
    unavailableTools: [{ name: "crm.lookup", reason: "unknown_tool" }],
    unavailableSkills: [{ name: "tax-old", reason: "unknown_skill" }],
    unavailableModels: [
      { name: "removed", field: "modelBindingId", reason: "unknown_model" },
      { name: "retired", field: "userSelectableModelBindingIds", reason: "unknown_model" }
    ]
  };
  const asRead = {
    toolNames: ["crm.lookup", "web.search"],
    skillNames: ["tax-old"],
    modelProviderId: "",
    modelBindingId: "removed",
    userSelectableModelBindingIds: ["retired"]
  };

  it("keeps the report while the saved agent still names what it reports", () => {
    expect(savedAgentUnavailable(status, asRead)).toEqual(status);
  });

  it("drops what a repair save replaced or removed, and lets the agent chat again", () => {
    const repaired = savedAgentUnavailable(status, {
      ...asRead,
      toolNames: ["web.search"],
      skillNames: [],
      modelBindingId: "fast"
    });
    expect(repaired).toEqual({
      chatAvailable: true,
      unavailableTools: [],
      unavailableSkills: [],
      unavailableModels: [
        { name: "retired", field: "userSelectableModelBindingIds", reason: "unknown_model" }
      ]
    });
    const markup = notices(repaired);
    expect(markup).not.toContain("data-agent-chat-unavailable");
    expect(markup).not.toContain("crm.lookup");
    expect(markup).toContain("retired</span> (model does not exist on this instance)");
  });
});
