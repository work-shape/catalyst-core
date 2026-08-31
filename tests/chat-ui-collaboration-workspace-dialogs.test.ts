import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import type {
  CollaborationWorkspaceDirectoryItem,
  CollaborationWorkspaceWithRole,
  WorkspaceMember
} from "@vivd-catalyst/api-client";
import { describe, expect, it } from "vitest";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import { BrowseCollaborationWorkspacesDialog } from "../packages/chat-ui/src/collaboration-workspace/browse-collaboration-workspaces-dialog";
import { CreateCollaborationWorkspaceDialog } from "../packages/chat-ui/src/collaboration-workspace/create-collaboration-workspace-dialog";
import {
  canChangeCollaborationWorkspaceRole,
  canRemoveCollaborationWorkspaceMember,
  CollaborationWorkspaceGeneralTab,
  CollaborationWorkspaceMembersTab,
  CollaborationWorkspaceRequestsTab
} from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-settings-dialog";

const noop = () => undefined;

function render(locale: "de" | "en", element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(TranslationProvider, { locale }, element));
}

const sharedCollaborationWorkspace: CollaborationWorkspaceWithRole = {
  id: "cw_shared",
  clientInstanceId: "client",
  kind: "shared",
  name: "Produktteam",
  description: "Alles rund um das Produkt",
  visibility: "discoverable",
  emoji: "🚀",
  accentColor: "violet",
  personalUserId: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
  role: "owner",
  pendingAccessRequestCount: 1
};

const members: WorkspaceMember[] = [
  { userId: "user_1", displayLabel: "Felix Pahlke", email: "felix@example.com", role: "owner" },
  { userId: "user_2", displayLabel: "Mara Ruiz", email: "mara@example.com", role: "member" }
];

describe("create collaboration workspace dialog", () => {
  it("defaults to a discoverable workspace and offers the curated palette", () => {
    const markup = render(
      "de",
      createElement(CreateCollaborationWorkspaceDialog, {
        open: true,
        pending: false,
        errorMessage: undefined,
        onClose: noop,
        onCreate: noop
      })
    );

    expect(markup).toContain("Arbeitsbereich erstellen");
    expect(markup).toContain("Auffindbar");
    expect(markup).toContain(
      "Alle in dieser Instanz können den Arbeitsbereich finden und Zugriff anfragen."
    );
    expect(markup).toContain("Privat");
    expect(markup).toContain('checked="" value="discoverable"');
    expect(markup).toContain('data-testid="collaboration-workspace-accent-ruby"');
    expect(markup).toContain('data-testid="collaboration-workspace-accent-slate"');
    expect(markup).toContain('aria-label="Vorschläge"');
  });

  it("surfaces the mapped error copy", () => {
    const markup = render(
      "en",
      createElement(CreateCollaborationWorkspaceDialog, {
        open: true,
        pending: false,
        errorMessage: "This change is not allowed.",
        onClose: noop,
        onCreate: noop
      })
    );

    expect(markup).toContain("This change is not allowed.");
  });
});

