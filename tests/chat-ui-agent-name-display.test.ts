import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import { describe, expect, it } from "vitest";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import { WorkspaceChrome } from "../packages/chat-ui/src/workspace/workspace-chrome";

const noop = () => undefined;

const agents = [
  {
    name: "catalyst_assistant",
    displayName: "Catalyst Assistant",
    initialPrompts: []
  }
];

function renderChrome(showAgentName: boolean) {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale: "en" as const },
      createElement(WorkspaceChrome, {
        agents,
        contextLabel: "Vivd Catalyst",
        displayPanelOpen: false,
        displayPanelWidth: 0,
        environment: "production" as const,
        sidebarOpen: false,
        selectedAgentName: "catalyst_assistant",
        showAgentName,
        themeMode: "light" as const,
        onSelectAgent: noop,
        onToggleSidebar: noop,
        onToggleTheme: noop
      })
    )
  );
}

describe("agent selector name display", () => {
  it("shows the agent and client name when enabled", () => {
    const markup = renderChrome(true);

    expect(markup).toContain("Catalyst Assistant");
    expect(markup).toContain("Vivd Catalyst");
  });

  it("collapses to an icon-only control when disabled", () => {
    const markup = renderChrome(false);

    expect(markup).toContain('aria-label="Select agent"');
    expect(markup).toContain('title="Catalyst Assistant"');
    // The names only exist as the tooltip, never as rendered label text.
    expect(markup).not.toContain(">Catalyst Assistant<");
    expect(markup).not.toContain(">Vivd Catalyst<");
  });
});
