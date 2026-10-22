// @vitest-environment happy-dom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@work-shape/catalyst-api-client";
import { TranslationProvider } from "./support/chat-ui/shared";
import { createAssistantFinalMetadata } from "@work-shape/catalyst-core";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  AssistantToolRegistry,
  ThreadMessage,
  ToolDecisionsProvider,
  toAiSdkMessageRepository,
  toUiMessages,
  WorkspaceApiClientProvider
} from "./support/chat-ui";

// DAILY-WINS 1: a message offers only what works. Edit and Regenerate were drawn and never
// enabled; they are gone until they are built.

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const base = { conversationId: "conv_1", clientInstanceId: "client_test" } as const;
const messages: Message[] = [
  {
    ...base,
    id: "msg_user",
    role: "user",
    text: "Wie teuer darf ein Hotel sein?",
    createdAt: "2026-10-19T09:00:00.000Z"
  },
  {
    ...base,
    id: "msg_final",
    role: "assistant",
    text: "Höchstens 145 € pro Nacht.",
    createdAt: "2026-10-19T09:00:03.000Z",
    metadata: createAssistantFinalMetadata({ runId: "run_1" })
  }
];

const transport = {
  sendMessages: async () => {
    throw new Error("This thread takes no message");
  },
  reconnectToStream: async () => null
};

function Thread() {
  const uiMessages = toUiMessages(messages);
  const runtime = useChatRuntime({ messages: uiMessages, transport, isSendDisabled: true });
  useEffect(() => {
    runtime.thread.importExternalState(toAiSdkMessageRepository(uiMessages));
  }, [runtime]);
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(
      ToolDecisionsProvider,
      { parts: undefined, children: null },
      createElement(
        AssistantToolRegistry,
        null,
        createElement(
          ThreadPrimitive.Root,
          null,
          createElement(ThreadPrimitive.Messages, {
            children: () => createElement(ThreadMessage, {})
          })
        )
      )
    )
  );
}

describe("the actions under a message", () => {
  it("offers copy under both messages and no button that cannot be used", async () => {
    await act(async () =>
      root.render(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(
            TranslationProvider,
            { locale: "en", children: null },
            createElement(
              WorkspaceApiClientProvider,
              { apiBaseUrl: "https://api.example.test", children: null },
              createElement(Thread)
            )
          )
        )
      )
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    for (const role of ["user", "assistant"]) {
      const message = host.querySelector(`[data-role="${role}"]`);
      expect(message, role).not.toBeNull();
      const labels = [...(message?.querySelectorAll("button") ?? [])].map((button) =>
        button.getAttribute("aria-label")
      );
      expect(labels, role).toContain("Copy");
    }
    expect(host.querySelectorAll("button:disabled, button[aria-disabled='true']")).toHaveLength(0);
    expect(host.querySelector('[aria-label="Edit message"]')).toBeNull();
    expect(host.querySelector('[aria-label="Regenerate response"]')).toBeNull();
    // Nothing on the page opens an editor in place of the message.
    expect(host.querySelector("textarea")).toBeNull();
  });
});
