import { requireConversationAccess, type ChatAttachmentService } from "@work-shape/catalyst-server";
import type { WorkspaceCommandService } from "@work-shape/catalyst-tool-execution";
import {
  asConversationId,
  asManagedFileId,
  connectionCallError,
  getSubjectUserId,
  isAppError,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type ConnectionConversationFiles,
  type ConnectionWorkspaceFiles,
  type KnowledgeFiles,
  type ObjectStorage,
  type PlatformStores
} from "@work-shape/catalyst-core";

interface ConversationFileParts {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  attachments: Pick<ChatAttachmentService, "readConversationFile"> | undefined;
}

/**
 * A file of a Conversation as `actor` may open it now: read as
 * `conversations.files.get_content` reads it, through the attachment service that stores it. A
 * service principal is no person and opens none.
 */
async function openConversationFile(
  { clientInstanceId, stores, attachments }: ConversationFileParts,
  actor: AuthenticatedIdentity,
  ref: { conversationId: string; fileId: string }
) {
  if (!attachments || isAuthenticatedServicePrincipal(actor)) return undefined;
  const conversationId = asConversationId(ref.conversationId);
  try {
    await requireConversationAccess({ clientInstanceId, stores }, conversationId, actor);
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") return undefined;
    throw error;
  }
  const attachment = await stores.files.findConversationAttachmentByFile({
    clientInstanceId,
    conversationId,
    fileId: asManagedFileId(ref.fileId)
  });
  if (attachment?.status !== "ready") return undefined;
  return {
    filename: attachment.filename,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    byteSize: attachment.byteSize,
    async read() {
      const file = await attachments.readConversationFile({
        conversationId,
        fileId: ref.fileId
      });
      return file.bytes;
    }
  };
}

/**
 * The files a person adds to a Knowledge Base: a file of a Conversation they may read. Copies go
 * to the instance's store of files.
 */
export function createKnowledgeFiles(
  input: ConversationFileParts & { objects: ObjectStorage }
): KnowledgeFiles {
  return {
    objects: input.objects,
    open: (actor, ref) => openConversationFile(input, actor, ref)
  };
}

/**
 * The files a Connection operation may take, named by one field: an attachment of the
 * conversation the call is made in, by its fileId, or else a file of its execution workspace, by
 * its path, such as a deck the agent made. A subagent's thread holds no attachments of its own,
 * so it is resolved to its root chat, as every tool that takes a conversation file does, and
 * reads its root's workspace. A person must be allowed to open the root chat now. An agent
 * step's thread has no root chat: it, and a service principal, reach only the workspace of the
 * thread, as its workspace tools do.
 */
export function createConnectionConversationFiles(
  input: ConversationFileParts & { workspace?: Pick<WorkspaceCommandService, "openFile"> }
): ConnectionConversationFiles {
  return {
    async open(actor, ref) {
      const conversation = await input.stores.conversations.getConversation(
        input.clientInstanceId,
        asConversationId(ref.conversationId)
      );
      if (!conversation) return undefined;
      const rootId =
        conversation.kind === "run_thread" ? conversation.parentConversationId : conversation.id;
      if (rootId) {
        const file = await openConversationFile(input, actor, {
          conversationId: rootId,
          fileId: ref.fileId
        });
        if (file) return { byteSize: file.byteSize, read: file.read };
      }
      if (!input.workspace) return undefined;
      if (isAuthenticatedServicePrincipal(actor)) {
        // Only the thread of a Workflow agent step, which has no root chat.
        if (conversation.kind !== "run_thread" || rootId) return undefined;
      } else if (rootId) {
        try {
          await requireConversationAccess(input, asConversationId(rootId), actor);
        } catch (error) {
          if (isAppError(error) && error.code === "NOT_FOUND") return undefined;
          throw error;
        }
      }
      const file = await input.workspace.openFile({
        clientInstanceId: input.clientInstanceId,
        conversationId: conversation.id,
        path: ref.fileId
      });
      return file && { byteSize: file.byteSize, read: file.read };
    }
  };
}

/**
 * Where a Connection operation that `producesFiles` saves: the execution workspace of the
 * conversation the agent's call is made in, through the store path `web_download` takes. A
 * subagent's thread saves into its root's workspace. A person's call creates the workspace
 * where there is none yet; a service principal's call uses only one that exists, such as a
 * Workflow agent step's with `workspace: true`. The record names the operation as its source.
 */
export function createConnectionWorkspaceFiles(input: {
  clientInstanceId: ClientInstanceId;
  workspace: Pick<WorkspaceCommandService, "saveFile">;
}): ConnectionWorkspaceFiles {
  return {
    async save(actor, ref, file) {
      const saved = await input.workspace.saveFile({
        clientInstanceId: input.clientInstanceId,
        conversationId: asConversationId(ref.conversationId),
        ...(isAuthenticatedServicePrincipal(actor) ? {} : { ownerUserId: getSubjectUserId(actor) }),
        source: ref.operation,
        name: file.name,
        ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
        bytes: file.bytes,
        ...(file.replaces === undefined ? {} : { replaces: file.replaces })
      });
      if (saved.status === "too_large") throw connectionCallError("output_file_too_large");
      if (saved.status === "unavailable") throw connectionCallError("output_file_unavailable");
      return { path: saved.path, byteSize: saved.byteSize };
    }
  };
}
