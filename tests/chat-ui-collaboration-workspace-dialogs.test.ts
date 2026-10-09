import { createElement } from "react";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import type {
  CollaborationWorkspaceDirectoryItem,
  CollaborationWorkspaceWithRole,
  WorkspaceAccessRequestItem,
  WorkspaceMember,
  WorkspaceMemberCandidate
} from "@vivd-catalyst/api-client";
import { describe, expect, it } from "vitest";
import { BrowseCollaborationWorkspacesDialog } from "../packages/chat-ui/src/collaboration-workspace/browse-collaboration-workspaces-dialog";
import { CreateCollaborationWorkspaceDialog } from "../packages/chat-ui/src/collaboration-workspace/create-collaboration-workspace-dialog";
import {
  CollaborationWorkspaceAddMemberForm,
  CollaborationWorkspaceMemberCandidateList,
  nextCollaborationWorkspaceMemberCandidate
} from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-member-search";
import {
  canChangeCollaborationWorkspaceRole,
  canDeleteCollaborationWorkspace,
  canRemoveCollaborationWorkspaceMember
} from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-roles";
import { WorkspaceGeneralView } from "../packages/chat-ui/src/settings/pages/workspace-general";
import { WorkspaceMembersView } from "../packages/chat-ui/src/settings/pages/workspace-members";
import {
  collaborationWorkspaceAccentColors,
  collaborationWorkspaceAccentTokens
} from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-accent";
import { CollaborationWorkspaceEmojiGrid } from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-fields";
import {
  collaborationWorkspaceEmojiChoices,
  collaborationWorkspaceEmojiSuggestions
} from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-emoji";
import {
  CollaborationWorkspaceDeletionConfirmStep,
  CollaborationWorkspaceDeletionImpactStep
} from "../packages/chat-ui/src/collaboration-workspace/delete-collaboration-workspace-dialog";
import {
  moveConversationDestinations,
  movedConversationVisibility,
  MoveConversationDialog,
  MoveConversationVisibility
} from "../packages/chat-ui/src/collaboration-workspace/move-conversation-dialog";

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
  name: "Felix Pahlke",
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

  it("starts new conversations as visible to the workspace and says a change is not retroactive", () => {
    const markup = render(
      "en",
      createElement(CreateCollaborationWorkspaceDialog, {
        open: true,
        pending: false,
        errorMessage: undefined,
        onClose: noop,
        onCreate: noop
      })
    );

    expect(markup).toContain("New conversations are");
    expect(markup).toContain('checked="" value="workspace"');
    expect(markup).toContain("Private to their author");
    expect(markup).toContain(
      "A change applies to new conversations only. Existing ones keep their visibility."
    );
  });

  it("starts from the injected accent instead of deriving one from the name", () => {
    const markup = render(
      "de",
      createElement(CreateCollaborationWorkspaceDialog, {
        open: true,
        pending: false,
        errorMessage: undefined,
        initialAccentColor: "violet",
        onClose: noop,
        onCreate: noop
      })
    );

    expect(markup).toMatch(
      /aria-pressed="true"[^>]*data-testid="collaboration-workspace-accent-violet"/u
    );
    expect(markup).not.toMatch(
      /aria-pressed="true"[^>]*data-testid="collaboration-workspace-accent-ruby"/u
    );
  });

  it("offers a way to clear the emoji back to initials", () => {
    const markup = render(
      "de",
      createElement(CreateCollaborationWorkspaceDialog, {
        open: true,
        pending: false,
        errorMessage: undefined,
        initialAccentColor: "violet",
        onClose: noop,
        onCreate: noop
      })
    );

    expect(markup).toContain('aria-label="Kein Emoji"');
    expect(markup).toMatch(
      /aria-pressed="true"[^>]*data-testid="collaboration-workspace-emoji-none"/u
    );
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
    membersLoadFailed?: boolean;
    accessRequestsLoadFailed?: boolean;
  } = {}
): string {
  return render(
    "de",
    createElement(WorkspaceMembersView, {
      workspace: collaborationWorkspace,
      currentUserId: input.currentUserId ?? "user_1",
      members: "members" in input ? input.members : members,
      membersLoadFailed: input.membersLoadFailed ?? false,
      onRetryMembers: noop,
      accessRequests: "accessRequests" in input ? input.accessRequests : [],
      accessRequestsLoadFailed: input.accessRequestsLoadFailed ?? false,
      onRetryAccessRequests: noop,
      memberCandidates: [],
      memberCandidatesLoading: false,
      pending: false,
      errorMessage: undefined,
      onMemberCandidateSearchChange: noop,
      onAddMember: noop,
      onChangeMemberRole: noop,
      onRemoveMember: noop,
      onApproveAccessRequest: noop,
      onDeclineAccessRequest: noop
    })
  );
}

