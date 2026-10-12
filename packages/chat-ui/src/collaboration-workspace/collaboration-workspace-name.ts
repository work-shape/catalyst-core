import type { CollaborationWorkspaceWithRole } from "@vivd-catalyst/api-client";
import type { TranslationContextValue } from "../i18n";

/** German sets only an apostrophe after a name that ends in an s sound: "Felix' Arbeitsbereich". */
const ENDS_IN_S_SOUND = /[sßxz]$/iu;

/**
 * The first name in a person's display label. A label that is an e-mail address, as an
 * account without a name has, gives none.
 */
function firstName(ownerLabel: string | undefined): string | undefined {
  const label = ownerLabel?.trim() ?? "";
  if (label === "" || label.includes("@")) {
    return undefined;
  }
  return label.split(/\s+/u)[0];
}

/**
 * What a Personal Workspace is called in the interface: "Felix's workspace", after its owner.
 * The name stored on its row is the same for everyone and is never shown. Without a name for
 * the owner it stays "Personal workspace".
 */
export function personalCollaborationWorkspaceName(
  ownerLabel: string | undefined,
  translate: TranslationContextValue["t"]
): string {
  const name = firstName(ownerLabel);
  if (name === undefined) {
    return translate("collaborationWorkspacePersonalName");
  }
  return translate(
    ENDS_IN_S_SOUND.test(name)
      ? "collaborationWorkspacePersonalNameOfSibilant"
      : "collaborationWorkspacePersonalNameOf",
    { name }
  );
}

/**
 * The name a workspace is shown under. `ownerLabel` is the display label of the Personal
 * Workspace's owner; the lists the interface reads hold only the viewer's own.
 */
export function collaborationWorkspaceDisplayName(
  collaborationWorkspace: Pick<CollaborationWorkspaceWithRole, "kind" | "name">,
  ownerLabel: string | undefined,
  translate: TranslationContextValue["t"]
): string {
  return collaborationWorkspace.kind === "personal"
    ? personalCollaborationWorkspaceName(ownerLabel, translate)
    : collaborationWorkspace.name;
}
