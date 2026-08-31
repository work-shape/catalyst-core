import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import type { CollaborationWorkspaceWithRole } from "@vivd-catalyst/api-client";
import { describe, expect, it } from "vitest";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import {
  CollaborationWorkspaceSelector,
  CollaborationWorkspaceSelectorMenu
} from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-selector";

const noop = () => undefined;

function collaborationWorkspace(
  overrides: Partial<CollaborationWorkspaceWithRole> & Pick<CollaborationWorkspaceWithRole, "id">
): CollaborationWorkspaceWithRole {
  return {
    clientInstanceId: "client",
    kind: "shared",
    name: "Workspace",
    description: null,
    visibility: "discoverable",
    emoji: null,
    accentColor: null,
    personalUserId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    role: "member",
    pendingAccessRequestCount: 0,
    ...overrides
  };
}

const personal = collaborationWorkspace({
  id: "cw_personal",
  kind: "personal",
  name: "Server side personal name",
  visibility: "private",
  personalUserId: "user_1",
  role: "owner"
});

function renderMenu(
  collaborationWorkspaces: CollaborationWorkspaceWithRole[],
  activeCollaborationWorkspaceId?: string
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale: "de" },
      createElement(CollaborationWorkspaceSelectorMenu, {
        collaborationWorkspaces,
        activeCollaborationWorkspaceId,
        userLabel: "Felix Pahlke",
        loading: false,
        loadFailed: false,
        onSelectCollaborationWorkspace: noop,
        onOpenCollaborationWorkspaceSettings: noop,
        onBrowseCollaborationWorkspaces: noop,
        onCreateCollaborationWorkspace: noop
      })
    )
  );
}

describe("collaboration workspace selector", () => {
  it("shows the fixed personal label with its marker instead of the stored name", () => {
    const markup = renderMenu([personal]);

    expect(markup).toContain("Persönlicher Arbeitsbereich");
    expect(markup).toContain("Persönlich");
    expect(markup).not.toContain("Server side personal name");
    expect(markup).toContain("Noch keine geteilten Arbeitsbereiche.");
  });

  it("lists shared workspaces alphabetically after the personal workspace", () => {
    const markup = renderMenu([
      personal,
      collaborationWorkspace({ id: "cw_z", name: "Zebra" }),
      collaborationWorkspace({ id: "cw_a", name: "Alpaka" })
    ]);

    expect(markup.indexOf("Persönlicher Arbeitsbereich")).toBeLessThan(markup.indexOf("Alpaka"));
    expect(markup.indexOf("Alpaka")).toBeLessThan(markup.indexOf("Zebra"));
  });

  it("offers the settings action to owners and admins only, with a pending-request badge", () => {
    const markup = renderMenu([
      personal,
      collaborationWorkspace({
        id: "cw_owned",
        name: "Owned",
        role: "owner",
        pendingAccessRequestCount: 3
      }),
      collaborationWorkspace({ id: "cw_admin", name: "Administered", role: "admin" }),
      collaborationWorkspace({ id: "cw_member", name: "Joined", role: "member" })
    ]);

    expect(markup).toContain('aria-label="Einstellungen für Owned"');
    expect(markup).toContain('aria-label="Einstellungen für Administered"');
    expect(markup).not.toContain('aria-label="Einstellungen für Joined"');
    expect(markup).toContain('aria-label="3 offene Zugriffsanfragen"');
  });

  it("never offers a settings action for the personal workspace", () => {
    const markup = renderMenu([personal]);

    expect(markup).not.toContain("Einstellungen für");
  });

  it("marks the active workspace row", () => {
    const markup = renderMenu(
      [personal, collaborationWorkspace({ id: "cw_active", name: "Active" })],
      "cw_active"
    );

    expect(markup).toContain('data-active="true"');
    expect(markup).toContain('aria-current="true"');
  });

  it("reports a failed workspace load instead of an empty list", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "de" },
        createElement(CollaborationWorkspaceSelectorMenu, {
          collaborationWorkspaces: [],
          activeCollaborationWorkspaceId: undefined,
          userLabel: "Felix Pahlke",
          loading: false,
          loadFailed: true,
          onSelectCollaborationWorkspace: noop,
          onOpenCollaborationWorkspaceSettings: noop,
          onBrowseCollaborationWorkspaces: noop,
          onCreateCollaborationWorkspace: noop
        })
      )
    );

    expect(markup).toContain("Arbeitsbereiche konnten nicht geladen werden.");
  });

  it("keeps the trigger closed until it is used", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "en" },
        createElement(CollaborationWorkspaceSelector, {
          collaborationWorkspaces: [personal],
          activeCollaborationWorkspaceId: "cw_personal",
          userLabel: "Felix Pahlke",
          loading: false,
          loadFailed: false,
          onSelectCollaborationWorkspace: noop,
          onOpenCollaborationWorkspaceSettings: noop,
          onBrowseCollaborationWorkspaces: noop,
          onCreateCollaborationWorkspace: noop
        })
      )
    );

    expect(markup).toContain('aria-label="Switch workspace"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Personal workspace");
    expect(markup).not.toContain("Browse workspaces");
  });
});