function addMemberForm(): string {
  return render(
    "de",
    createElement(CollaborationWorkspaceAddMemberForm, {
      memberCandidates: [],
      memberCandidatesLoading: false,
      pending: false,
      onMemberCandidateSearchChange: noop,
      onAddMember: noop
    })
  );
}

describe("Workspace pages of Settings", () => {
  it("renames, describes and re-themes a shared workspace in General", () => {
    const markup = generalView(sharedCollaborationWorkspace);

    expect(markup).toContain('value="Produktteam"');
    expect(markup).toContain("Alles rund um das Produkt");
    expect(markup).toContain("Änderungen speichern");
    expect(markup).toContain("Arbeitsbereich verlassen");
  });

  it("puts the General fields into sections, the last one holding Leave and Delete", () => {
    const markup = generalView(sharedCollaborationWorkspace);
    const headings = [...markup.matchAll(/<h2[^>]*>([^<]*)<\/h2>/gu)].map((match) => match[1]);

    expect(headings).toEqual(["Angaben", "Zugriff", "Darstellung", "Verlassen oder löschen"]);
    expect(markup.indexOf("Arbeitsbereich löschen")).toBeGreaterThan(
      markup.indexOf("Verlassen oder löschen")
    );
  });

  it("shows the stored default conversation visibility of a shared workspace", () => {
    const markup = generalView({
      ...sharedCollaborationWorkspace,
      defaultConversationVisibility: "private"
    });

    expect(markup).toContain("Neue Unterhaltungen sind");
    expect(markup).toMatch(
      /name="collaboration-workspace-conversation-visibility"[^>]*checked="" value="private"/u
    );
    expect(markup).toContain(
      "Eine Änderung gilt nur für neue Unterhaltungen. Bestehende behalten ihre Sichtbarkeit."
    );
  });

  it("blocks a sole owner from leaving and explains why", () => {
    const markup = generalView(sharedCollaborationWorkspace, false);

    expect(markup).toContain(
      "Ein geteilter Arbeitsbereich muss mindestens einen Besitzer behalten."
    );
  });

  it("offers a superadmin without a membership everything except leaving", () => {
    const markup = generalView({ ...sharedCollaborationWorkspace, membershipRole: null }, false);

    expect(markup).not.toContain("Arbeitsbereich verlassen");
    expect(markup).not.toContain(
      "Ein geteilter Arbeitsbereich muss mindestens einen Besitzer behalten."
    );
    expect(markup).toContain('data-testid="collaboration-workspace-delete-trigger"');
    expect(markup).toContain("Änderungen speichern");
  });

  it("offers deletion to an owner of a shared workspace", () => {
    const markup = generalView(sharedCollaborationWorkspace);

    expect(markup).toContain('data-testid="collaboration-workspace-delete-trigger"');
    expect(markup).toContain("Arbeitsbereich löschen");
  });

  it("hides deletion from an admin", () => {
    const markup = generalView({
      ...sharedCollaborationWorkspace,
      role: "admin",
      membershipRole: "admin"
    });

    expect(markup).not.toContain('data-testid="collaboration-workspace-delete-trigger"');
  });

  it("previews the stored emoji and colour beside the appearance fields", () => {
    const markup = generalView(sharedCollaborationWorkspace);

    expect(markup).toContain('data-collaboration-workspace-accent="violet"');
    expect(markup).toContain(collaborationWorkspaceAccentTokens("violet", "light").surface);
    for (const accentColor of collaborationWorkspaceAccentColors) {
      expect(markup, accentColor).toContain(
        `data-testid="collaboration-workspace-accent-${accentColor}"`
      );
    }
  });

  it("shows Requests above Members, each with its count, and no tabs", () => {
    const markup = membersView(sharedCollaborationWorkspace, { accessRequests: [accessRequest] });
    const headings = [...markup.matchAll(/<h2[^>]*>([^<]*)<\/h2>/gu)].map((match) => match[1]);

    expect(headings).toEqual(["Anfragen", "Mitglieder"]);
    expect(markup).not.toContain('role="tab"');
    expect(markup).toContain("Mitglied hinzufügen");
    expect(markup).toMatch(/Anfragen<\/h2><span[^>]*>1<\/span>/u);
    expect(markup).toMatch(/Mitglieder<\/h2><span[^>]*>2<\/span>/u);
  });

  it("shows member email and role controls for an owner", () => {
    const markup = membersView(sharedCollaborationWorkspace);

    expect(markup).toContain("mara@example.com");
    expect(markup).toContain('aria-label="Rolle von Mara Ruiz"');
    expect(markup).toContain('aria-label="Mara Ruiz entfernen"');
    expect(markup).not.toContain('aria-label="Felix Pahlke entfernen"');
  });

  it("shows the role as text to an admin, who may not change it", () => {
    const markup = membersView(
      { ...sharedCollaborationWorkspace, role: "admin", membershipRole: "admin" },
      { currentUserId: "user_3" }
    );

    expect(markup).not.toContain('aria-label="Rolle von Mara Ruiz"');
    expect(markup).toContain("Besitzer");
    expect(markup).toContain('aria-label="Mara Ruiz entfernen"');
    expect(markup).not.toContain('aria-label="Felix Pahlke entfernen"');
  });

  it("lists access requests with approve and decline actions", () => {
    const markup = membersView(sharedCollaborationWorkspace, { accessRequests: [accessRequest] });

    expect(markup).toContain("Jonas Weber");
    expect(markup).toContain("jonas@example.com");
    expect(markup).toContain("Angefragt am");
    expect(markup).toContain("Genehmigen");
    expect(markup).toContain("Ablehnen");
  });

  it("keeps the Requests section, with its sentence, while nobody asks", () => {
    const markup = membersView(sharedCollaborationWorkspace);

    expect(markup).toContain("Anfragen");
    expect(markup).toContain("Keine offenen Zugriffsanfragen.");
  });

  it("has no Requests section for a workspace nobody can ask to join", () => {
    const markup = membersView({ ...sharedCollaborationWorkspace, visibility: "private" });

    expect(markup).not.toContain("Anfragen");
    expect(markup).toContain("Mitglieder");
  });

  it("reports a failed load inside the section that failed", () => {
    const markup = membersView(sharedCollaborationWorkspace, {
      members: undefined,
      membersLoadFailed: true
    });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Erneut versuchen");
    expect(markup).toContain("Keine offenen Zugriffsanfragen.");
  });

  it("keeps the browser address autofill out of the add-member input", () => {
    const markup = addMemberForm();

    // React serializes the attribute name as written; HTML parses it case-insensitively.
    expect(markup).toMatch(/id="collaboration-workspace-member-email"[^>]*autocomplete="off"/iu);
    expect(markup).toContain('name="collaboration-workspace-member-email"');
    expect(markup).not.toContain('name="email"');
  });

  it("exposes the add-member field as a closed combobox until suggestions arrive", () => {
    const markup = addMemberForm();

    expect(markup).toContain("Mitglied per E-Mail hinzufügen");
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-controls="collaboration-workspace-member-candidates"');
    expect(markup).toContain('aria-expanded="false"');
    // Empty results stay quiet: no listbox, no "nothing found" copy.
    expect(markup).not.toContain('role="listbox"');
  });

  describe("member candidate suggestions", () => {
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

    it("renders each candidate as an option with the email as secondary text", () => {
      const markup = render(
        "de",
        createElement(CollaborationWorkspaceMemberCandidateList, {
          candidates,
          highlightedIndex: 1,
          onSelect: noop
        })
      );

      expect(markup).toContain('role="listbox"');
      expect(markup).toContain('aria-label="Mitgliedervorschläge"');
      expect(markup).toContain('id="collaboration-workspace-member-candidates-0"');
      expect(markup).toContain("Mara Ruiz");
      expect(markup).toContain("mara@example.com");
      // The highlight is carried by aria-selected, not by focus.
      expect(markup).toMatch(
        /id="collaboration-workspace-member-candidates-1"[^>]*aria-selected="true"/u
      );
      expect(markup).toMatch(
        /id="collaboration-workspace-member-candidates-0"[^>]*aria-selected="false"/u
      );
    });

    it("flags a pending access request without blocking the row", () => {
      expect(
        render(
          "de",
          createElement(CollaborationWorkspaceMemberCandidateList, {
            candidates,
            highlightedIndex: -1,
            onSelect: noop
          })
        )
      ).toContain("Hat Zugriff angefragt");

      const englishMarkup = render(
        "en",
        createElement(CollaborationWorkspaceMemberCandidateList, {
          candidates,
          highlightedIndex: -1,
          onSelect: noop
        })
      );

      expect(englishMarkup).toContain("Has requested access");
      // Only the flagged candidate carries the hint; both stay selectable.
      expect(englishMarkup.match(/Has requested access/gu)).toHaveLength(1);
      expect(englishMarkup.match(/role="option"/gu)).toHaveLength(2);
    });

    it("wraps the arrow-key highlight around both ends", () => {
      expect(nextCollaborationWorkspaceMemberCandidate(-1, 1, 3)).toBe(0);
      expect(nextCollaborationWorkspaceMemberCandidate(-1, -1, 3)).toBe(2);
      expect(nextCollaborationWorkspaceMemberCandidate(2, 1, 3)).toBe(0);
      expect(nextCollaborationWorkspaceMemberCandidate(0, -1, 3)).toBe(2);
      expect(nextCollaborationWorkspaceMemberCandidate(0, 1, 0)).toBe(-1);
    });
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

  it("restricts deletion to owners of shared workspaces", () => {
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

  it("offers every workspace except the one the conversation is in", () => {
    const markup = render("de", createElement(MoveConversationDialog, moveDialogProps));

    expect(markup).toContain("Unterhaltung verschieben");
    expect(markup).toContain("Angebot Q3");
    expect(markup).toContain("Persönlicher Arbeitsbereich");
    expect(markup).toContain("Analytik");
    expect(markup).not.toContain("Produktteam");
    expect(markup.match(/data-testid="move-conversation-destination-row"/gu)).toHaveLength(2);
  });

  it("keeps the move disabled until a destination is picked", () => {
    const markup = render("de", createElement(MoveConversationDialog, moveDialogProps));

    expect(markup).toContain("Verschieben");
    expect(markup).toContain('type="submit" disabled=""');
  });

  it("explains that there is nowhere to move the conversation", () => {
    const markup = render(
      "de",
      createElement(MoveConversationDialog, {
        ...moveDialogProps,
        collaborationWorkspaces: [sharedCollaborationWorkspace]
      })
    );

    expect(markup).toContain(
      "Es gibt keinen anderen Arbeitsbereich, in den diese Unterhaltung verschoben werden könnte."
    );
    expect(markup).not.toContain('data-testid="move-conversation-destination-row"');
  });

  it("surfaces the mapped error copy", () => {
    const markup = render(
      "de",
      createElement(MoveConversationDialog, {
        ...moveDialogProps,
        errorMessage: "In dieser Unterhaltung läuft noch Arbeit."
      })
    );

    expect(markup).toContain("In dieser Unterhaltung läuft noch Arbeit.");
  });

  it("asks for no visibility before a destination is picked", () => {
    const markup = render("en", createElement(MoveConversationDialog, moveDialogProps));

    expect(markup).not.toContain("After the move");
    expect(markup).not.toContain("can then read it");
  });

  it("starts from the server rule for the conversation's creator", () => {
    const fromDefault = (
      conversationVisibility: "workspace" | "private",
      destinationDefaultConversationVisibility: "workspace" | "private"
    ) =>
      movedConversationVisibility({
        conversationVisibility,
        movedByCreator: true,
        destinationDefaultConversationVisibility
      });

    expect(fromDefault("workspace", "workspace")).toBe("workspace");
    expect(fromDefault("workspace", "private")).toBe("private");
    expect(fromDefault("private", "workspace")).toBe("private");
    expect(fromDefault("private", "private")).toBe("private");
  });

  it("never proposes a private result to someone who did not create the conversation", () => {
    expect(
      movedConversationVisibility({
        conversationVisibility: "workspace",
        movedByCreator: false,
        destinationDefaultConversationVisibility: "private"
      })
    ).toBe("workspace");
  });

  it("lets the creator choose who can open the moved conversation", () => {
    const markup = render(
      "en",
      createElement(MoveConversationVisibility, {
        destinationName: "Analytik",
        destinationDefaultConversationVisibility: "private",
        visibility: "private",
        movedByCreator: true,
        onChange: noop
      })
    );

    expect(markup).toContain("After the move");
    expect(markup).toContain("Every member of Analytik can open it.");
    expect(markup).toContain("Private to you");
    expect(markup).toContain("Only you can open it.");
    expect(markup).toMatch(/name="move-conversation-visibility"[^>]*checked="" value="private"/u);
  });

  it("tells a non-creator the conversation stays visible in a private-by-default workspace", () => {
    const markup = render(
      "en",
      createElement(MoveConversationVisibility, {
        destinationName: "Analytik",
        destinationDefaultConversationVisibility: "private",
        visibility: "workspace",
        movedByCreator: false,
        onChange: noop
      })
    );

    expect(markup).not.toContain('type="radio"');
    expect(markup).toContain(
      "Every member of Analytik can open it. Only the person who started it can make it private."
    );
  });

  it("orders destinations with the Personal Workspace first", () => {
    const destinations = moveConversationDestinations(
      [
        secondSharedCollaborationWorkspace,
        personalCollaborationWorkspace,
        sharedCollaborationWorkspace
      ],
      sharedCollaborationWorkspace.id
    );

    expect(destinations.map((destination) => destination.id)).toEqual([
      personalCollaborationWorkspace.id,
      secondSharedCollaborationWorkspace.id
    ]);
  });
});

describe("delete collaboration workspace dialog", () => {
  it("shows what the deletion removes before asking for the name", () => {
    const markup = render(
      "de",
      createElement(CollaborationWorkspaceDeletionImpactStep, {
        collaborationWorkspaceName: "Produktteam",
        deletionImpact: { conversationCount: 12, memberCount: 4, pendingAccessRequestCount: 2 },
        loading: false,
        loadFailed: false,
        onCancel: noop,
        onContinue: noop
      })
    );

    expect(markup).toContain("verschwindet der Arbeitsbereich für alle darin");
    expect(markup).toContain("12 Unterhaltungen werden gelöscht");
    expect(markup).toContain("4 Mitglieder verlieren den Zugriff.");
    expect(markup).toContain("2 offene Zugriffsanfragen werden verworfen.");
    expect(markup).toContain("Weiter");
  });

  it("blocks the second step while the impact is unknown", () => {
    const loadingMarkup = render(
      "de",
      createElement(CollaborationWorkspaceDeletionImpactStep, {
        collaborationWorkspaceName: "Produktteam",
        deletionImpact: undefined,
        loading: true,
        loadFailed: false,
        onCancel: noop,
        onContinue: noop
      })
    );
    const failedMarkup = render(
      "de",
      createElement(CollaborationWorkspaceDeletionImpactStep, {
        collaborationWorkspaceName: "Produktteam",
        deletionImpact: undefined,
        loading: false,
        loadFailed: true,
        onCancel: noop,
        onContinue: noop
      })
    );

    expect(loadingMarkup).toContain("Es wird geprüft, was diese Löschung entfernt…");
    expect(loadingMarkup).toContain('disabled=""');
    expect(failedMarkup).toContain("Was diese Löschung entfernt, konnte nicht geladen werden.");
    expect(failedMarkup).toContain('disabled=""');
  });

  it("asks for the exact workspace name and keeps the destructive button disabled", () => {
    const markup = render(
      "de",
      createElement(CollaborationWorkspaceDeletionConfirmStep, {
        collaborationWorkspaceName: "Produktteam",
        pending: false,
        errorMessage: undefined,
        nameErrorMessage: undefined,
        onBack: noop,
        onDelete: noop
      })
    );

    expect(markup).toContain("Gib „Produktteam“ ein, um zu bestätigen");
    expect(markup).toContain('id="collaboration-workspace-delete-confirm"');
    expect(markup).toContain('type="submit" disabled=""');
    expect(markup).toContain("Zurück");
  });

  it("surfaces a rejected name next to the input", () => {
    const markup = render(
      "de",
      createElement(CollaborationWorkspaceDeletionConfirmStep, {
        collaborationWorkspaceName: "Produktteam",
        pending: false,
        errorMessage: undefined,
        nameErrorMessage: "Dieser Name stimmt nicht mit dem Namen des Arbeitsbereichs überein.",
        onBack: noop,
        onDelete: noop
      })
    );

    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain("Dieser Name stimmt nicht mit dem Namen des Arbeitsbereichs überein.");
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

describe("collaboration workspace emoji picker", () => {
  function countOccurrences(markup: string, needle: string): number {
    return markup.split(needle).length - 1;
  }

  function renderCreateDialog(locale: "de" | "en"): string {
    return render(
      locale,
      createElement(CreateCollaborationWorkspaceDialog, {
        open: true,
        pending: false,
        errorMessage: undefined,
        initialAccentColor: "violet",
        onClose: noop,
        onCreate: noop
      })
    );
  }

  it("keeps the quick picks and hides the curated grid until More is used", () => {
    const markup = renderCreateDialog("en");

    expect(countOccurrences(markup, 'data-testid="collaboration-workspace-emoji-none"')).toBe(1);
    for (const emoji of collaborationWorkspaceEmojiSuggestions) {
      expect(markup).toContain(`>${emoji}</button>`);
    }
    expect(markup).toMatch(
      /aria-expanded="false"[^>]*data-testid="collaboration-workspace-emoji-more"/u
    );
    expect(markup).toContain(">More<");
    // The toggle's aria-controls names the grid, so only the grid itself counts.
    expect(markup).not.toContain('data-testid="collaboration-workspace-emoji-grid"');
    expect(markup).not.toContain("collaboration-workspace-emoji-choice");
  });

  it("labels the toggle in German", () => {
    const markup = renderCreateDialog("de");

    expect(markup).toContain(">Mehr<");
    expect(markup).not.toContain(">Weniger<");
  });

  it("offers the toggle on the General page as well", () => {
    const markup = generalView(sharedCollaborationWorkspace);

    expect(markup).toContain('data-testid="collaboration-workspace-emoji-more"');
    expect(markup).toContain(">Mehr<");
  });

  it("renders more than a hundred selectable tiles once the grid is open", () => {
    const markup = render(
      "de",
      createElement(CollaborationWorkspaceEmojiGrid, {
        value: "🧩",
        onChange: noop
      })
    );

    expect(
      countOccurrences(markup, 'data-testid="collaboration-workspace-emoji-choice"')
    ).toBeGreaterThan(100);
    expect(markup).toMatch(
      /data-testid="collaboration-workspace-emoji-grid"[^>]*class="chat-scrollbar/u
    );
    /*
      A whole number of rows: h-7 tiles on a gap-1 row gap make a 2rem pitch, so
      six rows plus the p-1 offset end at 12.25rem. Anything else cuts the last
      row through the middle of its emoji.
    */
    expect(markup).toContain("max-h-[12.25rem]");
    expect(markup).toContain("gap-1");
    expect(markup).toContain('aria-label="Weitere Emojis"');
    expect(markup).toMatch(
      /aria-pressed="true"[^>]*data-testid="collaboration-workspace-emoji-choice"[^>]*>🧩</u
    );
  });

  it("curates a duplicate-free list that keeps the quick picks", () => {
    // Broad enough to be worth browsing, bounded so it stays a curated list.
    expect(collaborationWorkspaceEmojiChoices.length).toBeGreaterThan(180);
    expect(collaborationWorkspaceEmojiChoices.length).toBeLessThanOrEqual(260);
    expect(new Set(collaborationWorkspaceEmojiChoices).size).toBe(
      collaborationWorkspaceEmojiChoices.length
    );
    for (const emoji of collaborationWorkspaceEmojiSuggestions) {
      expect(collaborationWorkspaceEmojiChoices).toContain(emoji);
    }
  });

  it("covers the property and financing vocabulary these deployments run on", () => {
    /*
      The first cut of this list had no house in it at all, which is a poor
      showing for products about buying and financing property. These are the
      words people reach for when naming such a workspace.
    */
    for (const emoji of ["🏠", "🏡", "🏘️", "🏚️", "🏢", "🏦", "🧱", "🚪", "🔑", "📐", "💶", "💰"]) {
      expect(collaborationWorkspaceEmojiChoices).toContain(emoji);
    }
  });
});

describe("collaboration workspace dialog chrome", () => {
  const scrollBody = 'data-testid="collaboration-workspace-dialog-scroll-body"';
  const pinnedFooter = '<div class="flex items-center justify-end gap-2 border-t px-5 py-4">';

  it("gives every workspace dialog the same scroll body padding and gutter", () => {
    for (const markup of [
      render(
        "de",
        createElement(CreateCollaborationWorkspaceDialog, {
          open: true,
          pending: false,
          errorMessage: undefined,
          initialAccentColor: "violet",
          onClose: noop,
          onCreate: noop
        })
      ),
      render(
        "de",
        createElement(BrowseCollaborationWorkspacesDialog, {
          open: true,
          collaborationWorkspaces: [
            {
              id: "cw_open",
              name: "Offene Runde",
              description: null,
              emoji: null,
              accentColor: null,
              accessState: "can_request",
              createdAt: "2026-06-27T00:00:00.000Z"
            }
          ],
          loading: false,
          loadFailed: false,
          errorMessage: undefined,
          pendingCollaborationWorkspaceId: undefined,
          onRequestAccess: noop,
          onClose: noop
        })
      )
    ]) {
      // Equal breathing room at both cut edges, and a gutter to the thumb.
      expect(markup).toMatch(
        new RegExp(`${scrollBody}[^>]*class="chat-scrollbar overflow-y-auto py-5 pl-5 pr-3`, "u")
      );
      expect(markup).toContain(pinnedFooter);
    }
  });

  it("themes the member candidate dropdown inside its own frame", () => {
    const markup = render(
      "de",
      createElement(CollaborationWorkspaceMemberCandidateList, {
        candidates: [
          {
            userId: "user_neu",
            email: "neu@example.com",
            displayLabel: "Neue Person",
            hasPendingAccessRequest: false
          }
        ],
        highlightedIndex: -1,
        onSelect: noop
      })
    );

    expect(markup).toMatch(/role="listbox"[^>]*class="chat-scrollbar[^"]*overflow-y-auto/u);
    // The rounded frame is a wrapper, so the thumb never runs under its radius.
    expect(markup).toMatch(/<div class="absolute[^"]*rounded-md border[^"]*"><ul/u);
  });
});

describe("collaboration workspace appearance preview", () => {
  it("previews the draft appearance in the create dialog too", () => {
    const markup = render(
      "de",
      createElement(CreateCollaborationWorkspaceDialog, {
        open: true,
        pending: false,
        errorMessage: undefined,
        initialAccentColor: "magenta",
        onClose: noop,
        onCreate: noop
      })
    );

    // The avatar and the checked swatch read the same state, so the preview
    // cannot drift from the field driving it.
    expect(markup).toContain('data-collaboration-workspace-accent="magenta"');
    expect(markup).toMatch(
      /data-collaboration-workspace-accent="magenta"[^>]*data-testid="collaboration-workspace-accent-magenta"/u
    );
  });

  it("offers the whole palette as a wrapping grid of swatches", () => {
    const markup = generalView(sharedCollaborationWorkspace);

    for (const accentColor of collaborationWorkspaceAccentColors) {
      expect(markup, accentColor).toContain(
        `data-testid="collaboration-workspace-accent-${accentColor}"`
      );
    }

    // Fixed-width columns rather than flex-wrap, so the rows line up.
    expect(markup).toContain("grid-cols-[repeat(auto-fill,2rem)]");
  });
});
