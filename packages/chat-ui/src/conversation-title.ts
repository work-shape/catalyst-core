import type { Conversation } from "@vivd-stage/api-client";

export function currentTitle(
  conversations: Conversation[],
  selectedConversationId: string | undefined
): string {
  return (
    conversations.find((conversation) => conversation.id === selectedConversationId)?.title ??
    "New conversation"
  );
}

export function firstLineTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "New conversation";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine || "New conversation";
}
