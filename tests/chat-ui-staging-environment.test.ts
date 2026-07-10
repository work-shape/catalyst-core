import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import { describe, expect, it } from "vitest";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import { WorkspaceChrome } from "../packages/chat-ui/src/workspace-chrome";
import { createEnvironmentDocumentTitle } from "../packages/chat-ui/src/workspace-utils";

const noop = () => undefined;

function renderWorkspaceChrome(environment: string, locale: "de" | "en" = "de") {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale },
      createElement(WorkspaceChrome, {
        agents: [],
        displayPanelOpen: false,
        environment,
        sidebarOpen: false,
        selectedAgentName: undefined,
        themeMode: "light",
        onSelectAgent: noop,
        onToggleSidebar: noop,
        onToggleTheme: noop
      })
    )
  );
}

describe("staging environment banner", () => {
  it("shows only the localized test-environment label in staging", () => {
    const markup = renderWorkspaceChrome("staging");

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Testumgebung");
    expect(markup).not.toContain("Echtdaten");
  });

  it.each(["development", "production"])("stays hidden in %s", (environment) => {
    const markup = renderWorkspaceChrome(environment);

    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain("Testumgebung");
  });
});

describe("environment document title", () => {
  it("prefixes staging titles with the user-facing test label", () => {
    expect(createEnvironmentDocumentTitle("Musterfinanz", "staging")).toBe(
      "(Test) Musterfinanz"
    );
  });

  it.each(["development", "production", undefined])(
    "leaves titles unchanged in %s",
    (environment) => {
      expect(createEnvironmentDocumentTitle("Musterfinanz", environment)).toBe(
        "Musterfinanz"
      );
    }
  );
});
