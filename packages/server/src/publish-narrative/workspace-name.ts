import {
  personalWorkspaceOwnerName,
  type CollaborationWorkspace,
  type LocaleCode
} from "@work-shape/catalyst-core";

// What a workspace is called where the server writes it into a sentence for one reader: the
// name the interface shows (chat-ui `collaborationWorkspaceDisplayName`). A Personal Workspace
// is named after its owner, "Mara's workspace"; the name stored on its row is the same
// "Personal workspace" for everyone and is never shown.

/** A workspace as far as its name goes. A store that answers no kind names a shared one. */
export type NamedWorkspace = Pick<CollaborationWorkspace, "name"> &
  Partial<Pick<CollaborationWorkspace, "kind" | "personalUserId">>;

/** "Mara's workspace", or "Personal workspace" where no name of the owner is known. */
function personalWorkspaceName(ownerLabel: string | undefined, locale: LocaleCode): string {
  const owner = personalWorkspaceOwnerName(ownerLabel);
  if (locale === "de") {
    if (owner === undefined) return "Persönlicher Arbeitsbereich";
    return owner.sibilant ? `${owner.name}' Arbeitsbereich` : `${owner.name}s Arbeitsbereich`;
  }
  return owner === undefined ? "Personal workspace" : `${owner.name}'s workspace`;
}

/**
 * The name a workspace is shown under in `locale`. `ownerLabel` reads the display label of a
 * Personal Workspace's owner; it is asked only for one.
 */
export async function workspaceDisplayName(
  workspace: NamedWorkspace,
  locale: LocaleCode,
  ownerLabel: (userId: string) => Promise<string | undefined>
): Promise<string> {
  if (workspace.kind !== "personal") return workspace.name;
  const owner = workspace.personalUserId
    ? await ownerLabel(workspace.personalUserId).catch(() => undefined)
    : undefined;
  return personalWorkspaceName(owner, locale);
}