describe("collaboration workspace settings tabs", () => {
  it("renames, describes and re-themes a shared workspace in General", () => {
    const markup = render(
      "de",
      createElement(CollaborationWorkspaceGeneralTab, {
        collaborationWorkspace: sharedCollaborationWorkspace,
        currentUserId: "user_1",
        members,
        savePending: false,
        membershipPending: false,
        onSave: noop,
        onLeave: noop
      })
    );

    expect(markup).toContain('value="Produktteam"');
    expect(markup).toContain("Alles rund um das Produkt");
    expect(markup).toContain("Änderungen speichern");
    expect(markup).toContain("Arbeitsbereich verlassen");
  });

  it("blocks a sole owner from leaving and explains why", () => {
    const markup = render(
      "de",
      createElement(CollaborationWorkspaceGeneralTab, {
        collaborationWorkspace: sharedCollaborationWorkspace,
        currentUserId: "user_1",
        members: [members[0]!],
        savePending: false,
        membershipPending: false,
        onSave: noop,
        onLeave: noop
      })
    );

    expect(markup).toContain(
      "Ein geteilter Arbeitsbereich muss mindestens einen Besitzer behalten."
    );
  });

  it("shows member email and role controls for an owner", () => {
    const markup = render(
      "de",
      createElement(CollaborationWorkspaceMembersTab, {
        collaborationWorkspace: sharedCollaborationWorkspace,
        currentUserId: "user_1",
        members,
        loading: false,
        loadFailed: false,
        pending: false,
        onAddMember: noop,
        onChangeMemberRole: noop,
        onRemoveMember: noop
      })
    );

    expect(markup).toContain("Mitglied per E-Mail hinzufügen");
    expect(markup).toContain("mara@example.com");
    expect(markup).toContain('aria-label="Rolle von Mara Ruiz"');
    expect(markup).toContain('aria-label="Mara Ruiz entfernen"');
    expect(markup).not.toContain('aria-label="Felix Pahlke entfernen"');
  });

  it("keeps roles read-only for an admin", () => {
    const markup = render(
      "de",
      createElement(CollaborationWorkspaceMembersTab, {
        collaborationWorkspace: { ...sharedCollaborationWorkspace, role: "admin" },
        currentUserId: "user_3",
        members,
        loading: false,
        loadFailed: false,
        pending: false,
        onAddMember: noop,
        onChangeMemberRole: noop,
        onRemoveMember: noop
      })
    );

    expect(markup).not.toContain('aria-label="Rolle von Mara Ruiz"');
    expect(markup).toContain('aria-label="Mara Ruiz entfernen"');
    expect(markup).not.toContain('aria-label="Felix Pahlke entfernen"');
  });

  it("lists access requests with approve and decline actions", () => {
    const markup = render(
      "de",
      createElement(CollaborationWorkspaceRequestsTab, {
        accessRequests: [
          {
            userId: "user_9",
            displayLabel: "Jonas Weber",
            email: "jonas@example.com",
            createdAt: "2026-08-20T09:30:00.000Z"
          }
        ],
        loading: false,
        loadFailed: false,
        pending: false,
        onApprove: noop,
        onDecline: noop
      })
    );

    expect(markup).toContain("Jonas Weber");
    expect(markup).toContain("jonas@example.com");
    expect(markup).toContain("Angefragt am");
    expect(markup).toContain("Genehmigen");
    expect(markup).toContain("Ablehnen");
  });

  it("explains the empty requests state", () => {
    const markup = render(
      "de",
      createElement(CollaborationWorkspaceRequestsTab, {
        accessRequests: [],
        loading: false,
        loadFailed: false,
        pending: false,
        onApprove: noop,
        onDecline: noop
      })
    );

    expect(markup).toContain("Keine offenen Zugriffsanfragen.");
  });

  it("follows the role table for role changes and removals", () => {
    expect(canChangeCollaborationWorkspaceRole("owner")).toBe(true);
    expect(canChangeCollaborationWorkspaceRole("admin")).toBe(false);
    expect(canChangeCollaborationWorkspaceRole("member")).toBe(false);
    expect(canRemoveCollaborationWorkspaceMember("owner", "owner")).toBe(true);
    expect(canRemoveCollaborationWorkspaceMember("admin", "member")).toBe(true);
    expect(canRemoveCollaborationWorkspaceMember("admin", "admin")).toBe(false);
    expect(canRemoveCollaborationWorkspaceMember("member", "member")).toBe(false);
  });
});

describe("browse collaboration workspaces dialog", () => {
  const directory: CollaborationWorkspaceDirectoryItem[] = [
    {
      id: "cw_open",
      name: "Offene Runde",
      description: "Kurzbeschreibung",
      emoji: null,
      accentColor: "teal",
      accessState: "can_request"
    },
    {
      id: "cw_pending",
      name: "Wartende Runde",
      description: null,
      emoji: null,
      accentColor: null,
      accessState: "request_pending"
    },
    {
      id: "cw_member",
      name: "Eigene Runde",
      description: null,
      emoji: "📈",
      accentColor: "amber",
      accessState: "member"
    }
  ];

  it("renders one action per access state and never member details", () => {
    const markup = render(
      "de",
      createElement(BrowseCollaborationWorkspacesDialog, {
        open: true,
        collaborationWorkspaces: directory,
        loading: false,
        loadFailed: false,
        errorMessage: undefined,
        pendingCollaborationWorkspaceId: undefined,
        onRequestAccess: noop,
        onClose: noop
      })
    );

    expect(markup).toContain("Zugriff anfragen");
    expect(markup).toContain("Anfrage ausstehend");
    expect(markup).toContain("Mitglied");
    expect(markup).toContain("Kurzbeschreibung");
    expect(markup).toContain("Keine Beschreibung");
    expect(markup).not.toContain("@");
  });

  it("explains an empty directory", () => {
    const markup = render(
      "de",
      createElement(BrowseCollaborationWorkspacesDialog, {
        open: true,
        collaborationWorkspaces: [],
        loading: false,
        loadFailed: false,
        errorMessage: undefined,
        pendingCollaborationWorkspaceId: undefined,
        onRequestAccess: noop,
        onClose: noop
      })
    );

    expect(markup).toContain("Es gibt noch keine auffindbaren Arbeitsbereiche.");
  });

  it("reports a failed directory load", () => {
    const markup = render(
      "de",
      createElement(BrowseCollaborationWorkspacesDialog, {
        open: true,
        collaborationWorkspaces: [],
        loading: false,
        loadFailed: true,
        errorMessage: undefined,
        pendingCollaborationWorkspaceId: undefined,
        onRequestAccess: noop,
        onClose: noop
      })
    );

    expect(markup).toContain("Das Verzeichnis der Arbeitsbereiche konnte nicht geladen werden.");
  });
});
