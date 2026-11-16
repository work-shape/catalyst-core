import { apiOperations, type ConversationCost } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  asUserId,
  getSubjectUserId,
  type ActorAccess,
  type AuthenticatedUser,
  type Conversation,
  type ConversationId
} from "@work-shape/catalyst-core";
import { requireConversationAccess } from "../conversations/conversation-access";
import type { Route } from "../http/route";
import { conversationIdParam } from "../routes/request-context";
import type { ChatServerOptions } from "../types";

/**
 * The cost of a conversation so far, for the context indicator (LU-7). Whoever reads the chat
 * reads the cost of their own calls in it. In a chat more people read, a holder of `usage.view`
 * reads the whole chat's; a private chat nobody else reads shows its person their own calls.
 * While the instance does not show it, the read answers as for a conversation that is not there.
 */
export function registerConversationCostRoute(route: Route, options: ChatServerOptions): void {
  route(apiOperations["conversations.cost.get"], async ({ user, access, params }) =>
    readConversationCost(options, { user, access, conversationId: conversationIdParam(params) })
  );
}

async function readConversationCost(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId" | "config" | "usageGovernance">,
  input: {
    user: AuthenticatedUser;
    access: ActorAccess;
    conversationId: ConversationId;
  }
): Promise<ConversationCost> {
  if (!options.config.usage.showConversationCost) {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
  const conversation = await requireConversationAccess(options, input.conversationId, input.user);
  if (conversation.kind !== "chat") {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
  const shared = readByOthers(conversation);
  const whole = shared && input.access.authorize("usage.view").allowed;
  const cost = await options.usageGovernance.summarizeConversationCost({
    clientInstanceId: options.clientInstanceId,
    conversationId: conversation.id,
    ...(whole ? {} : { userId: asUserId(getSubjectUserId(input.user)) })
  });
  return { scope: whole ? "conversation" : "own", shared, ...cost };
}

/** A team chat, or a private chat its creator named people on (CHAT-SHARE). */
function readByOthers(conversation: Conversation): boolean {
  return conversation.visibility !== "private" || conversation.people.length > 0;
}
