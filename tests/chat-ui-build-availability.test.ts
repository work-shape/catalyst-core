import { createElement, createRef } from "react";
import { describe, expect, it } from "vitest";
import {
  AgentEditor,
  agentConfigToForm,
  type AgentAvailabilityChoice,
  type BuildAssetEditorProps
} from "@vivd-catalyst/chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// Where an agent can be chosen: a section of the agent's page, named once by its heading and
// saved with the agent through the page's save bar (AGENT-AVAIL-1).

const noop = () => undefined;
const config = {
  name: "assistant",
  displayName: "Assistant",
  instructions: "Help the user.",
  toolNames: [],
  skillNames: [],
  initialPrompts: []
};
const workspaces = [
  { id: "ws_sales", name: "Sales", createdAt: "2026-06-27T00:00:00.000Z" },
  { id: "ws_legal", name: "Legal", createdAt: "2026-06-27T00:00:00.000Z" }
];

function frame(): BuildAssetEditorProps {
  return {
    page: { ref: createRef<HTMLDivElement>(), above: null, shown: noop },
    asset: {
      id: "asset_agent",
      kind: "agent",
      name: config.name,
      scope: { kind: "instance" },
      revision: 3,
      config,
      updatedAt: "2026-10-08T10:00:00.000Z"
    },
    start: undefined,
    canWrite: true,
    instanceWrite: true,
    back: null,
    actions: null,
    notice: null,
    onUnsavedChange: noop,
    save: async () => ({ ok: true })
  };
}

function availabilitySection(
  availability: Partial<AgentAvailabilityChoice>,
  isDefault = false
): string {
  const markup = renderToStaticMarkup(
    createElement(TranslationProvider, {
      locale: "en",
      children: createElement(AgentEditor, {
        frame: frame(),
        initialForm: agentConfigToForm(config),
        isDefault,
        references: undefined,
        editableAgentFields: [],
        canManageAgentModels: false,
        skillChoice: { options: [], onSearch: noop },
        availability: {
          saved: undefined,
          workspaces,
          save: async () => undefined,
          ...availability
        }
      })
    })
  );
  return /<section[^>]*id="availability">.*?<\/section>/u.exec(markup)?.[0] ?? "";
}

describe("agent availability", () => {
  it("is a section of the agent's page, named once, with no save of its own", () => {
    const section = availabilitySection({
      saved: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: ["ws_legal"] }
    });
    // The heading names it; the choice under it is named for a screen reader only.
    expect(section.match(/>Available in</gu)).toHaveLength(2);
    expect(section).toContain('class="sr-only">Available in<');
    expect(section).toContain("Personal workspaces");
    expect(section).toContain("Sales");
    expect(section).toContain("Legal");
    expect(section).not.toContain("ws_legal");
    expect(section.match(/type="checkbox"[^>]*checked=""/gu)).toHaveLength(2);
    expect(section).not.toContain("Save availability");
    expect(section).not.toContain("not available in any workspace");
  });

  it("locks the default agent to all workspaces and explains why", () => {
    const section = availabilitySection(
      { saved: { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] } },
      true
    );
    expect(section).toMatch(/<div role="radiogroup"[^>]*data-disabled=""/u);
    expect(section).toContain("The default agent is always available in all workspaces.");
  });

  it("warns that an agent without any selection is hidden", () => {
    const section = availabilitySection({ workspaces: [] });
    expect(section).toContain("There are no shared workspaces yet.");
    expect(section).toContain("this agent is not available in any workspace");
  });

  it("says why the shared workspaces could not be listed", () => {
    const section = availabilitySection({
      workspaces: [],
      workspacesError: "The workspaces could not be read."
    });
    expect(section).toContain("The workspaces could not be read.");
    expect(section).not.toContain("There are no shared workspaces yet.");
  });
});
