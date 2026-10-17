import { requireConversationAccess, type ChatAttachmentService } from "@work-shape/catalyst-server";
import {
  asConversationId,
  asManagedFileId,
  isAppError,
  isAuthenticatedServicePrincipal,
  type ClientInstanceId,
  type KnowledgeFiles,
  type ObjectStorage,
  type PlatformStores
} from "@work-shape/catalyst-core";

/**
 * The files a person adds to a Knowledge Base: a file of a Conversation they may read, read as
 * `conversations.files.get_content` reads it, through the attachment service that stores it.
 * Copies go to the instance's store of files. A service principal is no person and opens none.
 */
export function createKnowledgeFiles(input: {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  attachments: Pick<ChatAttachmentService, "readConversationFile"> | undefined;
  objects: ObjectStorage;
}): KnowledgeFiles {
  const { clientInstanceId, stores, attachments } = input;
  return {
    objects: input.objects,
    async open(actor, ref) {
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
  };
}
