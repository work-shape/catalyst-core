import { createElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { AgentAvailabilityEditor } from "@vivd-catalyst/chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    createElement(TranslationProvider, { children: null, locale: "en" }, element)
  );
}

describe("agent availability", () => {
  const workspaces = [
    { id: "ws_sales", name: "Sales", createdAt: "2026-06-27T00:00:00.000Z" },
    { id: "ws_legal", name: "Legal", createdAt: "2026-06-27T00:00:00.000Z" }
  ];
  const stored = async () => undefined;

  it("offers personal and shared workspaces for a selectively available agent", () => {
    const markup = render(
      createElement(AgentAvailabilityEditor, {
        availability: {
          mode: "selected",
          personalWorkspaces: true,
          collaborationWorkspaceIds: ["ws_legal"]
        },
        isDefault: false,
        workspaces,
        mutating: false,
        onSave: stored
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
    const markup = render(
      createElement(AgentAvailabilityEditor, {
        availability: { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] },
        isDefault: true,
        workspaces,
        mutating: false,
        onSave: stored
      })
    );

    expect(markup).toMatch(/<div role="radiogroup"[^>]*data-disabled=""/u);
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("The default agent is always available in all workspaces.");
    expect(markup).not.toContain("Save availability");
  });

  it("warns that an agent without any selection is hidden", () => {
    const markup = render(
      createElement(AgentAvailabilityEditor, {
        availability: undefined,
        isDefault: false,
        workspaces: [],
        mutating: false,
        onSave: stored
      })
    );

    expect(markup).toContain("There are no shared workspaces yet.");
    expect(markup).toContain("this agent is not available in any workspace");
  });

  it("says why the shared workspaces could not be listed", () => {
    const markup = render(
      createElement(AgentAvailabilityEditor, {
        availability: undefined,
        isDefault: false,
        workspaces: [],
        workspacesError: "The workspaces could not be read.",
        mutating: false,
        onSave: stored
      })
    );

    expect(markup).toContain("The workspaces could not be read.");
    expect(markup).not.toContain("There are no shared workspaces yet.");
  });
});
