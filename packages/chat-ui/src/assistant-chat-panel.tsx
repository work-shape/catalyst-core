import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import {
  AssistantRuntimeProvider,
  useComposer,
  useComposerRuntime,
} from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import type { ApiClient, LocaleCode, Message, SafeConfig } from "@vivd-catalyst/api-client";
import { AssistantThread } from "./assistant-thread";
import { firstLineTitle } from "./conversation-title";

export function AssistantChatPanel({
  apiBaseUrl,
  client,
  config,
  selectedConversationId,
  messages,
  messagesLoaded,
  notice,
  draft,
  locale,
  selectedAgentName,
  onDraftChange,
  onConversationStarted,
  onStreamFinished,
  onStreamError
}: {
  apiBaseUrl: string;
  client: ApiClient;
  config: SafeConfig | undefined;
  selectedConversationId: string | undefined;
  messages: Message[] | undefined;
  messagesLoaded: boolean;
  notice: string | undefined;
  draft: string;
  locale: LocaleCode;
  selectedAgentName: string | undefined;
  onDraftChange: (value: string) => void;
  onConversationStarted: (conversationId: string, messages?: Message[]) => void;
  onStreamFinished: () => void;
  onStreamError: (message: string) => void;
}) {
  const initialMessages = useMemo(() => toUiMessages(messages ?? []), [messages]);
  const pendingConversationIdRef = useRef<string | undefined>(undefined);

  return (
    <AssistantRuntimePane
      apiBaseUrl={apiBaseUrl}
      client={client}
      config={config}
      selectedConversationId={selectedConversationId}
      initialMessages={initialMessages}
      messagesLoaded={messagesLoaded}
      pendingConversationIdRef={pendingConversationIdRef}
      notice={notice}
      draft={draft}
      locale={locale}
      selectedAgentName={selectedAgentName}
      onDraftChange={onDraftChange}
      onConversationStarted={onConversationStarted}
      onStreamFinished={onStreamFinished}
      onStreamError={onStreamError}
    />
  );
}

function AssistantRuntimePane({
  apiBaseUrl,
  client,
  config,
  selectedConversationId,
  initialMessages,
  messagesLoaded,
  pendingConversationIdRef,
  notice,
  draft,
  locale,
  selectedAgentName,
  onDraftChange,
  onConversationStarted,
  onStreamFinished,
  onStreamError
}: {
  apiBaseUrl: string;
  client: ApiClient;
  config: SafeConfig | undefined;
  selectedConversationId: string | undefined;
  initialMessages: UIMessage[];
  messagesLoaded: boolean;
  pendingConversationIdRef: MutableRefObject<string | undefined>;
  notice: string | undefined;
  draft: string;
  locale: LocaleCode;
  selectedAgentName: string | undefined;
  onDraftChange: (value: string) => void;
  onConversationStarted: (conversationId: string, messages?: Message[]) => void;
  onStreamFinished: () => void;
  onStreamError: (message: string) => void;
}) {
  const importedTargetRef = useRef<string | undefined>(undefined);
  const clearedTargetRef = useRef<string | undefined>(undefined);
  const streamedConversationIdRef = useRef<string | undefined>(undefined);
  const transport = useMemo(
    () =>
      new AssistantChatTransport<UIMessage>({
        api: `${apiBaseUrl.replace(/\/$/u, "")}/api/chat`,
        credentials: "include",
        body: {
          conversationId: selectedConversationId,
          locale,
          agentName: selectedAgentName
        },
        prepareSendMessagesRequest: async (options) => {
          const text = extractLastUserText(options.messages);
          let conversationId = selectedConversationId;
          if (!conversationId) {
            const conversation = await client.createConversation({
              title: firstLineTitle(text),
              locale
            });
            conversationId = conversation.id;
            pendingConversationIdRef.current = conversation.id;
          }

          return {
            credentials: "include",
            body: {
              ...options.body,
              conversationId,
              locale,
              agentName: selectedAgentName,
              messages: options.messages
            }
          };
        }
      }),
    [apiBaseUrl, client, locale, pendingConversationIdRef, selectedAgentName, selectedConversationId]
  );
  async function selectPendingConversation(): Promise<void> {
    const conversationId = pendingConversationIdRef.current;
    if (!conversationId) {
      return;
    }
    pendingConversationIdRef.current = undefined;
    streamedConversationIdRef.current = conversationId;
    const persistedMessages = await client.messages(conversationId).catch(() => undefined);
    onConversationStarted(conversationId, persistedMessages);
  }

  const runtime = useChatRuntime({
    messages: initialMessages,
    transport,
    async onFinish() {
      await selectPendingConversation();
      onStreamFinished();
    },
    async onError(error) {
      await selectPendingConversation();
      onStreamError(error.message);
    }
  });

  useLayoutEffect(() => {
    const targetKey = selectedConversationId ?? "new";
    if (importedTargetRef.current === targetKey) {
      return;
    }

    if (!selectedConversationId) {
      runtime.thread.importExternalState(toAiSdkMessageRepository([]));
      importedTargetRef.current = targetKey;
      clearedTargetRef.current = undefined;
      return;
    }

    if (streamedConversationIdRef.current === selectedConversationId) {
      streamedConversationIdRef.current = undefined;
      importedTargetRef.current = targetKey;
      clearedTargetRef.current = undefined;
      return;
    }

    if (!messagesLoaded) {
      if (clearedTargetRef.current !== targetKey) {
        runtime.thread.importExternalState(toAiSdkMessageRepository([]));
        clearedTargetRef.current = targetKey;
      }
      return;
    }

    runtime.thread.importExternalState(toAiSdkMessageRepository(initialMessages));
    importedTargetRef.current = targetKey;
    clearedTargetRef.current = undefined;
  }, [initialMessages, messagesLoaded, runtime, selectedConversationId]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <DraftBridge draftKey={selectedConversationId ?? "new"} draft={draft} onDraftChange={onDraftChange} />
      <AssistantThread
        config={config}
        selectedAgentName={selectedAgentName}
        notice={notice}
      />
    </AssistantRuntimeProvider>
  );
}

