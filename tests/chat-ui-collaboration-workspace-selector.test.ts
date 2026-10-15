import { createElement } from "react";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import type { CollaborationWorkspaceWithRole, SafeConfig } from "@work-shape/catalyst-api-client";
import { describe, expect, it } from "vitest";
import {
  CollaborationWorkspaceSelector,
  CollaborationWorkspaceSelectorMenu
} from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-selector";
import { ClientBrandingHeader } from "../packages/chat-ui/src/workspace/client-branding";

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
    defaultConversationVisibility: "workspace",
    emoji: null,
    accentColor: null,
    personalUserId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    role: "member",
    membershipRole: overrides.role ?? "member",
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
      { children: null, locale: "de" },
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
  it("names the personal workspace after its owner, without a secondary marker line", () => {
    const markup = renderMenu([personal]);

    expect(markup).toContain("Felix&#x27; Arbeitsbereich");
    expect(markup).not.toContain("Persönlicher Arbeitsbereich");
    // The marker used to render as its own text node right under the name.
    expect(markup).not.toContain(">Persönlich<");
    expect(markup).not.toContain("Server side personal name");
  });

  it("omits the shared section entirely while no shared workspace exists", () => {
    const markup = renderMenu([personal]);

    expect(markup).not.toContain("Geteilte Arbeitsbereiche");
    expect(markup).not.toContain("Noch keine geteilten Arbeitsbereiche.");
  });

  it("labels the shared section quietly once shared workspaces exist", () => {
    const markup = renderMenu([personal, collaborationWorkspace({ id: "cw_a", name: "Alpaka" })]);
    const heading = /<p class="([^"]*)">Geteilte Arbeitsbereiche<\/p>/u.exec(markup);

    expect(heading?.[1]).toContain("text-xs");
    expect(heading?.[1]).not.toContain("uppercase");
    expect(heading?.[1]).not.toContain("tracking");
  });

  it("offers create and browse as short buttons with full-length accessible names", () => {
    const markup = renderMenu([personal]);

    expect(markup).toContain('aria-label="Arbeitsbereich erstellen"');
    expect(markup).toContain('aria-label="Arbeitsbereiche durchsuchen"');
    expect(markup).toContain(">Erstellen<");
    expect(markup).toContain(">Durchsuchen<");
    expect(markup.indexOf(">Erstellen<")).toBeLessThan(markup.indexOf(">Durchsuchen<"));
  });

  it("lists shared workspaces alphabetically after the personal workspace", () => {
    const markup = renderMenu([
      personal,
      collaborationWorkspace({ id: "cw_z", name: "Zebra" }),
      collaborationWorkspace({ id: "cw_a", name: "Alpaka" })
    ]);

    expect(markup.indexOf("Felix&#x27; Arbeitsbereich")).toBeLessThan(markup.indexOf("Alpaka"));
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

  it("groups the shared workspaces a superadmin reaches without a membership", () => {
    const markup = renderMenu([
      personal,
      collaborationWorkspace({ id: "cw_joined", name: "Joined" }),
      collaborationWorkspace({
        id: "cw_other",
        name: "Anderes Team",
        role: "owner",
        membershipRole: null
      })
    ]);

    expect(markup.indexOf("Geteilte Arbeitsbereiche")).toBeLessThan(markup.indexOf("Joined"));
    expect(markup.indexOf("Joined")).toBeLessThan(markup.indexOf("Weitere Arbeitsbereiche"));
    expect(markup.indexOf("Weitere Arbeitsbereiche")).toBeLessThan(markup.indexOf("Anderes Team"));
    expect(markup).toContain('aria-label="Einstellungen für Anderes Team"');
  });

  it("shows each shared workspace heading only when it has rows", () => {
    const membershipsOnly = renderMenu([
      personal,
      collaborationWorkspace({ id: "cw_joined", name: "Joined" })
    ]);
    expect(membershipsOnly).toContain("Geteilte Arbeitsbereiche");
    expect(membershipsOnly).not.toContain("Weitere Arbeitsbereiche");

    const withoutMemberships = renderMenu([
      personal,
      collaborationWorkspace({ id: "cw_other", name: "Other", role: "owner", membershipRole: null })
    ]);
    expect(withoutMemberships).not.toContain("Geteilte Arbeitsbereiche");
    expect(withoutMemberships).toContain("Weitere Arbeitsbereiche");
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
        { children: null, locale: "de" },
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

  it("scrolls a long workspace list with the themed scrollbar, footer pinned below", () => {
    const markup = renderMenu([
      personal,
      collaborationWorkspace({ id: "cw_a", name: "Alpha" }),
      collaborationWorkspace({ id: "cw_b", name: "Beta" })
    ]);

    expect(markup).toMatch(/<div class="[^"]*overflow-y-auto[^"]*"/u);
    // The create/browse row stays outside the scroll container.
    expect(markup).toMatch(/<\/div><div class="mt-2 grid grid-cols-2 gap-1 border-t pt-2"/u);
  });

  it("keeps the trigger closed until it is used", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
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
    expect(markup).toContain("Felix&#x27;s workspace");
    expect(markup).not.toContain("Browse workspaces");
  });
});

describe("collaboration workspace selector client branding", () => {
  function renderMenuWithBranding(config: SafeConfig): string {
    return renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "de" },
        createElement(CollaborationWorkspaceSelectorMenu, {
          collaborationWorkspaces: [personal],
          activeCollaborationWorkspaceId: "cw_personal",
          userLabel: "Felix Pahlke",
          loading: false,
          loadFailed: false,
          clientBrandingHeader: createElement(ClientBrandingHeader, { config }),
          onSelectCollaborationWorkspace: noop,
          onOpenCollaborationWorkspaceSettings: noop,
          onBrowseCollaborationWorkspaces: noop,
          onCreateCollaborationWorkspace: noop
        })
      )
    );
  }

  it("heads the popover with the client logo, above the personal workspace row", () => {
    const markup = renderMenuWithBranding({
      ui: {
        clientName: "Musterfinanz",
        logoUrl: "/assets/musterfinanz.svg"
      }
    } as SafeConfig);

    expect(markup).toContain('src="/assets/musterfinanz.svg"');
    expect(markup).toContain('data-testid="client-branding-header"');
    expect(markup.indexOf("client-branding-header")).toBeLessThan(
      markup.indexOf("Felix&#x27; Arbeitsbereich")
    );
  });

  it("falls back to the client name when no logo is configured", () => {
    const markup = renderMenuWithBranding({
      ui: { clientName: "Musterfinanz", title: "Musterfinanz Chat" }
    } as SafeConfig);

    expect(markup).toContain("Musterfinanz");
    expect(markup).not.toContain("<img");
  });

  it("leaves the popover unchanged when no branding is supplied", () => {
    expect(renderMenu([personal])).not.toContain("client-branding-header");
  });
});

