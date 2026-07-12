import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import type { SafeConfig } from "@vivd-catalyst/api-client";
import { describe, expect, it } from "vitest";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import { WorkspaceRail } from "../packages/chat-ui/src/workspace-rail";

const noop = () => undefined;

describe("workspace rail branding", () => {
  it("links the client logo to the application root", () => {
    const config = {
      ui: {
        clientName: "Musterfinanz",
        logoUrl: "/assets/musterfinanz.svg"
      }
    } as SafeConfig;

    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "de" },
        createElement(WorkspaceRail, {
          config,
          conversations: [],
          selectedConversationId: undefined,
          canViewAdministration: false,
          view: "chat",
          creatingConversation: false,
          deletingConversation: false,
          userMenu: null,
          onToggleSidebar: noop,
          onViewChange: noop,
          onCreateConversation: noop,
          onSelectConversation: noop,
          onDeleteConversation: noop
        })
      )
    );

    expect(markup).toContain('<a class="');
    expect(markup).toContain('href="/"');
    expect(markup).toContain('aria-label="Musterfinanz"');
    expect(markup).toContain('src="/assets/musterfinanz.svg"');
  });
});
