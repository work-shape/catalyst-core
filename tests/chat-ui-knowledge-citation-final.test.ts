// @vitest-environment happy-dom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@work-shape/catalyst-api-client";
import { TranslationProvider } from "./support/chat-ui/shared";
import {
  createAssistantFinalMetadata,
  createAssistantToolCallsMetadata,
  createToolResultMetadata,
  KNOWLEDGE_SEARCH_TOOL_NAME
} from "@work-shape/catalyst-core";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  AssistantToolRegistry,
  ThreadMessage,
  ToolDecisionsProvider,
  toAiSdkMessageRepository,
  toUiMessages,
  WorkspaceApiClientProvider
} from "./support/chat-ui";

// ACCEPT-FIX-8, E6: the chip of a cited Knowledge Base passage stands beside the final answer.
// A finished run folds its steps into the work summary; the citations used to fold in with
// them, so a saved answer showed no chip at all. A web source still folds in with its search.

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

const runId = "run_kb";
const search = {
  toolCallId: "call_kb",
  toolName: KNOWLEDGE_SEARCH_TOOL_NAME,
  input: { knowledgeBase: "richtlinien", query: "Hotel" }
};
const intro = "Ich schaue in der Reiserichtlinie nach.";
const answer = "Die Hotelnacht kostet höchstens 145 € [K1].";

/** A saved run: it searched a Knowledge Base, then answered citing one passage. */
function savedRun(webSources = false): Message[] {
  const base = { conversationId: "conv_kb", clientInstanceId: "client_test" } as const;
  return [
    {
      ...base,
      id: "msg_calls",
      role: "assistant",
      text: intro,
      createdAt: "2026-10-19T09:00:01.000Z",
      metadata: createAssistantToolCallsMetadata({ runId, toolCalls: [search] })
    },
    {
      ...base,
      id: "msg_result",
      role: "tool",
      text: '{"ok":true}',
      createdAt: "2026-10-19T09:00:02.000Z",
      metadata: createToolResultMetadata({
        runId,
        toolCall: search,
        result: { status: "success", output: { ok: true } },
        modelOutput: { text: '{"ok":true}' }
      })
    },
    {
      ...base,
      id: "msg_final",
      role: "assistant",
      text: `${intro}${answer}`,
      createdAt: "2026-10-19T09:00:03.000Z",
      metadata: createAssistantFinalMetadata({
        runId,
        knowledgeSources: [
          {
            ref: "K1",
            knowledgeBase: "richtlinien",
            documentId: "kbdoc_hotel",
            fileId: "file_hotel",
            fileName: "reiserichtlinie.md",
            page: 4
          }
        ],
        ...(webSources
          ? {
              sources: [
                {
                  id: "web_1",
                  url: "https://example.com/hotel",
                  title: "Hotel rates",
                  provider: "serper"
                }
              ]
            }
          : {})
      })
    }
  ];
}

const transport = {
  sendMessages: async () => {
    throw new Error("This thread takes no message");
  },
  reconnectToStream: async () => null
};

function Thread({ messages }: { messages: Message[] }) {
  // As the chat loads a saved conversation: the messages go into the runtime once it is up.
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

async function show(messages: Message[]) {
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
            createElement(Thread, { messages })
          )
        )
      )
    )
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

/** The parts of the assistant message outside its folded work summary. */
function besideAnswer(): Element[] {
  const message = host.querySelector('[data-role="assistant"]');
  if (!message) {
    throw new Error("The assistant message did not render");
  }
  return [...message.querySelectorAll("[data-knowledge-source], a.chat-source-chip")].filter(
    (element) => element.closest('[data-slot="tool-group-root"]') === null
  );
}

describe("Knowledge Base citations beside a saved answer (ACCEPT-FIX-8, E6)", () => {
  it("shows the chip of a cited passage beside the answer of a run that searched", async () => {
    await show(savedRun());

    const message = host.querySelector('[data-role="assistant"]');
    expect(message?.textContent).toContain("Die Hotelnacht kostet höchstens 145 €.");
    expect(message?.textContent).not.toContain("[K1]");
    const chips = besideAnswer();
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toContain("reiserichtlinie.md");
    expect(chips[0]?.textContent).toContain("p. 4");
  });

  it("still folds a web source into the work with its search", async () => {
    const messages = savedRun(true);
    expect(toUiMessages(messages)[0]?.parts.map((part) => part.type)).toContain("source-url");
    await show(messages);

    const work = host.querySelector('[data-role="assistant"] [data-slot="tool-group-root"]');
    expect(work?.getAttribute("data-state")).toBe("closed");
    const chips = besideAnswer();
    expect(chips.map((chip) => chip.hasAttribute("data-knowledge-source"))).toEqual([true]);
  });
});
