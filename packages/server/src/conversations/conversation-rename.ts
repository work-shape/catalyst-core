import {
  auditActorFromUser,
  type AuthenticatedUser,
  type Conversation,
  type ConversationId
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { requireChatConversationAccess } from "./conversation-access";

/**
 * Renames a chat conversation for a person: what `conversations.rename` does, and what their
 * agent's rename does in the conversation it runs in. A title in the words it already has is
 * still a title they gave, so the title job leaves it, though nothing shows as changed.
 */
export async function renameChatConversation(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId" | "auditRecorder">,
  conversationId: ConversationId,
  title: string,
  user: AuthenticatedUser,
  correlationId: string
): Promise<Conversation> {
  const conversation = await requireChatConversationAccess(options, conversationId, user);
  const unchanged = conversation.title === title;
  const updated = await options.stores.conversations.updateConversationTitle({
    clientInstanceId: options.clientInstanceId,
    conversationId,
    title,
    updatedAt: unchanged ? conversation.updatedAt : new Date().toISOString()
  });
  if (unchanged) {
    return updated;
  }
  await options.auditRecorder.record({
    type: "conversation.renamed",
    status: "success",
    actor: auditActorFromUser(user),
    subject: conversationId,
    correlationId,
    metadata: {
      previousTitleLength: conversation.title.length,
      titleLength: title.length
    }
  });
  return updated;
}
