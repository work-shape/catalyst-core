import { createElement } from "react";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import type {
  CollaborationWorkspaceDirectoryItem,
  CollaborationWorkspaceWithRole,
  SafeConfig,
  WorkspaceAccessRequestItem,
  WorkspaceMember,
  WorkspaceMemberCandidate
} from "@work-shape/catalyst-api-client";
import { workspaceAccentColorSchema } from "@work-shape/catalyst-api-contract";
import { WORKSPACE_ACCENT_COLORS } from "@work-shape/catalyst-core";
import { describe, expect, it } from "vitest";
import {
  BrowseCollaborationWorkspacesDialog,
  ClientBrandingHeader,
  CollaborationWorkspaceSelectorMenu,
  CreateCollaborationWorkspaceDialog,
  CollaborationWorkspaceAddMemberForm,
  CollaborationWorkspaceMemberCandidateList,
  nextCollaborationWorkspaceMemberCandidate,
  canChangeCollaborationWorkspaceRole,
  canDeleteCollaborationWorkspace,
  canRemoveCollaborationWorkspaceMember,
  contrastRatio,
  defaultCollaborationWorkspaceAccentColor,
  randomCollaborationWorkspaceAccentColor,
  resolveCollaborationWorkspaceAccentColor,
  WorkspaceGeneralView,
  WorkspaceMembersView,
  collaborationWorkspaceAccentColors,
  collaborationWorkspaceAccentTokens,
  CollaborationWorkspaceEmojiGrid,
  collaborationWorkspaceEmojiChoices,
  collaborationWorkspaceEmojiSuggestions,
  CollaborationWorkspaceDeletionConfirmStep,
  CollaborationWorkspaceDeletionImpactStep,
  moveConversationDestinations,
  movedConversationVisibility,
  MoveConversationDialog,
  MoveConversationVisibility
} from "./support/chat-ui";

const noop = () => undefined;

function render(locale: "de" | "en", element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(TranslationProvider, { children: null, locale }, element)
  );
}

const sharedCollaborationWorkspace: CollaborationWorkspaceWithRole = {
  id: "cw_shared",
  clientInstanceId: "client",
  kind: "shared",
  name: "Produktteam",
  description: "Alles rund um das Produkt",
  visibility: "discoverable",
  defaultConversationVisibility: "workspace",
  emoji: "🚀",
  accentColor: "violet",
  personalUserId: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
  role: "owner",
  membershipRole: "owner",
  pendingAccessRequestCount: 1
};

const personalCollaborationWorkspace: CollaborationWorkspaceWithRole = {
  ...sharedCollaborationWorkspace,
  id: "cw_personal",
  kind: "personal",
  name: "Server side personal name",
  description: null,
  visibility: "private",
  emoji: null,
  accentColor: null,
  personalUserId: "user_1",
  pendingAccessRequestCount: 0
};

const secondSharedCollaborationWorkspace: CollaborationWorkspaceWithRole = {
  ...sharedCollaborationWorkspace,
  id: "cw_analytics",
  name: "Analytik",
  emoji: null,
  accentColor: "teal",
  role: "member",
  membershipRole: "member",
  pendingAccessRequestCount: 0
};

function sharedWorkspace(
  overrides: Partial<CollaborationWorkspaceWithRole> & Pick<CollaborationWorkspaceWithRole, "id">
): CollaborationWorkspaceWithRole {
  return {
    ...sharedCollaborationWorkspace,
    description: null,
    emoji: null,
    accentColor: null,
    role: "member",
    membershipRole: overrides.role ?? "member",
    pendingAccessRequestCount: 0,
    ...overrides
  };
}

const owner: WorkspaceMember = {
  userId: "user_1",
  displayLabel: "Felix Pahlke",
  email: "felix@example.com",
  role: "owner"
};
const members: WorkspaceMember[] = [
  owner,
  { userId: "user_2", displayLabel: "Mara Ruiz", email: "mara@example.com", role: "member" }
];

/**
 * The eight accents that shipped before the palette was widened. Pinned as
 * literals rather than derived from the palette: the point is to catch an edit
 * to a stored workspace's rendered color, which a derived copy could not see.
 */
