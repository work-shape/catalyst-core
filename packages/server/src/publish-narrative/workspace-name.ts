import type { CollaborationWorkspace, LocaleCode } from "@work-shape/catalyst-core";

// What a workspace is called where the server writes it into a sentence for one reader: the
// name the interface shows (chat-ui `collaborationWorkspaceDisplayName`). A Personal Workspace
// is named after its owner, "Mara's workspace"; the name stored on its row is the same
// "Personal workspace" for everyone and is never shown.

/** A workspace as far as its name goes. A store that answers no kind names a shared one. */
export type NamedWorkspace = Pick<CollaborationWorkspace, "name"> &
  Partial<Pick<CollaborationWorkspace, "kind" | "personalUserId">>;

/** German sets only an apostrophe after a name that ends in an s sound: "Felix' Arbeitsbereich". */
const ENDS_IN_S_SOUND = /[sßxz]$/iu;

/** The first name in a display label. A label that is an e-mail address gives none. */
function firstName(ownerLabel: string | undefined): string | undefined {
  const label = ownerLabel?.trim() ?? "";
  if (label === "" || label.includes("@")) return undefined;
  return label.split(/\s+/u)[0];
}

/** "Mara's workspace", or "Personal workspace" where no name of the owner is known. */
function personalWorkspaceName(ownerLabel: string | undefined, locale: LocaleCode): string {
  const name = firstName(ownerLabel);
  if (locale === "de") {
    if (name === undefined) return "Persönlicher Arbeitsbereich";
    return ENDS_IN_S_SOUND.test(name) ? `${name}' Arbeitsbereich` : `${name}s Arbeitsbereich`;
  }
  return name === undefined ? "Personal workspace" : `${name}'s workspace`;
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
