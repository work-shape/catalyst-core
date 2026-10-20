import { AssistantRuntimePanel } from "../assistant/assistant-runtime-panel";
import { ConversationGone } from "../conversation/conversation-gone";
import type { SelectedChatModel } from "../workspace/workspace-chat-model";
import { useWorkspaceRouteState } from "../workspace/workspace-ui-state";
import { SubagentThreadView } from "./subagent-thread-view";

/**
 * The conversation of the chat route, or one of its subagents' threads where the address
 * names one (CR-1). The thread keeps its conversation's Resources and rail beside it.
 */
export function ConversationPane({ chat }: { chat: SelectedChatModel }) {
  const { route } = useWorkspaceRouteState();
  if (route.kind === "subagent-thread") {
    return <SubagentThreadView key={route.threadId} route={route} />;
  }
  // A conversation that is gone shows no empty thread and no composer, only that it is gone.
  return chat.conversationGone ? (
    <ConversationGone key={chat.selectedConversationId} onNewChat={chat.startNewConversation} />
  ) : (
    <AssistantRuntimePanel chat={chat} />
  );
}
