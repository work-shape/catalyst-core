import { useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import {
  AssistantRuntimeProvider,
  useComposer,
  useComposerRuntime,
} from "@assistant-ui/react";
import { AssistantChatTransport, useChatRuntime } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import type { ReactNode } from "react";
import type { ApiClient, Conversation, Message, SafeConfig } from "@agent-chat-platform/api-client";
import { AssistantThread } from "./assistant-thread";
import { firstLineTitle } from "./conversation-title";

export function AssistantChatPanel({
  apiBaseUrl,
  client,
  config,
  conversations,
  selectedConversationId,
  messages,
  messagesLoaded,
  notice,
  draft,
  headerActions,
  onDraftChange,
  onConversationStarted,
  onStreamFinished,
  onStreamError
}: {
  apiBaseUrl: string;
  client: ApiClient;
  config: SafeConfig | undefined;
  conversations: Conversation[];
  selectedConversationId: string | undefined;
  messages: Message[] | undefined;
  messagesLoaded: boolean;
  notice: string | undefined;
  draft: string;
  headerActions?: ReactNode;
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
      conversations={conversations}
      selectedConversationId={selectedConversationId}
      initialMessages={initialMessages}
      messagesLoaded={messagesLoaded}
      pendingConversationIdRef={pendingConversationIdRef}
      notice={notice}
      draft={draft}
      headerActions={headerActions}
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
  conversations,
  selectedConversationId,
  initialMessages,
  messagesLoaded,
  pendingConversationIdRef,
  notice,
  draft,
  headerActions,
  onDraftChange,
  onConversationStarted,
  onStreamFinished,
  onStreamError
}: {
  apiBaseUrl: string;
  client: ApiClient;
  config: SafeConfig | undefined;
  conversations: Conversation[];
  selectedConversationId: string | undefined;
  initialMessages: UIMessage[];
  messagesLoaded: boolean;
  pendingConversationIdRef: MutableRefObject<string | undefined>;
  notice: string | undefined;
  draft: string;
  headerActions?: ReactNode;
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
          agentName: config?.defaultAgentName
        },
        prepareSendMessagesRequest: async (options) => {
          const text = extractLastUserText(options.messages);
          let conversationId = selectedConversationId;
          if (!conversationId) {
            const conversation = await client.createConversation({
              title: firstLineTitle(text)
            });
            conversationId = conversation.id;
            pendingConversationIdRef.current = conversation.id;
          }

          return {
            credentials: "include",
            body: {
              ...options.body,
              conversationId,
              agentName: config?.defaultAgentName,
              messages: options.messages
            }
          };
        }
      }),
    [apiBaseUrl, client, config?.defaultAgentName, pendingConversationIdRef, selectedConversationId]
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
        conversations={conversations}
        selectedConversationId={selectedConversationId}
        notice={notice}
        headerActions={headerActions}
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

function toUiMessages(messages: Message[]): UIMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "system")
    .map((message) => ({
      id: message.id,
      role: message.role as UIMessage["role"],
      parts: toUiMessageParts(message)
    }));
}

function toUiMessageParts(message: Message): UIMessage["parts"] {
  const parts: UIMessage["parts"] = [
    {
      type: "text",
      text: message.text,
      state: "done"
    }
  ];
  const domainUi = message.metadata?.domainUi;
  if (domainUi !== undefined) {
    parts.push({
      type: "data-domain-ui",
      data: domainUi
    } as UIMessage["parts"][number]);
  }
  return parts;
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