describe("personal workspace name", () => {
  // The closed trigger shows the name of the active workspace and nothing of the menu.
  function triggerName(locale: "en" | "de", userLabel: string): string {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(CollaborationWorkspaceSelector, {
          collaborationWorkspaces: [personal],
          activeCollaborationWorkspaceId: "cw_personal",
          userLabel,
          loading: false,
          loadFailed: false,
          onSelectCollaborationWorkspace: noop,
          onOpenCollaborationWorkspaceSettings: noop,
          onBrowseCollaborationWorkspaces: noop,
          onCreateCollaborationWorkspace: noop
        })
      )
    );
    const name = /<span class="[^"]*truncate[^"]*">([^<]*)<\/span>/u.exec(markup)?.[1];
    return (name ?? "").replaceAll("&#x27;", "'");
  }

  it("is the owner's first name with the possessive of the language", () => {
    expect(triggerName("en", "Felix Pahlke")).toBe("Felix's workspace");
    expect(triggerName("en", "Anna Schmidt")).toBe("Anna's workspace");
    expect(triggerName("de", "Anna Schmidt")).toBe("Annas Arbeitsbereich");
    // German sets only the apostrophe after s, ß, x and z.
    expect(triggerName("de", "Felix Pahlke")).toBe("Felix' Arbeitsbereich");
    expect(triggerName("de", "Hans")).toBe("Hans' Arbeitsbereich");
    expect(triggerName("de", "  Moritz  ")).toBe("Moritz' Arbeitsbereich");
  });

  it("stays the fixed label where the owner has no name", () => {
    expect(triggerName("en", "")).toBe("Personal workspace");
    expect(triggerName("de", "felix@example.test")).toBe("Persönlicher Arbeitsbereich");
  });

  it("never shows the name stored on the row", () => {
    expect(triggerName("en", "")).not.toBe(personal.name);
    expect(triggerName("en", "Felix Pahlke")).not.toBe(personal.name);
  });
});
