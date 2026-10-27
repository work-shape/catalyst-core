// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import type { KnowledgeCitationSource } from "@work-shape/catalyst-core";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { TranslationProvider } from "./support/chat-ui/shared";
import {
  AssistantSourcePart,
  SourceFilePreview,
  viewerObjectUrl,
  WorkspaceApiClientProvider
} from "./support/chat-ui";

// In token mode (a client with getToken, so browserManagedDownloads is false) chat-ui fetches a
// file and frames or opens it as a blob: address, which runs on the interface origin. The blob
// takes the type the viewer expects, never an active type it was fetched with: an HTML body
// fetched as a PDF is never text/html.

const API = "https://api.example.test";
const HTML = "<script>parent.document.title = 'owned'</script>";

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let createObjectUrl: MockInstance<typeof URL.createObjectURL>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:catalyst/file-1");
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

function blobTypes(): string[] {
  return createObjectUrl.mock.calls.map(([object]) =>
    object instanceof Blob ? object.type : "not a blob"
  );
}

function html(): Response {
  return new Response(HTML, { headers: { "content-type": "text/html" } });
}

function render(child: ReturnType<typeof createElement>) {
  act(() =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(TranslationProvider, { locale: "en", children: child })
      )
    )
  );
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("a blob: address for a fetched file", () => {
  it("takes the type its viewer expects, and a raster type for any image", async () => {
    const page = new Blob([HTML], { type: "text/html" });
    expect(viewerObjectUrl(page, "pdf")).toBe("blob:catalyst/file-1");
    viewerObjectUrl(page, "text");
    viewerObjectUrl(page, "image");
    viewerObjectUrl(new Blob(["<svg/>"], { type: "image/svg+xml" }), "image");
    viewerObjectUrl(new Blob(["x"], { type: "image/png;x=1,text/html" }), "image");
    viewerObjectUrl(new Blob(["\u00ff\u00d8"], { type: "application/octet-stream" }), "image");
    viewerObjectUrl(new Blob(["GIF89a"], { type: "IMAGE/GIF; x=1" }), "image");
    expect(blobTypes()).toEqual([
      "application/pdf",
      "text/plain;charset=utf-8",
      "image/png",
      "image/png",
      "image/png",
      "image/png",
      "image/gif"
    ]);
    const framed = createObjectUrl.mock.calls[0]?.[0];
    expect(framed instanceof Blob ? await framed.text() : undefined).toBe(HTML);
  });

  it("frames an HTML body fetched as a PDF as a PDF, never as text/html", async () => {
    fetchMock.mockImplementation(async () => html());
    const client = createApiClient({ baseUrl: API, getToken: () => "token-1" });
    expect(client.browserManagedDownloads).toBe(false);
    render(
      createElement(SourceFilePreview, {
        client,
        conversationId: "conv_1",
        attachmentId: "att_1",
        fileId: "file_1",
        filename: "rechnung.pdf",
        mimeType: "application/pdf"
      })
    );
    await settle();
    expect(blobTypes()).toEqual(["application/pdf"]);
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe("blob:catalyst/file-1");
  });

  it("shows an HTML body fetched as an image only as an image", async () => {
    fetchMock.mockImplementation(async () => html());
    render(
      createElement(SourceFilePreview, {
        client: createApiClient({ baseUrl: API, getToken: () => "token-1" }),
        conversationId: "conv_1",
        attachmentId: "att_1",
        fileId: "file_1",
        filename: "foto.png",
        mimeType: "image/png"
      })
    );
    await settle();
    expect(blobTypes()).toEqual(["image/png"]);
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:catalyst/file-1");
    expect(host.querySelector("iframe")).toBeNull();
  });

  it("opens a cited HTML file as a PDF or as text, and saves a cited SVG instead of opening it", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => window);
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      saved.push(this.download);
    });
    const cite = (fileName: string) => {
      const source: KnowledgeCitationSource = {
        ref: "K1",
        knowledgeBase: "richtlinien",
        documentId: "kbdoc_1",
        fileId: "file_1",
        fileName
      };
      render(
        createElement(WorkspaceApiClientProvider, {
          apiBaseUrl: API,
          children: createElement(AssistantSourcePart, {
            type: "source",
            sourceType: "document",
            id: "knowledge:K1",
            title: fileName,
            filename: fileName,
            mediaType: "application/octet-stream",
            providerMetadata: { vivdCatalyst: { knowledge: { ...source } } },
            status: { type: "complete" }
          } as const)
        })
      );
    };

    fetchMock.mockImplementation(async () => html());
    cite("richtlinie.pdf");
    await act(async () => host.querySelector("button")?.click());
    await settle();
    expect(blobTypes()).toEqual(["application/pdf"]);
    expect(open).toHaveBeenCalledWith("blob:catalyst/file-1", "_blank");

    createObjectUrl.mockClear();
    cite("seite.html");
    await act(async () => host.querySelector("button")?.click());
    await settle();
    expect(blobTypes()).toEqual(["text/plain;charset=utf-8"]);

    open.mockClear();
    createObjectUrl.mockClear();
    fetchMock.mockImplementation(
      async () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })
    );
    cite("plan.svg");
    await act(async () => host.querySelector("button")?.click());
    await settle();
    expect(open).not.toHaveBeenCalled();
    // Saved through a download link, which navigates nowhere.
    expect(saved).toEqual(["plan.svg"]);
  });
});
