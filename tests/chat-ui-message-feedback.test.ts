// @vitest-environment happy-dom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { Message } from "@work-shape/catalyst-api-client";
import { TranslationProvider } from "@work-shape/catalyst-chat-ui";
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

// Feedback under an agent's answer (LU-4, check 18 and 21): the action sits beside copy where
// the module is on, the box for the exchange is ticked when the field opens, and the line under
// the answer then says the comment was sent.

let host: HTMLDivElement;
let root: Root;
let sent: unknown[];
let stored: Record<string, unknown>[];

const listPath = apiOperations["feedback.list_own"].path.replace(":conversationId", "conv_1");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  sent = [];
  stored = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname !== listPath) {
      return Response.json({ error: { code: "NOT_FOUND", message: "No" } }, { status: 404 });
    }
    if (request.method === "GET") return Response.json({ items: stored });
    const body: { text: string; includeExchange: boolean } = await request.json();
    sent.push(body);
    const comment = {
      id: "fb_1",
      agentRunId: "run_1",
      text: body.text,
      includesExchange: body.includeExchange,
      state: "new",
      createdAt: "2026-10-20T09:00:00.000Z",
      updatedAt: "2026-10-20T09:00:00.000Z"
    };
    stored = [comment];
    return Response.json(comment);
  });
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

function Thread({ feedbackOn }: { feedbackOn: boolean }) {
  const uiMessages = toUiMessages(messages);
  const runtime = useChatRuntime({ messages: uiMessages, transport, isSendDisabled: true });
  useEffect(() => {
    runtime.thread.importExternalState(toAiSdkMessageRepository(uiMessages));
  }, [runtime]);
  const feedback = feedbackOn ? { conversationId: "conv_1", exchangeSnapshot: true } : undefined;
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
            children: () => createElement(ThreadMessage, { feedback })
          })
        )
      )
    )
  );
}

async function render(feedbackOn: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { locale: "en", children: null },
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(
              WorkspaceApiClientProvider,
              { apiBaseUrl: "https://api.example.test", children: null },
              createElement(Thread, { feedbackOn })
            )
          )
        )
      )
    )
  );
  await settle();
}

async function settle() {
  for (let pass = 0; pass < 5; pass += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

const action = () =>
  host.querySelector<HTMLButtonElement>('[data-testid="message-feedback-action"]');

describe("feedback under an answer", () => {
  it("is not offered where the module is off", async () => {
    await render(false);
    expect(host.querySelector('[data-role="assistant"]')).not.toBeNull();
    expect(action()).toBeNull();
  });

  it("opens with the exchange ticked, sends the comment and then says it was sent", async () => {
    await render(true);
    const assistant = host.querySelector('[data-role="assistant"]');
    expect(assistant?.querySelector('[data-testid="message-feedback-action"]')).not.toBeNull();
    expect(
      host.querySelector('[data-role="user"] [data-testid="message-feedback-action"]')
    ).toBeNull();

    await act(async () => action()?.click());
    const form = host.querySelector('[data-testid="message-feedback-form"]');
    expect(form?.textContent).toContain(
      "Include my question and this answer so the reviewer can read them"
    );
    expect(form?.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");

    const textarea = form?.querySelector("textarea");
    if (!textarea) throw new Error("No field");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setValue?.call(textarea, "The limit is 160 € in Munich.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    await act(async () => submit?.click());
    await settle();

    expect(sent).toEqual([
      { runId: "run_1", text: "The limit is 160 € in Munich.", includeExchange: true }
    ]);
    expect(host.querySelector('[data-testid="message-feedback-form"]')).toBeNull();
    expect(host.querySelector('[data-feedback-state="new"]')?.textContent).toBe("Feedback sent");
    expect(action()).toBeNull();
  });
});
