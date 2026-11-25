import type { HistoryCalls } from "@work-shape/catalyst-tool-execution";
import { requireConversationAccess } from "../../conversations/conversation-access";
import {
  readConversationMessages,
  recallAnchorOf,
  searchConversationMessages,
  shownRecallHit
} from "../../conversations/conversation-recall";
import type { AssetCallScope } from "./scope";

/** The word a read names for the run's cut instead of a message id. */
const CUT = "cut";

/**
 * The agent's search and read of its own conversation (RECALL-1): the conversation the call
 * came from, which the person must read, and no other. The run's cut says which messages its
 * model did not get.
 */
export function historyCalls(scope: AssetCallScope): HistoryCalls {
  const { options, conversationOf } = scope;
  const ownConversation = async (context: Parameters<HistoryCalls["searchHistory"]>[0]) => {
    const conversation = await conversationOf(context);
    await requireConversationAccess(options, conversation.id, context.user);
    return conversation;
  };
  return {
    async searchHistory(context, input) {
      const conversation = await ownConversation(context);
      const cut = context.historyCut?.messageId;
      // The run sent its model every message: nothing is before the cut.
      if (input.beforeCut && cut === undefined) return { hits: [], more: false };
      const found = await searchConversationMessages(options, {
        conversationIds: [conversation.id],
        query: input.query,
        ...(input.beforeCut && cut !== undefined ? { before: cut } : {}),
        limit: input.limit
      });
      return {
        hits: found.hits.map(shownRecallHit),
        more: found.more
      };
    },

    async readHistory(context, input) {
      const conversation = await ownConversation(context);
      let { before } = input;
      if (before === CUT) {
        before = context.historyCut?.messageId;
        if (before === undefined) return { messages: [], moreBefore: false, moreAfter: false };
      }
      return readConversationMessages(options, {
        conversationId: conversation.id,
        anchor: recallAnchorOf({ ...input, before }),
        limit: input.limit
      });
    }
  };
}
