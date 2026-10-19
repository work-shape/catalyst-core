import { LoadError, Spinner } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { ConversationPane } from "../subagents/conversation-pane";
import type { SelectedChatModel } from "../workspace/workspace-chat-model";
import type { AgentTryPaneState } from "./agent-try";
import { TryRunLinesProvider } from "./try-run-lines";

/**
 * The conversation of the chat route or of the dock; on an agent's page the dock's Try. Try
 * sends to the agent under construction, never to the agent picked elsewhere, and says in its
 * thread where another draft revision answers. While the instance opens Try's conversation
 * nothing can be sent, so no other conversation is started in its place.
 */
export function DockConversationPane({
  chat,
  agentTry
}: {
  chat: SelectedChatModel;
  agentTry: AgentTryPaneState | undefined;
}) {
  if (agentTry === undefined) return <ConversationPane chat={chat} />;
  if (agentTry.opening) return <TryOpening failed={agentTry.failed} onRetry={agentTry.retry} />;
  return (
    <TryRunLinesProvider messages={chat.messages}>
      <ConversationPane chat={{ ...chat, selectedAgentName: agentTry.agent }} />
    </TryRunLinesProvider>
  );
}

/** Try while the instance opens its conversation, or after that failed. */
export function TryOpening({ failed, onRetry }: { failed: boolean; onRetry(): void }) {
  const { t } = useTranslation();
  return (
    <div className="grid h-full place-items-center px-5" data-testid="try-opening">
      {failed ? (
        <LoadError onRetry={onRetry}>{t("dock.tryFailed")}</LoadError>
      ) : (
        <p className="flex items-center gap-2 text-body text-muted-foreground" role="status">
          <Spinner size="sm" />
          {t("dock.tryOpening")}
        </p>
      )}
    </div>
  );
}
