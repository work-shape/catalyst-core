import { createElement, type ReactNode } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import type { SafeConfig } from "@vivd-catalyst/api-client";
import { describe, expect, it } from "vitest";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import { CollaborationWorkspaceSelector } from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-selector";
import { WorkspaceRail } from "../packages/chat-ui/src/workspace/workspace-rail";
import { collaborationWorkspaceChromeVisibleFor } from "../packages/chat-ui/src/workspace/workspace-chat-model";

const noop = () => undefined;

describe("workspace rail branding", () => {
  it("uses in-app navigation for the client logo", () => {
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
          collaborationWorkspaceSelector: null,
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
          onRenameConversation: async () => undefined,
          onDeleteConversation: noop
        })
      )
    );

    expect(markup).toContain('<button type="button"');
    expect(markup).not.toContain('href="/"');
    expect(markup).toContain('aria-label="Musterfinanz"');
    expect(markup).toContain('src="/assets/musterfinanz.svg"');
  });

  it("uses the customer initial when no logo is configured", () => {
    const config = {
      ui: {
        clientName: "Musterfinanz",
        title: "Musterfinanz Chat"
      }
    } as SafeConfig;

    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "de" },
        createElement(WorkspaceRail, {
          config,
          collaborationWorkspaceSelector: null,
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
          onRenameConversation: async () => undefined,
          onDeleteConversation: noop
        })
      )
    );

    expect(markup).toContain(">F</span>");
    expect(markup).not.toContain("Vivd Catalyst");
    expect(markup).not.toContain("lucide-shield");
  });
});

const railConfig = {
  ui: { clientName: "Musterfinanz", title: "Musterfinanz Chat" }
} as SafeConfig;

function renderRail(collaborationWorkspaceSelector?: ReactNode): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale: "en" },
      createElement(WorkspaceRail, {
        config: railConfig,
        collaborationWorkspaceSelector,
        conversations: [],
        selectedConversationId: undefined,
        canViewAdministration: false,
        view: "chat",
        creatingConversation: false,
        deletingConversation: false,
        canMoveConversation: false,
        userMenu: null,
        onToggleSidebar: noop,
        onViewChange: noop,
        onCreateConversation: noop,
        onSelectConversation: noop,
        onRenameConversation: async () => undefined,
        onMoveConversation: noop,
        onDeleteConversation: noop
      })
    )
  );
}

const selector = createElement(CollaborationWorkspaceSelector, {
  collaborationWorkspaces: [],
  activeCollaborationWorkspaceId: undefined,
  userLabel: "Felix Pahlke",
  loading: false,
  loadFailed: false,
  onSelectCollaborationWorkspace: noop,
  onOpenCollaborationWorkspaceSettings: noop,
  onBrowseCollaborationWorkspaces: noop,
  onCreateCollaborationWorkspace: noop
});

describe("workspace rail collaboration workspace slot", () => {
  it("falls back to the pre-feature layout when no selector is supplied", () => {
    const markup = renderRail();

    expect(markup).toContain("grid-rows-[auto_auto_minmax(0,1fr)_auto]");
    expect(markup).not.toContain('aria-label="Switch workspace"');
    // The branding row and its own collapse toggle stay exactly as they were.
    expect(markup).toContain("Musterfinanz");
    expect(markup).toContain(">F</span>");
    expect(markup).toContain("absolute right-4 top-4");
    expect(markup).toContain('aria-label="Close sidebar"');
  });

  it("lets the selector replace the branding row for a first-party session", () => {
    const markup = renderRail(selector);

    expect(markup).toContain("grid-rows-[auto_auto_minmax(0,1fr)_auto]");
    expect(markup).toContain('aria-label="Switch workspace"');
    // Direction A: no standalone branding row — the client identity moved into
    // the selector popover, which is closed here.
    expect(markup).not.toContain("Musterfinanz");
    expect(markup).not.toContain(">F</span>");
    // The collapse toggle rides along in the selector row instead.
    expect(markup).toContain('aria-label="Close sidebar"');
    expect(markup).not.toContain("absolute right-4 top-4");
    expect(markup).toContain('aria-label="Collapse sidebar"');
  });
});

describe("collaboration workspace chrome feature flag", () => {
  function configWithCollaborationWorkspaces(enabled: boolean): SafeConfig {
    return {
      ...railConfig,
      features: { collaborationWorkspaces: { enabled } }
    } as SafeConfig;
  }

  // The chrome is composed from one boolean: the rail selector, the dialogs
  // panel and the conversation move action all read it.
  function firstPartyChromeVisible(enabled: boolean): boolean {
    return collaborationWorkspaceChromeVisibleFor({
      collaborationWorkspacesAvailable: true,
      config: configWithCollaborationWorkspaces(enabled)
    });
  }

  it("hides the workspace chrome from a first-party session while the feature is off", () => {
    expect(firstPartyChromeVisible(false)).toBe(false);

    const markup = renderRail(firstPartyChromeVisible(false) ? selector : undefined);

    expect(markup).toContain("grid-rows-[auto_auto_minmax(0,1fr)_auto]");
    expect(markup).not.toContain('aria-label="Switch workspace"');
    // Zero visual change for a non-workspace instance: branding row intact.
    expect(markup).toContain("Musterfinanz");
    // The rail itself keeps working: conversations, search and the new-chat
    // action stay exactly as they are without the feature.
    expect(markup).toContain('aria-label="Conversations"');
    expect(markup).toContain('aria-label="Search conversations"');
  });

  it("shows the workspace chrome once the feature is enabled", () => {
    expect(firstPartyChromeVisible(true)).toBe(true);

    const markup = renderRail(firstPartyChromeVisible(true) ? selector : undefined);

    expect(markup).toContain("grid-rows-[auto_auto_minmax(0,1fr)_auto]");
    expect(markup).toContain('aria-label="Switch workspace"');
    expect(markup).not.toContain("Musterfinanz");
  });

  it("keeps embedded sessions chrome-free whatever the feature flag says", () => {
    expect(
      collaborationWorkspaceChromeVisibleFor({
        collaborationWorkspacesAvailable: false,
        config: configWithCollaborationWorkspaces(true)
      })
    ).toBe(false);
  });

  it("withholds the chrome until the config has loaded", () => {
    expect(
      collaborationWorkspaceChromeVisibleFor({
        collaborationWorkspacesAvailable: true,
        config: undefined
      })
    ).toBe(false);
  });
});
