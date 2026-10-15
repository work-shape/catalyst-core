import {
  FOUND_FILE_KINDS,
  getSubjectUserId,
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
  type FoundFile,
  type FoundFileKind,
  type StorePage
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "./types";
import { requireWorkspaceAccess } from "./workspace-access";

/** The module whose switch makes Pages exist. Off, none is found. */
const PAGES_MODULE = "apps";

/**
 * The Pages and files a person finds in a workspace: those of its conversations the person may
 * read, newest first, with what they are called and where they live. A workspace the person
 * is no member of is answered as one that does not exist. `workspaces.files.list` and the
 * agent's `platform.files.list` both call this.
 */
export async function findWorkspaceFiles(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId" | "modules">,
  input: {
    user: AuthenticatedUser;
    collaborationWorkspaceId: CollaborationWorkspaceId;
    kind?: FoundFileKind;
    text?: string;
    page: StorePage;
  }
): Promise<FoundFile[]> {
  await requireWorkspaceAccess(options, input.user, input.collaborationWorkspaceId);
  const kinds = (input.kind === undefined ? FOUND_FILE_KINDS : [input.kind]).filter(
    (kind) => kind !== "page" || options.modules.isEnabled(PAGES_MODULE)
  );
  return options.stores.conversations.searchWorkspaceFiles({
    clientInstanceId: options.clientInstanceId,
    collaborationWorkspaceId: input.collaborationWorkspaceId,
    viewerUserId: getSubjectUserId(input.user),
    kinds,
    ...(input.text === undefined ? {} : { text: input.text }),
    page: input.page
  });
}
