import { AssistantRuntimePanel } from "../assistant/assistant-runtime-panel";
import type { SelectedChatModel } from "../workspace/workspace-chat-model";
import { useWorkspaceRouteState } from "../workspace/workspace-ui-state";
import { SubagentThreadView } from "./subagent-thread-view";

/**
 * The conversation of the chat route, or one of its subagents' threads where the address
 * names one (CR-1). The thread keeps its conversation's Resources and rail beside it.
 */
export function ConversationPane({ chat }: { chat: SelectedChatModel }) {
  const { route } = useWorkspaceRouteState();
  return route.kind === "subagent-thread" ? (
    <SubagentThreadView key={route.threadId} route={route} />
  ) : (
    <AssistantRuntimePanel chat={chat} />
  );
}
