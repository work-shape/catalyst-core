import { personalWorkspaceOwnerName } from "@work-shape/catalyst-core";
import type { CollaborationWorkspaceWithRole } from "@work-shape/catalyst-api-client";
import type { TranslationContextValue } from "../i18n";

/**
 * What a Personal Workspace is called in the interface: "Felix's workspace", after its owner.
 * The name stored on its row is the same for everyone and is never shown. Without a name for
 * the owner it stays "Personal workspace".
 */
export function personalCollaborationWorkspaceName(
  ownerLabel: string | undefined,
  translate: TranslationContextValue["t"]
): string {
  const owner = personalWorkspaceOwnerName(ownerLabel);
  if (owner === undefined) {
    return translate("collaborationWorkspacePersonalName");
  }
  return translate(
    owner.sibilant
      ? "collaborationWorkspacePersonalNameOfSibilant"
      : "collaborationWorkspacePersonalNameOf",
    { name: owner.name }
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
