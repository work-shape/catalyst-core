import { requireConversationAccess, type ChatAttachmentService } from "@work-shape/catalyst-server";
import {
  asConversationId,
  asManagedFileId,
  isAppError,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type ConnectionConversationFiles,
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
 * The files a Connection operation may take: a file of the conversation the call is made in, for
 * a person who may read it now. A subagent's thread holds no attachments of its own, so it is
 * resolved to its root chat, as every tool that takes a conversation file does. An agent step's
 * thread has no root chat and a service principal opens none: no other file source in this cut.
 */
export function createConnectionConversationFiles(
  input: ConversationFileParts
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
      if (!rootId) return undefined;
      const file = await openConversationFile(input, actor, {
        conversationId: rootId,
        fileId: ref.fileId
      });
      return file && { byteSize: file.byteSize, read: file.read };
    }
  };
}
