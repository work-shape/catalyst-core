// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { apiOperations, buildApiPath } from "@work-shape/catalyst-api-contract";
import type { KnowledgeCitationSource } from "@work-shape/catalyst-core";
import { TranslationProvider } from "./support/chat-ui/shared";
import { CONDITION_WAIT_MS } from "./support/assertions";
import { UiRoot, uiLabelsDe, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  AssistantKnowledgeSources,
  AssistantSourcePart,
  AttachmentContentProvider,
  WorkspaceApiClientProvider
} from "./support/chat-ui";

// ACCEPT-FIX-8, E6: a cited Knowledge Base document is a chip "file name, p. 3", never the raw
// [K1], its name without the extension. It reads nothing until clicked; a click reads the file
// through the API with the reader's session or token and opens it at the page. A removed source
// says so and opens no tab. The chip's menu names the file whole with its date, opens each cited
// page, and links the original where the document has one. A chip in an open conversation names
// it, so the reader opens the source in that conversation's workspace. Under an answer the
// documents stand in one row "Sources", one chip per document with its pages merged, and past a
// handful the rest behind "+n more".

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

/** The chip's own button, which opens the first cited page; not the button of its menu. */
const chip = (within: ParentNode = host) =>
  within.querySelector<HTMLButtonElement>(
    "[data-knowledge-source] button:not([data-knowledge-source-details])"
  );
const label = () => host.querySelector("[data-knowledge-source]");

/** Opens the menu of the first chip and answers its items. */
async function openMenu(): Promise<HTMLElement[]> {
  const trigger = host.querySelector<HTMLButtonElement>("[data-knowledge-source-details]");
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  let items: HTMLElement[] = [];
  await vi.waitFor(
    () => {
      const menu = document.getElementById(trigger?.getAttribute("aria-controls") ?? "");
      items = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      expect(items.length).toBeGreaterThan(0);
    },
    { timeout: CONDITION_WAIT_MS }
  );
  return items;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const unreachable = () =>
  Response.json(
    {
      error: {
        code: "CONFLICT",
        message: "The source of this document cannot be reached right now.",
        details: { reason: "knowledge_source_unreachable" }
      }
    },
    { status: 409 }
  );
const text = () =>
  new Response("Hotel: 145 € je Nacht", { headers: { "content-type": "text/plain" } });

describe("the chip of a cited Knowledge Base passage", () => {
  it("names the file and page with no [K] marker, and reads nothing until clicked", () => {
    show(hotel);
    expect(label()?.textContent).toBe("reiserichtlinie, p. 3");
    expect(host.textContent).not.toMatch(/\[K\d+\]/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves a spreadsheet under its name, as no viewer here shows it at a page", async () => {
    const fileName = "preisliste.xlsx";
    fetchMock.mockResolvedValue(
      new Response("PK", {
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }
      })
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      expect(this.download).toBe(fileName);
    });
    show({ ...hotel, fileName, page: 2 });
    await act(async () => chip()?.click());
    await settle();
    expect(click).toHaveBeenCalledOnce();
    expect(openMock).not.toHaveBeenCalled();
  });

  it("opens the file at the page through the API on a click, naming the open conversation", async () => {
    fetchMock.mockImplementation(async () => text());
    show(hotel);
    await act(async () => chip()?.click());
    await settle();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(CONTENT);
    expect(openMock).toHaveBeenCalledWith("blob:catalyst/source-1#page=3", "_blank");
    expect(label()?.getAttribute("data-knowledge-source-state")).toBe("idle");

    fetchMock.mockClear();
    act(() => root.render(null));
    show(hotel, "en", "conv_reise");
    await act(async () => chip()?.click());
    await settle();
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requested.origin + requested.pathname).toBe(CONTENT);
    expect(requested.searchParams.get("conversationId")).toBe("conv_reise");
  });

  it("says a removed source is no longer available, opens no tab and offers no click", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        { error: { code: "NOT_FOUND", message: "Knowledge Base document not found" } },
        { status: 404 }
      )
    );
    show(hotel);
    await act(async () => chip()?.click());
    await settle();
    expect(label()?.textContent).toContain("no longer available");
    expect(chip()).toBeNull();
    expect(openMock).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Knowledge Base document not found");
  });

  it("KB-13 says a synced source cannot be reached, and the same chip opens it once it can", async () => {
    fetchMock.mockResolvedValueOnce(unreachable()).mockResolvedValueOnce(text());
    show(hotel);
    await act(async () => chip()?.click());
    await settle();
    expect(label()?.getAttribute("data-knowledge-source-state")).toBe("unreachable");
    expect(openMock).not.toHaveBeenCalled();
    await act(async () => chip()?.click());
    await settle();
    expect(openMock).toHaveBeenCalledWith("blob:catalyst/source-1#page=3", "_blank");
    expect(label()?.textContent).toBe("reiserichtlinie, p. 3");
  });

  it("C44 links the original from its menu without opener, reading nothing through the API, and never a non-web address", async () => {
    fetchMock.mockImplementation(async () => text());
    show({ ...hotel, originLink: "https://dms.example.test/akte/7?seite=3" });
    expect(host.querySelector("a")).toBeNull();
    await act(async () => chip()?.click());
    await settle();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(CONTENT);
    const items = await openMenu();
    const origin = items.at(-1);
    expect(origin?.tagName).toBe("A");
    expect(origin?.getAttribute("href")).toBe("https://dms.example.test/akte/7?seite=3");
    expect(origin?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => root.render(null));
    show({ ...hotel, originLink: "javascript:alert(1)" });
    expect(await openMenu()).toHaveLength(1);
  });
});

