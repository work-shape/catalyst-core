import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { ArrowLeft } from "lucide-react";
import { Button, NotFound, Spinner } from "@work-shape/catalyst-ui";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useWorkspaceThreadQuery } from "../../shared/api/workspace-queries";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { useTranslation } from "../../shared/i18n";
import type { WorkspaceRoute } from "../../shared/routes";
import { apiErrorStatus } from "../../shared/workspace-utils";
import { ToolDecisionsProvider } from "../approvals/tool-decision-context";
import { ThreadMessage } from "../assistant/assistant-message";
import { AssistantToolRegistry } from "../assistant/assistant-tool-registry";
import {
  createMessageSnapshotKey,
  toAiSdkMessageRepository,
  toUiMessages
} from "../assistant/assistant-ui-adapter";
import { isLiveRunStatus } from "../conversation/conversation-controller-state";
import { useConversationController } from "../conversation/use-conversation-controller";
import { WORKSPACE_AUTH_SCOPE } from "../workspace/workspace-chat-state";
import { useWorkspaceRouteState } from "../workspace/workspace-ui-state";
import { SubagentLine } from "./subagent-card";
import { requestToolCallReveal, subagentState } from "./subagent-model";
import { useRefreshSubagents, useSubagentsQuery } from "./subagent-queries";

type SubagentThreadRoute = Extract<WorkspaceRoute, { kind: "subagent-thread" }>;

/**
 * A subagent's thread as its own read-only view (CR-1): its task as the first message, then
 * its messages and tool calls as in any conversation, live while it runs. It has no composer;
 * its head has Stop while it runs and the way back to the call that started it.
 */
export function SubagentThreadView({ route }: { route: SubagentThreadRoute }) {
  const { t } = useTranslation();
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const queryClient = useQueryClient();
  const { showConversation } = useWorkspaceRouteState();
  const refreshSubagents = useRefreshSubagents();
  const { collaborationWorkspaceId, conversationId, threadId } = route;
  const threadQuery = useWorkspaceThreadQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    conversationId: threadId,
    enabled: true
  });
  const subagent = useSubagentsQuery({ conversationId, enabled: true }).data?.find(
    (item) => item.threadId === threadId
  );
  const refreshSnapshot = useCallback(
    (id: string) =>
      queryClient.refetchQueries({
        queryKey: workspaceQueryKeys.thread(apiBaseUrl, WORKSPACE_AUTH_SCOPE, id)
      }),
    [apiBaseUrl, queryClient]
  );
  const onTerminalObservation = useCallback(
    () => refreshSubagents(conversationId),
    [conversationId, refreshSubagents]
  );
  const controller = useConversationController({
    client,
    conversationId: threadId,
    enabled: true,
    snapshot: threadQuery.data,
    snapshotLoading: threadQuery.isLoading,
    snapshotError: threadQuery.error,
    refreshSnapshot,
    onTerminalObservation
  });
  const back = useCallback(() => {
    if (subagent) requestToolCallReveal(subagent.toolCallId);
    showConversation(collaborationWorkspaceId, conversationId);
  }, [collaborationWorkspaceId, conversationId, showConversation, subagent]);

  const backButton = (
    <Button variant="ghost" size="sm" onClick={back}>
      <ArrowLeft aria-hidden="true" />
      {t("subagents.back")}
    </Button>
  );

  if (threadQuery.error) {
    return (
      <NotFound action={backButton}>
        {apiErrorStatus(threadQuery.error) === 404
          ? t("subagents.notFound")
          : t("subagents.loadFailed")}
      </NotFound>
    );
  }

  const description = subagent?.description ?? threadQuery.data?.conversation.title ?? "";
  const runStatus = controller.activeRun?.run.status;
  const state = subagentState(
    runStatus !== undefined && isLiveRunStatus(runStatus) ? runStatus : subagent?.status
  );

  return (
    <section
      className="grid h-full min-h-0 min-w-0 overflow-hidden bg-background"
      aria-label={t("subagents.subagent")}
      data-testid="subagent-thread"
    >
      <ReadOnlyThread
        controller={controller}
        head={
          <div className="grid gap-3 pb-6">
            <div>{backButton}</div>
            <SubagentLine
              subagent={subagent}
              description={description}
              rootConversationId={conversationId}
              state={state}
              framed
              openable={false}
            />
            <p className="px-1 text-caption text-muted-foreground">{t("subagents.readOnly")}</p>
          </div>
        }
        loading={controller.snapshotStatus !== "ready"}
        loadingLabel={t("subagents.loading")}
      />
    </section>
  );
}

function ReadOnlyThread({
  controller,
  head,
  loading,
  loadingLabel
}: {
  controller: ReturnType<typeof useConversationController>;
  head: ReactNode;
  loading: boolean;
  loadingLabel: string;
}) {
  const { activeRun, completedRunProjections, messages } = controller;
  const uiMessages = useMemo(
    () => toUiMessages(messages, activeRun, completedRunProjections),
    [activeRun, completedRunProjections, messages]
  );
  const syncKey = useMemo(
    () => createMessageSnapshotKey(messages, activeRun, completedRunProjections),
    [activeRun, completedRunProjections, messages]
  );
  const transport = useMemo(() => new ReadOnlyTransport(), []);
  const runtime = useChatRuntime({ messages: uiMessages, transport, isSendDisabled: true });
  useEffect(() => {
    runtime.thread.importExternalState(toAiSdkMessageRepository(uiMessages));
  }, [runtime, syncKey, uiMessages]);
  const running = activeRun !== undefined && isLiveRunStatus(activeRun.run.status);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ToolDecisionsProvider parts={undefined}>
        <AssistantToolRegistry>
          <ThreadPrimitive.Root className="grid h-full min-h-0 min-w-0 overflow-hidden">
            <ThreadPrimitive.Viewport
              turnAnchor="top"
              scrollToBottomOnRunStart={false}
              className="chat-thread-inset relative flex min-h-0 flex-col overflow-y-auto overflow-x-hidden"
            >
              <div className="mx-auto flex w-full max-w-[52rem] flex-1 flex-col px-5 pt-(--thread-start,5rem) pb-12">
                {head}
                {loading ? (
                  <p
                    className="flex items-center gap-2 py-1 text-body text-muted-foreground"
                    role="status"
                  >
                    <Spinner size="sm" />
                    {loadingLabel}
                  </p>
                ) : (
                  <div className="flex flex-col gap-6">
                    <ThreadPrimitive.Messages>
                      {() => (
                        <ThreadMessage
                          conversationRunning={running}
                          activeRunId={running ? activeRun?.run.id : undefined}
                        />
                      )}
                    </ThreadPrimitive.Messages>
                  </div>
                )}
              </div>
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
        </AssistantToolRegistry>
      </ToolDecisionsProvider>
    </AssistantRuntimeProvider>
  );
}

/** The transport of a thread nobody writes to: it sends nothing. */
class ReadOnlyTransport implements ChatTransport<UIMessage> {
  async sendMessages(): Promise<ReadableStream<UIMessageChunk>> {
    throw new Error("A subagent's thread takes no message");
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }
}
