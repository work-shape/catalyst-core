import { AssistantRuntimePanel } from "./assistant/assistant-runtime-panel";
import type { SelectedChatModel } from "./workspace/workspace-chat-model";

export function AssistantChatPanel({ chat }: { chat: SelectedChatModel }) {
  return <AssistantRuntimePanel chat={chat} />;
}
