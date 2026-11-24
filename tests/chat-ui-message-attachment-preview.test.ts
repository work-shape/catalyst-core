// @vitest-environment happy-dom

import { act, createElement, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient, type Message } from "@work-shape/catalyst-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  ToolDisplayPanelProvider,
  useToolDisplayPanel
} from "@work-shape/catalyst-chat-ui/tool-display-panel";
import { TranslationProvider } from "./support/chat-ui/shared";
import {
  AssistantToolRegistry,
  AttachmentContentProvider,
  ThreadMessage,
  ToolDecisionsProvider,
  toAiSdkMessageRepository,
  partitionAttachments,
  planAttachmentGroup,
  toUiMessages,
  WorkspaceApiClientProvider
} from "./support/chat-ui";

// A picture sent with a message is a button: a click opens it in the preview panel beside the
// chat, the same file view the Resources panel and a file chip of the message open. Its name
// says what it does in the reader's language.

const API = "https://api.example.test";
// The 8-byte PNG signature and an IHDR start: enough to be served as a PNG.
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

const sourceFile = {
  resourceId: "resource_photo",
  resourceType: "source_file",
  attachmentId: "att_file_photo",
  title: "photo.png",
  mimeType: "image/png",
  createdAt: "2026-10-27T09:00:00.000Z",
  updatedAt: "2026-10-27T09:00:00.000Z",
  preview: { kind: "source_file", fileId: "file_photo" },
  download: { kind: "source_file", fileId: "file_photo", filename: "photo.png" }
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock = vi.fn<typeof fetch>(async (input) =>
    String(input instanceof Request ? input.url : input).includes("/resources")
      ? Response.json({ items: [sourceFile] })
      : new Response(PNG, { headers: { "content-type": "image/png" } })
  );
  vi.stubGlobal("fetch", fetchMock);
  let next = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:catalyst/file-${++next}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const client = createApiClient({ baseUrl: API, getToken: () => "token-1" });

/** What the surface slot beside the chat holds. */
function Panel() {
  const panel = useToolDisplayPanel();
  return panel.open && panel.entry
    ? createElement(
        "section",
        {
          "data-testid": "panel",
          "data-kind": panel.entry.kind,
          "data-title": panel.entry.title
        },
        "node" in panel.entry ? panel.entry.node : null
      )
    : null;
}

const transport = {
  sendMessages: async () => {
    throw new Error("This thread takes no message");
  },
  reconnectToStream: async () => null
};

function Thread({ messages }: { messages: Message[] }) {
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

/** A sent message with one picture attached, as a saved conversation holds it. */
const sent: Message = {
  id: "msg_photo",
  conversationId: "conv_1",
  clientInstanceId: "client_test",
  role: "user",
  text: "Look at this",
  createdAt: "2026-10-27T09:00:00.000Z",
  metadata: {
    agentRuntime: {
      version: 1,
      kind: "user_message",
      attachmentManifest: {
        version: 1,
        attachments: [
          {
            fileId: "file_photo",
            attachmentId: "att_file_photo",
            filename: "photo.png",
            mimeType: "image/png",
            byteSize: PNG.length,
            status: "ready",
            readable: true
          }
        ]
      }
    }
  }
};

function shell(child: ReactNode) {
  const locale = "en";
  return createElement(
    UiRoot,
    { mode: "light", labels: uiLabelsEn },
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        TranslationProvider,
        { locale, children: null },
        createElement(
          WorkspaceApiClientProvider,
          { apiBaseUrl: API, children: null },
          createElement(
            AttachmentContentProvider,
            { client, selectedConversationId: "conv_1", children: null },
            createElement(ToolDisplayPanelProvider, null, child, createElement(Panel))
          )
        )
      )
    )
  );
}

async function settle() {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function show() {
  await act(async () => root.render(shell(createElement(Thread, { messages: [sent] }))));
  await settle();
}

function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="panel"]');
}

describe("a picture sent with a message", () => {
  it("opens in the preview panel on a click, as the file view of that file", async () => {
    await show();
    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Open preview for photo.png"]'
    );
    expect(panel()).toBeNull();
    await act(async () => button?.click());
    await settle();

    expect(panel()?.dataset.kind).toBe("file_preview");
    expect(panel()?.dataset.title).toBe("photo.png");
    expect(panel()?.querySelector("img")).not.toBeNull();
    const urls = fetchMock.mock.calls.map(([input]) =>
      String(input instanceof Request ? input.url : input)
    );
    expect(urls.some((url) => url.includes("/conversations/conv_1/resources"))).toBe(true);
  });
});

describe("sent message attachment grouping", () => {
  it("collapses long stacks into a card that reveals the remainder on demand", () => {
    expect(planAttachmentGroup(4, false)).toEqual({ layout: "inline", visible: 4, hidden: 0 });
    expect(planAttachmentGroup(6, false)).toEqual({ layout: "card", visible: 6, hidden: 0 });
    expect(planAttachmentGroup(17, false)).toEqual({ layout: "card", visible: 6, hidden: 11 });
    expect(planAttachmentGroup(17, true)).toEqual({ layout: "card", visible: 17, hidden: 0 });
  });

  it("groups only the files so image attachments keep their thumbnails", () => {
    expect(
      partitionAttachments([
        { type: "file", name: "0. Fragebogen.pdf", contentType: "application/pdf" },
        { type: "image", name: "scan.png", contentType: "image/png" },
        { type: "document", name: "1. Datenschutz.pdf" },
        { type: "file", name: "photo.jpeg" }
      ])
    ).toEqual({ images: [1], files: [0, 2, 3] });
  });
});
