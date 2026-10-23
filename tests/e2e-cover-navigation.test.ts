// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  ConversationListItem,
  StartConversationRunResponse
} from "@work-shape/catalyst-api-client";
import { useConversationListRefresh } from "./support/chat-ui";

it("does not poll the streamed conversation or an idle rail, and stops when its title arrives", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const root = createRoot(document.createElement("div"));
  const refresh = vi.fn();
  const conversation: ConversationListItem = {
    id: "conv_1",
    clientInstanceId: "client",
    collaborationWorkspaceId: "cw_1",
    createdByUserId: "usr_1",
    createdByExternalUserId: "external_1",
    visibility: "private",
    status: "active",
    retainedUntil: "2027-10-24T10:00:00Z",
    title: "Temporary",
    createdAt: "2026-10-24T10:00:00Z",
    updatedAt: "2026-10-24T10:00:00Z",
    activeRun: {
      id: "run_1",
      conversationId: "conv_1",
      agentName: "assistant",
      status: "running",
      startedAt: "2026-10-24T10:00:00Z",
      updatedAt: "2026-10-24T10:00:00Z",
      lastSequence: 0
    }
  };
  let accepted: ReturnType<typeof useConversationListRefresh>["runAccepted"] | undefined;
  function Rail({
    rows,
    streamed
  }: {
    rows: ConversationListItem[];
    streamed: string | undefined;
  }) {
    accepted = useConversationListRefresh({
      enabled: true,
      conversations: rows,
      streamedConversationId: streamed,
      refresh
    }).runAccepted;
    return null;
  }
  const show = (rows: ConversationListItem[], streamed?: string) =>
    act(() => root.render(createElement(Rail, { rows, streamed })));
  const advance = async (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  try {
    show([conversation], conversation.id);
    await advance(10_000);
    expect(refresh).not.toHaveBeenCalled();
    // The stream ended while the list still reports its run: read only until it catches up.
    show([conversation]);
    await advance(2_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    const idle = { ...conversation, activeRun: undefined };
    show([idle]);
    await advance(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    const userMessage = {
      id: "msg_1",
      conversationId: idle.id,
      clientInstanceId: "client",
      role: "user" as const,
      text: "First turn",
      createdAt: idle.createdAt
    };
    const response: StartConversationRunResponse = {
      conversation: idle,
      userMessage,
      run: {
        ...required(conversation.activeRun),
        clientInstanceId: "client",
        ownerUserId: "usr_1",
        correlationId: "corr_1",
        inputMessageId: userMessage.id
      },
      thread: {
        conversation: idle,
        messages: [userMessage],
        userState: {
          clientInstanceId: "client",
          conversationId: idle.id,
          userId: "usr_1",
          updatedAt: idle.updatedAt
        },
        serverTime: idle.updatedAt
      },
      eventsUrl: "/runs/run_1/events"
    };
    act(() => accepted?.(response));
    expect(refresh).toHaveBeenCalledTimes(2);
    await advance(2_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    show([{ ...idle, title: "Learned title" }]);
    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    // Workspace switch: stale title waiting must not poll the new workspace.
    show([]);
    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

import { required } from "./support/assertions";