describe("the row of sources under an answer", () => {
  const cited = (id: string, fileName: string, page?: number): KnowledgeCitationSource => ({
    ref: `K${id}`,
    knowledgeBase: "richtlinien",
    documentId: `kbdoc_${id}`,
    fileId: `file_${id}`,
    fileName,
    retrievedAt: "2026-11-19T08:00:00Z",
    ...(page === undefined ? {} : { page })
  });

  function showRow(citations: KnowledgeCitationSource[]) {
    act(() =>
      root.render(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(
            TranslationProvider,
            { locale: "en", children: null },
            createElement(
              WorkspaceApiClientProvider,
              { apiBaseUrl: API, children: null },
              createElement(AssistantKnowledgeSources, { citations })
            )
          )
        )
      )
    );
  }

  const chips = () => [...host.querySelectorAll("[data-knowledge-source]")];

  it("shows each document once with its pages merged, opens the first on a click and any other from the menu", async () => {
    fetchMock.mockImplementation(
      async () => new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } })
    );
    showRow([
      { ...cited("hotel", "reiserichtlinie.pdf", 79), ref: "K1" },
      cited("vertrag", "rahmenvertrag.pdf", 2),
      { ...cited("hotel", "reiserichtlinie.pdf", 7), ref: "K3" },
      { ...cited("hotel", "reiserichtlinie.pdf", 79), ref: "K4" }
    ]);
    expect(chips()).toHaveLength(2);
    await act(async () => chip()?.click());
    await settle();
    expect(openMock).toHaveBeenLastCalledWith("blob:catalyst/source-1#page=7", "_blank");
    const items = await openMenu();
    expect(items).toHaveLength(2);
    await act(async () => items[1]?.click());
    await settle();
    expect(openMock).toHaveBeenLastCalledWith("blob:catalyst/source-1#page=79", "_blank");
  });

  it("shows five documents whole, and past five four and the rest on a click", async () => {
    showRow(["a", "b", "c", "d", "e"].map((id) => cited(id, `akte-${id}.pdf`, 1)));
    expect(chips()).toHaveLength(5);
    const seven = ["a", "b", "c", "d", "e", "f", "g"].map((id, index) =>
      cited(id, `akte-${id}.pdf`, index + 1)
    );
    showRow(seven);
    expect(chips()).toHaveLength(4);
    const more = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("+")
    );
    await act(async () => more?.click());
    expect(chips()).toHaveLength(7);
  });
});

describe("the citation of a web page (KB-WEB)", () => {
  const page: KnowledgeCitationSource = {
    ref: "K1",
    knowledgeBase: "laws",
    documentId: "kbdoc_s7",
    fileId: "file_s7",
    fileName: "Section 7 Depreciation",
    originLink: "https://www.example.org/law/s7",
    statedAt: "2026-11-01T00:00:00Z",
    retrievedAt: "2026-11-10T09:30:00Z"
  };
  const heading = () => {
    const trigger = host.querySelector("[data-knowledge-source-details]");
    const menu = document.getElementById(trigger?.getAttribute("aria-controls") ?? "");
    return menu?.querySelector('[role="group"] > div')?.textContent ?? "";
  };

  it("names the date the page states, else only the day it was retrieved, and links the page", async () => {
    show(page);
    expect((await openMenu()).at(-1)?.getAttribute("href")).toBe("https://www.example.org/law/s7");
    expect(heading()).toContain("as of 01/11/2026");
    act(() => root.render(null));
    const { statedAt: _stated, ...unstated } = page;
    show(unstated);
    await openMenu();
    expect(heading()).toContain("retrieved 10/11/2026");
    expect(heading()).not.toContain("as of");
  });
});
