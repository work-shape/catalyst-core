import {
  AppError,
  RECALL_AROUND_MESSAGES,
  RecallSearchTooBroadError,
  asMessageId,
  recallTsQuery,
  withinRecallBudget,
  type ClientInstanceId,
  type ConversationId,
  type ConversationRecallStore,
  type MessageId,
  type RecallAnchor,
  type RecallHit,
  type RecallMessage
} from "@work-shape/catalyst-core";

// Searching and reading what was said in conversations (RECALL), as the API's search of a
// conversation's messages and the agent's history tools both do it. Whose conversation may be
// searched is the caller's question; this answers within the conversations it is given.

interface RecallOptions {
  clientInstanceId: ClientInstanceId;
  stores: { conversations: ConversationRecallStore };
}

/**
 * The best matches of `query` in these conversations, at most `limit`, and whether there are
 * more. A query without a word or number is refused, and so is one the store gave up on.
 */
export async function searchConversationMessages(
  options: RecallOptions,
  input: {
    conversationIds: readonly ConversationId[];
    query: string;
    before?: MessageId;
    limit: number;
    perConversation?: number;
  }
): Promise<{ hits: RecallHit[]; more: boolean }> {
  const tsQuery = recallTsQuery(input.query);
  if (tsQuery === undefined) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Name at least one word or number to search for",
      { reason: "search_without_words" },
      { exposeMessage: true }
    );
  }
  try {
    // One more than is answered says whether there are more.
    const found = await options.stores.conversations.searchRecallMessages({
      clientInstanceId: options.clientInstanceId,
      conversationIds: input.conversationIds,
      tsQuery,
      ...(input.before === undefined ? {} : { before: input.before }),
      limit: input.limit + 1,
      ...(input.perConversation === undefined ? {} : { perConversation: input.perConversation })
    });
    return { hits: found.slice(0, input.limit), more: found.length > input.limit };
  } catch (error) {
    if (error instanceof RecallSearchTooBroadError) {
      throw new AppError(
        "CONFLICT",
        "Too much to search; use more specific words",
        { reason: "search_too_broad" },
        { exposeMessage: true }
      );
    }
    throw error;
  }
}

/**
 * Messages of one conversation from an anchor, within the budget of one read: a long message is
 * cut, and what does not fit is left for the next read on the side away from the anchor.
 */
export async function readConversationMessages(
  options: RecallOptions,
  input: { conversationId: ConversationId; anchor: RecallAnchor; limit: number }
): Promise<{ messages: RecallMessage[]; moreBefore: boolean; moreAfter: boolean }> {
  const around = "around" in input.anchor;
  const read = await options.stores.conversations.readRecallMessages({
    clientInstanceId: options.clientInstanceId,
    conversationId: input.conversationId,
    anchor: input.anchor,
    limit: around ? RECALL_AROUND_MESSAGES * 2 + 1 : input.limit
  });
  const backward = "before" in input.anchor;
  const { messages, dropped } = withinRecallBudget(
    read.messages,
    backward ? "backward" : "forward"
  );
  return {
    messages,
    moreBefore: read.moreBefore || (dropped && backward),
    moreAfter: read.moreAfter || (dropped && !backward)
  };
}

/** The anchor of a read, from at most one of its three. */
export function recallAnchorOf(input: {
  around?: string;
  after?: string;
  before?: string;
}): RecallAnchor {
  if (input.around !== undefined) return { around: asMessageId(input.around) };
  if (input.after !== undefined) return { after: asMessageId(input.after) };
  if (input.before !== undefined) return { before: asMessageId(input.before) };
  return { start: true };
}
