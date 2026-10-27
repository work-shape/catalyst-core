// @vitest-environment happy-dom

import { act, createElement, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createApiClient, type Message } from "@work-shape/catalyst-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { ToolDisplayPanelProvider } from "@work-shape/catalyst-chat-ui/tool-display-panel";
import { TranslationProvider } from "./support/chat-ui/shared";
import {
  ArtifactPreview,
  AssistantToolRegistry,
  AttachmentContentProvider,
  ImageFilePart,
  ThreadMessage,
  ToolDecisionsProvider,
  toAiSdkMessageRepository,
  toUiMessages,
  WorkspaceApiClientProvider
} from "./support/chat-ui";

// In token mode chat-ui fetches an image and shows it from a blob: address under a raster type,
// whatever the bytes are: an SVG is never given its own type on the interface origin. Such bytes
// do not decode, and the image fires `error`. Each place an image is shown then shows the file
// instead: the attachment and the image part of a message as their file chip, the artifact
// preview as its "Preview failed" card. A new address is tried afresh.

const API = "https://api.example.test";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
// The 8-byte PNG signature and an IHDR start: enough to be served as a PNG.
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let createObjectUrl: MockInstance<typeof URL.createObjectURL>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock = vi.fn<typeof fetch>(async () => svg());
  vi.stubGlobal("fetch", fetchMock);
  let next = 0;
  createObjectUrl = vi
    .spyOn(URL, "createObjectURL")
    .mockImplementation(() => `blob:catalyst/file-${++next}`);
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

/** SVG bytes as a server sends a file it was told is a PNG. */
function svg(): Response {
  return new Response(SVG, { headers: { "content-type": "image/png" } });
}

function png(): Response {
  return new Response(PNG, { headers: { "content-type": "image/png" } });
}

const client = createApiClient({ baseUrl: API, getToken: () => "token-1" });

function shell(child: ReactNode) {
  return createElement(
    UiRoot,
    { mode: "light", labels: uiLabelsEn },
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(
        TranslationProvider,
        { locale: "en", children: null },
        createElement(
          WorkspaceApiClientProvider,
          { apiBaseUrl: API, children: null },
          createElement(ToolDisplayPanelProvider, null, child)
        )
      )
    )
  );
}

async function show(child: ReactNode) {
  await act(async () => root.render(shell(child)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function failImage() {
  const image = host.querySelector("img");
  expect(image, "the image is shown first").not.toBeNull();
  await act(async () => image?.dispatchEvent(new Event("error")));
}

function blobTypes(): string[] {
  return createObjectUrl.mock.calls.map(([object]) =>
    object instanceof Blob ? object.type : "not a blob"
  );
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

/** A sent message with one image attached, as a saved conversation holds it. */
function sentWithImage(fileId: string, filename: string, mimeType = "image/png"): Message {
  return {
    id: `msg_${fileId}`,
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
              fileId,
              attachmentId: `att_${fileId}`,
              filename,
              mimeType,
              byteSize: SVG.length,
              status: "ready",
              readable: true
            }
          ]
        }
      }
    }
  };
}

function sentThread(message: Message) {
  return createElement(AttachmentContentProvider, {
    client,
    selectedConversationId: "conv_1",
    children: createElement(Thread, { key: message.id, messages: [message] })
  });
}

describe("an attached image that does not decode", () => {
  it.each(["image/svg+xml", "image/avif", "application/pdf"])(
    "shows %s as an attachment chip without fetching an image",
    async (mimeType) => {
      await show(sentThread(sentWithImage("file_plan", "plan.png", mimeType)));
      expect(host.querySelector("img")).toBeNull();
      expect(host.querySelector('button[aria-label="Open preview for plan.png"]')).not.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(blobTypes()).toEqual([]);
    }
  );

  it("shows a raster attachment with a MIME parameter as an image", async () => {
    fetchMock.mockImplementation(async () => png());
    await show(sentThread(sentWithImage("file_photo", "photo.png", "IMAGE/PNG; charset=binary")));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:catalyst/file-1");
  });

  it("shows the file chip, which still opens the file, and never retypes the bytes", async () => {
    await show(sentThread(sentWithImage("file_plan", "plan.png")));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:catalyst/file-1");
    expect(blobTypes()).toEqual(["image/png"]);

    await failImage();

    expect(host.querySelector("img")).toBeNull();
    const chip = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Open preview for plan.png"]'
    );
    expect(chip, "the file chip opens the file").not.toBeNull();
    expect(chip?.disabled).toBe(false);
    expect(chip?.textContent).toContain("plan.png");
    // No address under another type was made for the SVG bytes.
    expect(blobTypes()).toEqual(["image/png"]);
  });

  it("tries the image of another attachment afresh", async () => {
    await show(sentThread(sentWithImage("file_plan", "plan.png")));
    await failImage();
    expect(host.querySelector("img")).toBeNull();

    fetchMock.mockImplementation(async () => png());
    await show(sentThread(sentWithImage("file_photo", "photo.png")));

    expect(host.querySelector("img")?.getAttribute("alt")).toBe("photo.png");
    expect(host.querySelector('button[aria-label="Open preview for photo.png"]')).toBeNull();
  });

  it("keeps a raster image that loads as the image", async () => {
    fetchMock.mockImplementation(async () => png());
    await show(sentThread(sentWithImage("file_photo", "photo.png")));
    const image = host.querySelector("img");
    await act(async () => image?.dispatchEvent(new Event("load")));

    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:catalyst/file-1");
    expect(host.querySelector("figcaption")?.textContent).toBe("photo.png");
    expect(blobTypes()).toEqual(["image/png"]);
  });
});

describe("an image part of a message that does not decode", () => {
  const part = (fileId: string, filename: string) =>
    createElement(AttachmentContentProvider, {
      client,
      selectedConversationId: "conv_1",
      children: createElement(ImageFilePart, {
        data: `vivd-file://${fileId}`,
        filename,
        mimeType: "image/png"
      })
    });

  it("shows the file chip, and the image of a new file again", async () => {
    await show(part("file_plan", "plan.png"));
    await failImage();

    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("plan.png");

    fetchMock.mockImplementation(async () => png());
    await show(part("file_photo", "photo.png"));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:catalyst/file-2");
    expect(blobTypes()).toEqual(["image/png", "image/png"]);
  });
});

describe("an artifact image that does not decode", () => {
  const preview = (artifactId: string, filename: string) =>
    createElement(ArtifactPreview, {
      artifact: { artifactId, filename, mimeType: "image/png" },
      client,
      conversationId: "conv_1"
    });

  it("says the preview failed and names the file, and shows the next artifact's image", async () => {
    await show(preview("art_plan", "plan.png"));
    expect(blobTypes()).toEqual(["image/png"]);
    await failImage();

    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("Preview failed");
    expect(host.textContent).toContain("plan.png");

    fetchMock.mockImplementation(async () => png());
    await show(preview("art_photo", "photo.png"));
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("photo.png");
    expect(host.textContent).not.toContain("Preview failed");
  });
});
