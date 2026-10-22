// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { apiOperations, buildApiPath } from "@work-shape/catalyst-api-contract";
import type { KnowledgeCitationSource } from "@work-shape/catalyst-core";
import { TranslationProvider } from "./support/chat-ui/shared";
import { UiRoot, uiLabelsDe, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  AssistantSourcePart,
  AttachmentContentProvider,
  WorkspaceApiClientProvider
} from "./support/chat-ui";

// ACCEPT-FIX-8, E6: a cited Knowledge Base passage is a chip "file name, p. 3", never the raw
// [K1]. It reads nothing until clicked; a click reads the file through the API with the
// reader's session or token and opens it at the page. A removed source says so and opens no
// tab. An origin link is a second chip where the passage has one. A chip in an open
// conversation names it, so the reader opens the source in that conversation's workspace.

const API = "https://api.example.test";
const CONTENT =
  API +
  buildApiPath(apiOperations["knowledge_bases.open_document"].path, {
    params: { knowledgeBase: "richtlinien", documentId: "kbdoc_hotel" }
  });

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let openMock: ReturnType<typeof vi.fn<typeof window.open>>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  // A tab that opened: the page lets go of it at once.
  openMock = vi.fn<typeof window.open>(() => window);
  vi.spyOn(window, "open").mockImplementation(openMock);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:catalyst/source-1");
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

const hotel: KnowledgeCitationSource = {
  ref: "K1",
  knowledgeBase: "richtlinien",
  documentId: "kbdoc_hotel",
  fileId: "file_hotel",
  fileName: "reiserichtlinie.md",
  page: 3
};

function show(
  source: KnowledgeCitationSource,
  locale: "en" | "de" = "en",
  conversationId?: string
) {
  const part = {
    type: "source",
    sourceType: "document",
    id: `knowledge:${source.ref}`,
    title: source.fileName,
    filename: source.fileName,
    mediaType: "application/octet-stream",
    providerMetadata: { vivdCatalyst: { knowledge: { ...source } } },
    status: { type: "complete" }
  } as const;
  act(() =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: locale === "de" ? uiLabelsDe : uiLabelsEn },
        createElement(
          TranslationProvider,
          { locale, children: null },
          createElement(
            WorkspaceApiClientProvider,
            { apiBaseUrl: API, children: null },
            conversationId === undefined
              ? createElement(AssistantSourcePart, part)
              : createElement(AttachmentContentProvider, {
                  client: createApiClient({ baseUrl: API }),
                  selectedConversationId: conversationId,
                  children: createElement(AssistantSourcePart, part)
                })
          )
        )
      )
    )
  );
}

const chip = () => host.querySelector<HTMLButtonElement>("button");
const label = () => host.querySelector("[data-knowledge-source]");

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the chip of a cited Knowledge Base passage", () => {
  it("names the file and page in English and German, with no [K] marker, and reads nothing yet", () => {
    show(hotel);
    expect(label()?.textContent).toBe("reiserichtlinie.md, p. 3");
    expect(host.textContent).not.toMatch(/\[K\d+\]/u);
    show(hotel, "de");
    expect(label()?.textContent).toBe("reiserichtlinie.md, S. 3");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the file at the page through the API on a click", async () => {
    fetchMock.mockResolvedValue(
      new Response("Hotel: 145 € je Nacht", { headers: { "content-type": "text/plain" } })
    );
    show(hotel);
    await act(async () => chip()?.click());
    await settle();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(CONTENT);
    expect(openMock).toHaveBeenCalledWith("blob:catalyst/source-1#page=3", "_blank");
    expect(label()?.getAttribute("data-knowledge-source-state")).toBe("idle");
  });

  it("names the open conversation in the request, in English and German", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response("Hotel: 145 € je Nacht", { headers: { "content-type": "text/plain" } })
    );
    for (const [locale, words] of [
      ["en", "reiserichtlinie.md, p. 3"],
      ["de", "reiserichtlinie.md, S. 3"]
    ] as const) {
      fetchMock.mockClear();
      show(hotel, locale, "conv_reise");
      expect(label()?.textContent).toBe(words);
      await act(async () => chip()?.click());
      await settle();
      const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(requested.origin + requested.pathname).toBe(CONTENT);
      expect(requested.searchParams.get("conversationId")).toBe("conv_reise");
      act(() => root.render(null));
    }
  });

  it("says a removed source is no longer available, opens no tab and offers no click, in English and German", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        { error: { code: "NOT_FOUND", message: "Knowledge Base document not found" } },
        { status: 404 }
      )
    );
    for (const [locale, words] of [
      ["en", "reiserichtlinie.md, p. 3: source no longer available"],
      ["de", "reiserichtlinie.md, S. 3: Quelle nicht mehr verfügbar"]
    ] as const) {
      show(hotel, locale);
      await act(async () => chip()?.click());
      await settle();
      expect(label()?.textContent).toBe(words);
      expect(chip()).toBeNull();
      act(() => root.render(null));
    }
    expect(openMock).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Knowledge Base document not found");
  });

  it("adds the origin link as its own chip where it is a web address, and leaves out any other", () => {
    show({ ...hotel, originLink: "https://dms.example.test/akte/7?seite=3" });
    const origin = host.querySelector<HTMLAnchorElement>("a");
    expect(origin?.getAttribute("href")).toBe("https://dms.example.test/akte/7?seite=3");
    expect(origin?.textContent).toBe("dms.example.test");
    show({ ...hotel, originLink: "javascript:alert(1)" });
    expect(host.querySelector("a")).toBeNull();
  });
});