const originalAccents = {
  ruby: { light: "#be123c", dark: "#fb7185" },
  amber: { light: "#b45309", dark: "#fbbf24" },
  emerald: { light: "#047857", dark: "#34d399" },
  sapphire: { light: "#1d4ed8", dark: "#60a5fa" },
  violet: { light: "#6d28d9", dark: "#a78bfa" },
  rose: { light: "#be185d", dark: "#f472b6" },
  teal: { light: "#0f766e", dark: "#2dd4bf" },
  slate: { light: "#475569", dark: "#94a3b8" }
} as const;

const isAccentColor = (
  value: string
): value is (typeof collaborationWorkspaceAccentColors)[number] =>
  collaborationWorkspaceAccentColors.some((accentColor) => accentColor === value);

describe("collaboration workspace accent palette", () => {
  it("keeps avatar text readable in both themes", () => {
    for (const accentColor of collaborationWorkspaceAccentColors) {
      for (const themeMode of ["light", "dark"] as const) {
        const tokens = collaborationWorkspaceAccentTokens(accentColor, themeMode);
        expect(
          contrastRatio(tokens.onSurface, tokens.surface),
          `${accentColor} (${themeMode})`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("renders every already-stored workspace exactly as before the palette grew", () => {
    for (const [accentColor, expected] of Object.entries(originalAccents)) {
      expect(collaborationWorkspaceAccentColors).toContain(accentColor);
      if (!isAccentColor(accentColor)) continue;
      expect(collaborationWorkspaceAccentTokens(accentColor, "light").surface).toBe(expected.light);
      expect(collaborationWorkspaceAccentTokens(accentColor, "dark").surface).toBe(expected.dark);
    }
  });

  it("keeps the three copies of the accent enum in step", () => {
    // The picker, the request schema and the server-side check are separate
    // literal lists. Adding a color to only some of them fails at runtime -- the
    // swatch saves, then the api-client rejects every later read of that
    // workspace -- so the parity is asserted here instead.
    const uiColors = [...collaborationWorkspaceAccentColors].sort();

    expect([...WORKSPACE_ACCENT_COLORS].sort()).toEqual(uiColors);
    expect([...workspaceAccentColorSchema.options].sort()).toEqual(uiColors);
  });

  it("derives a stable name fallback inside the original palette", () => {
    // Workspaces with no stored accent (every personal one) take their color
    // from this hash, so widening the pool would re-tint all of them at once.
    expect(defaultCollaborationWorkspaceAccentColor("Product team")).toBe(
      defaultCollaborationWorkspaceAccentColor("Product team")
    );
    for (let index = 0; index < 200; index += 1) {
      expect(Object.keys(originalAccents)).toContain(
        defaultCollaborationWorkspaceAccentColor(`workspace ${index}`)
      );
    }
  });

  it("draws the create-dialog starting accent from the whole palette", () => {
    const drawn = new Set(
      collaborationWorkspaceAccentColors.map((_, index) =>
        randomCollaborationWorkspaceAccentColor(
          () => index / collaborationWorkspaceAccentColors.length
        )
      )
    );

    expect([...drawn].sort()).toEqual([...collaborationWorkspaceAccentColors].sort());
  });

  it("prefers the persisted palette key and falls back for unknown values", () => {
    const fallback = defaultCollaborationWorkspaceAccentColor("Anything");
    expect(
      resolveCollaborationWorkspaceAccentColor({ accentColor: "violet", name: "Anything" })
    ).toBe("violet");
    expect(resolveCollaborationWorkspaceAccentColor({ accentColor: null, name: "Anything" })).toBe(
      fallback
    );
    expect(
      resolveCollaborationWorkspaceAccentColor({ accentColor: "chartreuse", name: "Anything" })
    ).toBe(fallback);
  });
});

describe("collaboration workspace selector", () => {
  function renderMenu(
    collaborationWorkspaces: CollaborationWorkspaceWithRole[],
    options: {
      locale?: "de" | "en";
      userLabel?: string;
      loadFailed?: boolean;
      branding?: { clientName: string; logoUrl?: string; title?: string };
    } = {}
  ): string {
    return render(
      options.locale ?? "de",
      createElement(CollaborationWorkspaceSelectorMenu, {
        collaborationWorkspaces,
        activeCollaborationWorkspaceId: undefined,
        userLabel: options.userLabel ?? "Felix Pahlke",
        loading: false,
        loadFailed: options.loadFailed ?? false,
        ...(options.branding
          ? {
              clientBrandingHeader: createElement(ClientBrandingHeader, {
                config: { ui: options.branding } as SafeConfig
              })
            }
          : {}),
        onSelectCollaborationWorkspace: noop,
        onOpenCollaborationWorkspaceSettings: noop,
        onBrowseCollaborationWorkspaces: noop,
        onCreateCollaborationWorkspace: noop
      })
    );
  }

  it("names the personal workspace after its owner, never by the name stored on the row", () => {
    const named = (locale: "de" | "en", userLabel: string) =>
      renderMenu([personalCollaborationWorkspace], { locale, userLabel }).replaceAll("&#x27;", "'");

    expect(named("en", "Felix Pahlke")).toContain("Felix's workspace");
    expect(named("de", "Anna Schmidt")).toContain("Annas Arbeitsbereich");
    // German sets only the apostrophe after s, ß, x and z.
    expect(named("de", "Felix Pahlke")).toContain("Felix' Arbeitsbereich");
    // The fixed label where the owner has no name.
    expect(named("en", "")).toContain("Personal workspace");
    expect(named("de", "felix@example.test")).toContain("Persönlicher Arbeitsbereich");
    expect(named("en", "Felix Pahlke")).not.toContain(personalCollaborationWorkspace.name);
  });

  it("offers settings to owners and admins of shared workspaces only, with a pending-request badge", () => {
    const markup = renderMenu([
      personalCollaborationWorkspace,
      sharedWorkspace({
        id: "cw_owned",
        name: "Owned",
        role: "owner",
        pendingAccessRequestCount: 3
      }),
      sharedWorkspace({ id: "cw_admin", name: "Administered", role: "admin" }),
      sharedWorkspace({ id: "cw_member", name: "Joined", role: "member" })
    ]);

    expect(markup).toContain('aria-label="Einstellungen für Owned"');
    expect(markup).toContain('aria-label="Einstellungen für Administered"');
    expect(markup).not.toContain('aria-label="Einstellungen für Joined"');
    expect(markup.match(/Einstellungen für/gu)).toHaveLength(2);
    expect(markup).toContain('aria-label="3 offene Zugriffsanfragen"');
  });

  it("lists memberships alphabetically, and apart from what a superadmin reaches without one", () => {
    const markup = renderMenu([
      personalCollaborationWorkspace,
      sharedWorkspace({ id: "cw_z", name: "Zebra" }),
      sharedWorkspace({ id: "cw_a", name: "Alpaka" }),
      sharedWorkspace({ id: "cw_other", name: "Anderes Team", role: "owner", membershipRole: null })
    ]);

    expect(markup.indexOf("Alpaka")).toBeLessThan(markup.indexOf("Zebra"));
    expect(markup.indexOf("Zebra")).toBeLessThan(markup.indexOf("Weitere Arbeitsbereiche"));
    expect(markup.indexOf("Weitere Arbeitsbereiche")).toBeLessThan(markup.indexOf("Anderes Team"));
    expect(markup).toContain('aria-label="Einstellungen für Anderes Team"');
    expect(renderMenu([personalCollaborationWorkspace])).not.toContain("Weitere Arbeitsbereiche");
  });

  it("reports a failed workspace load instead of an empty list", () => {
    expect(renderMenu([], { loadFailed: true })).toContain(
      "Arbeitsbereiche konnten nicht geladen werden."
    );
  });

  it("heads the popover with the client logo, or its name where none is configured", () => {
    const withLogo = renderMenu([personalCollaborationWorkspace], {
      branding: { clientName: "Musterfinanz", logoUrl: "/assets/logo.svg" }
    });
    expect(withLogo).toContain('src="/assets/logo.svg"');

    const withoutLogo = renderMenu([personalCollaborationWorkspace], {
      branding: { clientName: "Musterfinanz", title: "Musterfinanz Chat" }
    });
    expect(withoutLogo).toContain("Musterfinanz");
    expect(withoutLogo).not.toContain("<img");
  });
});

describe("create collaboration workspace dialog", () => {
  function createDialog(locale: "de" | "en", extra: Record<string, unknown> = {}): string {
    return render(
      locale,
      createElement(CreateCollaborationWorkspaceDialog, {
        open: true,
        pending: false,
        errorMessage: undefined,
        onClose: noop,
        onCreate: noop,
        ...extra
      })
    );
  }

  it("defaults to a discoverable workspace whose new conversations the workspace sees", () => {
    const markup = createDialog("en");

    expect(markup).toContain('checked="" value="discoverable"');
    expect(markup).toContain('checked="" value="workspace"');
  });

  it("starts from the injected accent and no emoji, previews them and shows the error", () => {
    const markup = createDialog("de", {
      initialAccentColor: "magenta",
      errorMessage: "This change is not allowed."
    });

    expect(markup).toMatch(
      /aria-pressed="true"[^>]*data-testid="collaboration-workspace-accent-magenta"/u
    );
    expect(
      markup.match(/aria-pressed="true"[^>]*data-testid="collaboration-workspace-accent-/gu)
    ).toHaveLength(1);
    expect(markup).toMatch(
      /aria-pressed="true"[^>]*data-testid="collaboration-workspace-emoji-none"/u
    );
    expect(markup).toContain('data-collaboration-workspace-accent="magenta"');
    expect(markup).toContain("This change is not allowed.");
  });

  it("keeps the curated emoji grid closed until More is used", () => {
    const markup = createDialog("en", { initialAccentColor: "violet" });

    for (const emoji of collaborationWorkspaceEmojiSuggestions) {
      expect(markup).toContain(`>${emoji}</button>`);
    }
    expect(markup).toMatch(
      /aria-expanded="false"[^>]*data-testid="collaboration-workspace-emoji-more"/u
    );
    expect(markup).not.toContain("collaboration-workspace-emoji-choice");
  });

  it("offers a duplicate-free curated emoji grid with the value picked", () => {
    expect(new Set(collaborationWorkspaceEmojiChoices).size).toBe(
      collaborationWorkspaceEmojiChoices.length
    );
    for (const emoji of collaborationWorkspaceEmojiSuggestions) {
      expect(collaborationWorkspaceEmojiChoices).toContain(emoji);
    }
    const markup = render(
      "de",
      createElement(CollaborationWorkspaceEmojiGrid, { value: "🧩", onChange: noop })
    );
    expect(markup.split('data-testid="collaboration-workspace-emoji-choice"').length - 1).toBe(
      collaborationWorkspaceEmojiChoices.length
    );
    expect(markup).toMatch(
      /aria-pressed="true"[^>]*data-testid="collaboration-workspace-emoji-choice"[^>]*>🧩</u
    );
  });
});

const accessRequest: WorkspaceAccessRequestItem = {
  userId: "user_9",
  displayLabel: "Jonas Weber",
  email: "jonas@example.com",
  createdAt: "2026-08-20T09:30:00.000Z"
};

function generalView(
  collaborationWorkspace: CollaborationWorkspaceWithRole,
  otherOwnerExists = true
): string {
  return render(
    "de",
    createElement(WorkspaceGeneralView, {
      workspace: collaborationWorkspace,
      otherOwnerExists,
      errorMessage: undefined,
      savePending: false,
      saved: false,
      leavePending: false,
      onEdit: noop,
      onSave: noop,
      onLeave: noop,
      onRequestDelete: noop
    })
  );
}

function membersView(
  collaborationWorkspace: CollaborationWorkspaceWithRole,
  input: {
    currentUserId?: string;
    members?: WorkspaceMember[] | undefined;
    accessRequests?: WorkspaceAccessRequestItem[] | undefined;
    membersLoadProblem?: { message: string; refused: boolean; retry?: () => void };
    accessRequestsLoadProblem?: { message: string; refused: boolean; retry?: () => void };
    actionProblem?: { message: string; refused: boolean; section: "members" | "requests" };
  } = {}
): string {
  return render(
    "de",
    createElement(WorkspaceMembersView, {
      workspace: collaborationWorkspace,
      currentUserId: input.currentUserId ?? "user_1",
      members: "members" in input ? input.members : members,
      membersLoadProblem: input.membersLoadProblem,
      accessRequests: "accessRequests" in input ? input.accessRequests : [],
      accessRequestsLoadProblem: input.accessRequestsLoadProblem,
      memberCandidates: [],
      memberCandidatesLoading: false,
      pending: false,
      actionProblem: input.actionProblem,
      onMemberCandidateSearchChange: noop,
      onAddMember: noop,
      onChangeMemberRole: noop,
      onRemoveMember: noop,
      onApproveAccessRequest: noop,
      onDeclineAccessRequest: noop
    })
  );
}

const deleteTrigger = 'data-testid="collaboration-workspace-delete-trigger"';
const leaveLabel = "Arbeitsbereich verlassen";
const soleOwnerNote = "Ein geteilter Arbeitsbereich muss mindestens einen Besitzer behalten.";

describe("Workspace pages of Settings", () => {
  it("shows the stored name, description, visibility default and appearance in General", () => {
    const markup = generalView({
      ...sharedCollaborationWorkspace,
      defaultConversationVisibility: "private"
    });

    expect(markup).toContain('value="Produktteam"');
    expect(markup).toContain("Alles rund um das Produkt");
    expect(markup).toMatch(
      /name="collaboration-workspace-conversation-visibility"[^>]*checked="" value="private"/u
    );
    expect(markup).toContain('data-collaboration-workspace-accent="violet"');
    for (const accentColor of collaborationWorkspaceAccentColors) {
      expect(markup, accentColor).toContain(
        `data-testid="collaboration-workspace-accent-${accentColor}"`
      );
    }
  });

  it("offers Leave and Delete by membership and role", () => {
    const ownerView = generalView(sharedCollaborationWorkspace);
    expect(ownerView).toContain(leaveLabel);
    expect(ownerView).toContain(deleteTrigger);

    // A sole owner may not leave, and is told why.
    expect(generalView(sharedCollaborationWorkspace, false)).toContain(soleOwnerNote);

    expect(
      generalView({ ...sharedCollaborationWorkspace, role: "admin", membershipRole: "admin" })
    ).not.toContain(deleteTrigger);

    // A superadmin without a membership: everything except leaving.
    const superadmin = generalView(
      { ...sharedCollaborationWorkspace, membershipRole: null },
      false
    );
    expect(superadmin).not.toContain(leaveLabel);
    expect(superadmin).not.toContain(soleOwnerNote);
    expect(superadmin).toContain(deleteTrigger);
  });

  it("gives an owner role controls and removal of others, never of themself", () => {
    const markup = membersView(sharedCollaborationWorkspace);

    expect(markup).toContain('aria-label="Mitgliedschaft von Mara Ruiz"');
    expect(markup).toContain('aria-label="Mara Ruiz entfernen"');
    expect(markup).not.toContain('aria-label="Felix Pahlke entfernen"');
    // Regression: the owner row without a remove button kept the selects in one column.
    expect(
      markup.match(/<span aria-hidden="true" class="size-8 shrink-0"><\/span>/gu)
    ).toHaveLength(1);
  });

  it("shows the role as text to an admin, who may remove a member but not the owner", () => {
    const markup = membersView(
      { ...sharedCollaborationWorkspace, role: "admin", membershipRole: "admin" },
      { currentUserId: "user_3" }
    );

    expect(markup).not.toContain('aria-label="Mitgliedschaft von Mara Ruiz"');
    expect(markup).toContain('aria-label="Mara Ruiz entfernen"');
    expect(markup).not.toContain('aria-label="Felix Pahlke entfernen"');
  });

  it("lists access requests with approve and decline, and has no Requests section without any", () => {
    const markup = membersView(sharedCollaborationWorkspace, { accessRequests: [accessRequest] });
    expect(markup).toContain("jonas@example.com");
    expect(markup).toContain("Genehmigen");
    expect(markup).toContain("Ablehnen");

    for (const empty of [
      membersView(sharedCollaborationWorkspace),
      // Nor while the requests load: no section waits for an answer that may be empty.
      membersView(sharedCollaborationWorkspace, { accessRequests: undefined }),
      membersView({ ...sharedCollaborationWorkspace, visibility: "private" })
    ]) {
      expect(empty).not.toContain("Anfragen");
    }
  });

  it("offers a retry for a failed load, but none for a refusal", () => {
    const failed = membersView(sharedCollaborationWorkspace, {
      members: undefined,
      membersLoadProblem: { message: "Fehlgeschlagen.", refused: false, retry: noop }
    });
    expect(failed).toContain("Fehlgeschlagen.");
    expect(failed).toContain('data-tone="danger"');
    expect(failed).toContain("Erneut versuchen");

    const refusal = "Du darfst das nicht sehen.";
    const refused = membersView(sharedCollaborationWorkspace, {
      accessRequests: undefined,
      accessRequestsLoadProblem: { message: refusal, refused: true }
    });
    expect(refused).toContain(refusal);
    // Information, not an error: somebody with more rights has to act.
    expect(refused).toContain('data-tone="info"');
    expect(refused).not.toContain("Erneut versuchen");
    expect(refused).not.toContain("collaboration-workspace-request-row");
  });

  it("says a refused change in the section it was made in, and one about a gone request", () => {
    const said = "Du darfst Anfragen nicht genehmigen.";
    const markup = membersView(sharedCollaborationWorkspace, {
      accessRequests: [accessRequest],
      actionProblem: { message: said, refused: true, section: "requests" }
    });
    const requests = markup.slice(markup.indexOf("Anfragen</h2>"));
    expect(markup.split(said)).toHaveLength(2);
    expect(requests).toContain(said);
    expect(requests).toContain('data-tone="info"');

    // The request is no longer listed, so there is no Requests section to say it in.
    const gone = "Diese Anfrage gibt es nicht mehr.";
    expect(
      membersView(sharedCollaborationWorkspace, {
        actionProblem: { message: gone, refused: false, section: "requests" }
      })
    ).toContain(gone);
  });

  it("keeps the browser address autofill out of the add-member input", () => {
    const markup = render(
      "de",
      createElement(CollaborationWorkspaceAddMemberForm, {
        memberCandidates: [],
        memberCandidatesLoading: false,
        pending: false,
        onMemberCandidateSearchChange: noop,
        onAddMember: noop
      })
    );

    // React serializes the attribute name as written; HTML parses it case-insensitively.
    expect(markup).toMatch(/id="collaboration-workspace-member-email"[^>]*autocomplete="off"/iu);
    expect(markup).not.toContain('name="email"');
  });

  it("flags only the member candidate who asked for access, keeping both selectable", () => {
    const candidates: WorkspaceMemberCandidate[] = [
      {
        userId: "user_mara",
        displayLabel: "Mara Ruiz",
        email: "mara@example.com",
        hasPendingAccessRequest: false
      },
      {
        userId: "user_jonas",
        displayLabel: "Jonas Weber",
        email: "jonas@example.com",
        hasPendingAccessRequest: true
      }
    ];
    const markup = render(
      "en",
      createElement(CollaborationWorkspaceMemberCandidateList, {
        candidates,
        highlightedIndex: 1,
        onSelect: noop
      })
    );

    expect(markup.match(/Has requested access/gu)).toHaveLength(1);
    expect(markup.match(/role="option"/gu)).toHaveLength(2);
    expect(markup).toMatch(
      /id="collaboration-workspace-member-candidates-1"[^>]*aria-selected="true"/u
    );
  });

  it("wraps the arrow-key highlight around both ends", () => {
    expect(nextCollaborationWorkspaceMemberCandidate(-1, 1, 3)).toBe(0);
    expect(nextCollaborationWorkspaceMemberCandidate(-1, -1, 3)).toBe(2);
    expect(nextCollaborationWorkspaceMemberCandidate(2, 1, 3)).toBe(0);
    expect(nextCollaborationWorkspaceMemberCandidate(0, -1, 3)).toBe(2);
    expect(nextCollaborationWorkspaceMemberCandidate(0, 1, 0)).toBe(-1);
  });

  it("follows the role table for role changes, removals and deletion", () => {
    expect(canChangeCollaborationWorkspaceRole("owner")).toBe(true);
    expect(canChangeCollaborationWorkspaceRole("admin")).toBe(false);
    expect(canChangeCollaborationWorkspaceRole("member")).toBe(false);
    expect(canRemoveCollaborationWorkspaceMember("owner", "owner")).toBe(true);
    expect(canRemoveCollaborationWorkspaceMember("admin", "member")).toBe(true);
    expect(canRemoveCollaborationWorkspaceMember("admin", "admin")).toBe(false);
    expect(canRemoveCollaborationWorkspaceMember("member", "member")).toBe(false);
    expect(canDeleteCollaborationWorkspace(sharedCollaborationWorkspace)).toBe(true);
    expect(canDeleteCollaborationWorkspace({ kind: "shared", role: "admin" })).toBe(false);
    expect(canDeleteCollaborationWorkspace({ kind: "shared", role: "member" })).toBe(false);
    expect(canDeleteCollaborationWorkspace({ kind: "personal", role: "owner" })).toBe(false);
  });
});

describe("move conversation dialog", () => {
  const moveDialogProps = {
    open: true,
    conversationTitle: "Angebot Q3",
    conversationVisibility: "workspace" as const,
    movedByCreator: true,
    collaborationWorkspaces: [
      secondSharedCollaborationWorkspace,
      personalCollaborationWorkspace,
      sharedCollaborationWorkspace
    ],
    activeCollaborationWorkspaceId: sharedCollaborationWorkspace.id,
    userLabel: "Felix Pahlke",
    pending: false,
    errorMessage: undefined,
    onClose: noop,
    onMove: noop
  };
  const destinationRow = /data-testid="move-conversation-destination-row"/gu;

  it("offers every other workspace, Personal first, and waits for a pick", () => {
    const markup = render("de", createElement(MoveConversationDialog, moveDialogProps));

    expect(markup.match(destinationRow)).toHaveLength(2);
    expect(markup).not.toContain("Produktteam");
    expect(markup).toContain('type="submit" disabled=""');
    expect(markup).not.toContain('name="move-conversation-visibility"');
    expect(
      moveConversationDestinations(
        moveDialogProps.collaborationWorkspaces,
        sharedCollaborationWorkspace.id
      ).map((destination) => destination.id)
    ).toEqual([personalCollaborationWorkspace.id, secondSharedCollaborationWorkspace.id]);

    const nowhere = render(
      "de",
      createElement(MoveConversationDialog, {
        ...moveDialogProps,
        collaborationWorkspaces: [sharedCollaborationWorkspace]
      })
    );
    expect(nowhere).not.toMatch(destinationRow);
  });

  it("names a conversation with the stored placeholder title in the reader's language", () => {
    const markup = render(
      "de",
      createElement(MoveConversationDialog, {
        ...moveDialogProps,
        conversationTitle: "New conversation"
      })
    );

    expect(markup).toContain("Neue Unterhaltung");
    expect(markup).not.toContain("New conversation");
  });

  it("proposes a private result only to the conversation's creator", () => {
    const visibility = (
      conversationVisibility: "workspace" | "private",
      destinationDefaultConversationVisibility: "workspace" | "private",
      movedByCreator = true
    ) =>
      movedConversationVisibility({
        conversationVisibility,
        movedByCreator,
        destinationDefaultConversationVisibility
      });

    expect(visibility("workspace", "workspace")).toBe("workspace");
    expect(visibility("workspace", "private")).toBe("private");
    expect(visibility("private", "workspace")).toBe("private");
    expect(visibility("private", "private")).toBe("private");
    expect(visibility("workspace", "private", false)).toBe("workspace");
  });

  it("lets only the creator choose who can open the moved conversation", () => {
    const choice = (movedByCreator: boolean) =>
      render(
        "en",
        createElement(MoveConversationVisibility, {
          destinationName: "Analytik",
          destinationDefaultConversationVisibility: "private",
          visibility: movedByCreator ? "private" : "workspace",
          movedByCreator,
          onChange: noop
        })
      );

    expect(choice(true)).toMatch(
      /name="move-conversation-visibility"[^>]*checked="" value="private"/u
    );
    expect(choice(false)).not.toContain('type="radio"');
  });
});

describe("delete collaboration workspace dialog", () => {
  function impactStep(input: {
    deletionImpact?: {
      conversationCount: number;
      memberCount: number;
      pendingAccessRequestCount: number;
    };
    loading?: boolean;
    loadFailed?: boolean;
  }): string {
    return render(
      "de",
      createElement(CollaborationWorkspaceDeletionImpactStep, {
        collaborationWorkspaceName: "Produktteam",
        deletionImpact: input.deletionImpact,
        loading: input.loading ?? false,
        loadFailed: input.loadFailed ?? false,
        onCancel: noop,
        onContinue: noop
      })
    );
  }

  it("shows what the deletion removes, and blocks the next step while that is unknown", () => {
    const markup = impactStep({
      deletionImpact: { conversationCount: 12, memberCount: 4, pendingAccessRequestCount: 2 }
    });
    expect(markup).toContain("12 Unterhaltungen");
    expect(markup).toContain("4 Mitglieder");
    expect(markup).toContain("2 offene Zugriffsanfragen");
    expect(markup).not.toContain('disabled=""');

    expect(impactStep({ loading: true })).toContain('disabled=""');
    expect(impactStep({ loadFailed: true })).toContain('disabled=""');
  });

  it("keeps the destructive button disabled until the name is typed, and marks a wrong one", () => {
    const confirmStep = (nameErrorMessage?: string) =>
      render(
        "de",
        createElement(CollaborationWorkspaceDeletionConfirmStep, {
          collaborationWorkspaceName: "Produktteam",
          pending: false,
          errorMessage: undefined,
          nameErrorMessage,
          onBack: noop,
          onDelete: noop
        })
      );

    expect(confirmStep()).toContain('type="submit" disabled=""');
    const rejected = confirmStep("Dieser Name stimmt nicht.");
    expect(rejected).toContain('aria-invalid="true"');
    expect(rejected).toContain("Dieser Name stimmt nicht.");
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
      accessState: "can_request",
      createdAt: "2026-06-27T00:00:00.000Z"
    },
    {
      id: "cw_pending",
      name: "Wartende Runde",
      description: null,
      emoji: null,
      accentColor: null,
      accessState: "request_pending",
      createdAt: "2026-06-27T00:00:00.000Z"
    },
    {
      id: "cw_member",
      name: "Eigene Runde",
      description: null,
      emoji: "📈",
      accentColor: "amber",
      accessState: "member",
      createdAt: "2026-06-27T00:00:00.000Z"
    }
  ];

  function browse(input: {
    collaborationWorkspaces: CollaborationWorkspaceDirectoryItem[];
    loadFailed: boolean;
  }): string {
    return render(
      "de",
      createElement(BrowseCollaborationWorkspacesDialog, {
        open: true,
        ...input,
        loading: false,
        errorMessage: undefined,
        pendingCollaborationWorkspaceId: undefined,
        onRequestAccess: noop,
        onClose: noop
      })
    );
  }

  it("renders one action per access state and never member details", () => {
    const markup = browse({ collaborationWorkspaces: directory, loadFailed: false });

    expect(markup).toContain("Zugriff anfragen");
    expect(markup).toContain("Anfrage ausstehend");
    expect(markup).toContain("Mitglied");
    expect(markup).not.toContain("@");
  });

  it("reports a failed directory load", () => {
    expect(browse({ collaborationWorkspaces: [], loadFailed: true })).toContain(
      "Das Verzeichnis der Arbeitsbereiche konnte nicht geladen werden."
    );
  });
});