interface AiSdkMessageFormatRepository {
  headId: string | null;
  messages: Array<{
    parentId: string | null;
    message: UIMessage;
  }>;
}

function toAiSdkMessageRepository(messages: UIMessage[]): AiSdkMessageFormatRepository {
  let parentId: string | null = null;
  return {
    headId: messages.at(-1)?.id ?? null,
    messages: messages.map((message) => {
      const item = {
        parentId,
        message
      };
      parentId = message.id;
      return item;
    })
  };
}

function DraftBridge({
  draftKey,
  draft,
  onDraftChange
}: {
  draftKey: string;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const composer = useComposerRuntime();
  const currentText = useComposer((state) => state.text);
  const restoredDraftKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (restoredDraftKeyRef.current === draftKey) {
      return;
    }
    restoredDraftKeyRef.current = draftKey;
    composer.setText(draft);
  }, [composer, draft, draftKey]);

  useEffect(() => {
    if (currentText !== draft) {
      onDraftChange(currentText);
    }
  }, [currentText, draft, onDraftChange]);

  return null;
}

export function toUiMessages(messages: Message[]): UIMessage[] {
  const toolResultsByToolCallId = new Map<string, PersistedToolResult>();
  for (const message of messages) {
    const toolResult = readPersistedToolResult(message);
    if (toolResult) {
      toolResultsByToolCallId.set(toolResult.toolCallId, toolResult);
    }
  }

  return messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "system")
    .map((message) => ({
      id: message.id,
      role: message.role as UIMessage["role"],
      parts: toUiMessageParts(message, toolResultsByToolCallId)
    }));
}

function toUiMessageParts(
  message: Message,
  toolResultsByToolCallId: Map<string, PersistedToolResult>
): UIMessage["parts"] {
  const parts: UIMessage["parts"] = [];
  if (message.text || message.role !== "assistant") {
    parts.push({
      type: "text",
      text: message.text,
      state: "done"
    });
  }

  const toolCalls = readAssistantToolCalls(message);
  for (const toolCall of toolCalls) {
    const toolResult = toolResultsByToolCallId.get(toolCall.toolCallId);
    parts.push({
      type: "dynamic-tool",
      toolName: toolCall.toolName,
      toolCallId: toolCall.toolCallId,
      title: toolCall.toolName,
      state: toolResult?.status === "failed" ? "output-error" : toolResult ? "output-available" : "input-available",
      input: toolCall.input,
      ...(toolResult?.status === "failed"
        ? { errorText: toolResult.errorText }
        : toolResult
          ? { output: toolResult.output }
          : {})
    } as UIMessage["parts"][number]);
  }

  const display = message.metadata?.display;
  if (display !== undefined) {
    parts.push({
      type: "data-display",
      data: display
    } as UIMessage["parts"][number]);
  }
  return parts.length > 0
    ? parts
    : [
        {
          type: "text",
          text: "",
          state: "done"
        }
      ];
}

interface PersistedToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

type PersistedToolResult =
  | {
      status: "success";
      toolCallId: string;
      output: unknown;
    }
  | {
      status: "failed";
      toolCallId: string;
      errorText: string;
    };

function readAssistantToolCalls(message: Message): PersistedToolCall[] {
  if (message.role !== "assistant") {
    return [];
  }
  const runtime = readAgentRuntimeMetadata(message.metadata);
  if (runtime?.kind !== "assistant_tool_calls" || !Array.isArray(runtime.toolCalls)) {
    return [];
  }
  return runtime.toolCalls.flatMap((value): PersistedToolCall[] => {
    if (!isRecord(value)) {
      return [];
    }
    const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    const toolName = typeof value.toolName === "string" ? value.toolName : undefined;
    if (!toolCallId || !toolName) {
      return [];
    }
    return [
      {
        toolCallId,
        toolName,
        input: value.input
      }
    ];
  });
}

function readPersistedToolResult(message: Message): PersistedToolResult | undefined {
  if (message.role !== "tool") {
    return undefined;
  }
  const runtime = readAgentRuntimeMetadata(message.metadata);
  if (runtime?.kind !== "tool_result" || typeof runtime.toolCallId !== "string") {
    return undefined;
  }
  const result = isRecord(runtime.result) ? runtime.result : undefined;
  if (result?.status === "success") {
    return {
      status: "success",
      toolCallId: runtime.toolCallId,
      output: {
        status: "success",
        output: result.output,
        display: result.display,
        artifacts: result.artifacts,
        projectionNotice: runtime.projectionNotice
      }
    };
  }
  if (
    (result?.status === "failed" || result?.status === "cancelled" || result?.status === "timed_out") &&
    isRecord(result.error)
  ) {
    return {
      status: "failed",
      toolCallId: runtime.toolCallId,
      errorText: typeof result.error.message === "string" ? result.error.message : "Tool call failed"
    };
  }
  return undefined;
}

function readAgentRuntimeMetadata(metadata: Message["metadata"]): Record<string, unknown> | undefined {
  const runtime = isRecord(metadata?.agentRuntime) ? metadata.agentRuntime : undefined;
  return runtime?.version === 1 ? runtime : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractLastUserText(messages: UIMessage[]): string {
  const userMessage = messages.findLast((message) => message.role === "user");
  return (
    userMessage?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim() ?? ""
  );
}
