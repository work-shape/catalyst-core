import {
  isAppError,
  type ClientInstanceId,
  type ConversationId,
  type ExecutionWorkspace
} from "@work-shape/catalyst-core";
import { workspacePathFromFilename } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";
import {
  checkPathFitsWorkspace,
  checkWorkspaceRoom,
  resolveTextFilePath,
  storeTextFile
} from "./stored-text-file";
import { freePath, withExtension } from "./web-download";

// One file the platform saves into a conversation's execution workspace for a call that is no
// workspace tool, such as a Connection operation that downloads: the store path web_download
// takes, addressed by the conversation instead of a tool request.

export type SavedWorkspaceFile =
  | { status: "saved"; path: string; byteSize: number }
  /** Over the room the workspace has left. Nothing was kept. */
  | { status: "too_large" }
  /** No workspace to save in, or no path the name can take. Nothing was kept. */
  | { status: "unavailable" };

export interface SaveWorkspaceFileInput {
  clientInstanceId: ClientInstanceId;
  /** A subagent's thread saves into its root's workspace, as its workspace tools do. */
  conversationId: ConversationId;
  /**
   * The person a missing workspace is created for. Without one (a service principal) only a
   * workspace that exists is used, such as a Workflow agent step's with `workspace: true`.
   */
  ownerUserId?: string;
  /** What the file's record names as its source. */
  source: string;
  name: string;
  mediaType?: string;
  bytes: Uint8Array;
  /** A path saved before, which this save replaces. Without it the name takes a free path. */
  replaces?: string;
}

const OCTET_STREAM = "application/octet-stream";
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;

export async function saveWorkspaceFile(
  deps: WorkspaceToolDependencies,
  input: SaveWorkspaceFileInput
): Promise<SavedWorkspaceFile> {
  const { fileStore } = deps;
  if (!fileStore) return { status: "unavailable" };
  const workspace = await workspaceOf(deps, input);
  if (!workspace) return { status: "unavailable" };
  const files = await deps.store.executionWorkspaces.listWorkspaceFiles({
    clientInstanceId: input.clientInstanceId,
    workspaceId: workspace.id
  });
  const mediaType = mediaTypeOf(input.mediaType);
  // Like a name a server gives in web_download: it never replaces a file, such as an imported
  // attachment of the same name, and takes the next free name instead.
  const target = resolveTextFilePath(
    input.replaces ??
      freePath(files, withExtension(workspacePathFromFilename(input.name, "download"), mediaType)),
    deps.limits
  );
  if (target.status === "failed") return { status: "unavailable" };
  if (checkPathFitsWorkspace(files, target.value).status === "failed") {
    return { status: "unavailable" };
  }
  const room = checkWorkspaceRoom(deps, files, target.value, input.bytes.byteLength);
  if (room.status === "failed") return { status: "too_large" };
  const stored = await storeTextFile(
    { ...deps, fileStore },
    { clientInstanceId: input.clientInstanceId },
    {
      toolName: input.source,
      workspace: {
        handle: { kind: "execution_workspace", id: workspace.id },
        conversationId: workspace.conversationId
      },
      path: target.value,
      bytes: input.bytes,
      // A replaced file keeps nothing of what it was.
      existing: undefined,
      mimeType: mediaType
    }
  );
  return { status: "saved", path: stored.path, byteSize: stored.byteSize };
}

async function workspaceOf(
  deps: WorkspaceToolDependencies,
  input: SaveWorkspaceFileInput
): Promise<ExecutionWorkspace | undefined> {
  const { clientInstanceId, conversationId, ownerUserId } = input;
  try {
    return ownerUserId === undefined
      ? await deps.store.executionWorkspaces.findExecutionWorkspaceOfActiveConversation({
          clientInstanceId,
          conversationId
        })
      : await deps.store.executionWorkspaces.ensureExecutionWorkspace({
          clientInstanceId,
          conversationId,
          ownerUserId,
          now: deps.now()
        });
  } catch (error) {
    // The conversation is not active, or a subagent's thread has no root.
    if (isAppError(error) && error.code === "NOT_FOUND") return undefined;
    throw error;
  }
}

/** The media type without its parameters, or the one of any bytes where it is not one. */
function mediaTypeOf(value: string | undefined): string {
  const mediaType = value?.split(";")[0]?.trim().toLowerCase();
  return mediaType && MEDIA_TYPE.test(mediaType) ? mediaType : OCTET_STREAM;
}
