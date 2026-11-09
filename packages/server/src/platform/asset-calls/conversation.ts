import type { ConversationRenameCalls } from "@work-shape/catalyst-tool-execution";
import { runThreadIsReadOnly } from "../../conversations/conversation-access";
import { renameChatConversation } from "../../conversations/conversation-rename";
import type { AssetCallScope } from "./scope";

/** Renaming the conversation a call came from. */
export function conversationCalls(scope: AssetCallScope): ConversationRenameCalls {
  const { options, conversationOf } = scope;
  return {
    async renameConversation(context, title) {
      const conversation = await conversationOf(context);
      // An agent step's thread has no root to read it through, and the call comes from inside.
      if (conversation.kind === "run_thread") throw runThreadIsReadOnly();
      const renamed = await renameChatConversation(
        options,
        conversation.id,
        title,
        context.user,
        context.correlationId
      );
      return { title: renamed.title };
    }
  };
}
