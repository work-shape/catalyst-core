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

/** The menu of the first chip, open: its heading's text. */
function menuHeading(): string {
  const trigger = host.querySelector("[data-knowledge-source-details]");
  const menu = document.getElementById(trigger?.getAttribute("aria-controls") ?? "");
  return menu?.querySelector('[role="group"] > div')?.textContent ?? "";
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the chip of a cited Knowledge Base passage", () => {
  it("names the file and page in English and German, with no [K] marker, and reads nothing yet", () => {
    show(hotel);
    expect(label()?.textContent).toBe("reiserichtlinie, p. 3");
    expect(host.textContent).not.toMatch(/\[K\d+\]/u);
    show(hotel, "de");
    expect(label()?.textContent).toBe("reiserichtlinie, S. 3");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names a sheet and a slide in English and German, not a page", () => {
    const sheet = { ...hotel, fileName: "preisliste.xlsx", page: 2 };
    show({ ...sheet, sheet: "Armaturen" });
    expect(label()?.textContent).toBe("preisliste, Armaturen");
    show({ ...sheet, sheet: "Armaturen" }, "de");
    expect(label()?.textContent).toBe("preisliste, Armaturen");
    show(sheet);
    expect(label()?.textContent).toBe("preisliste, sheet 2");
    show(sheet, "de");
    expect(label()?.textContent).toBe("preisliste, Blatt 2");
    const slide = { ...hotel, fileName: "angebot.pptx", page: 4 };
    show(slide);
    expect(label()?.textContent).toBe("angebot, slide 4");
    show(slide, "de");
    expect(label()?.textContent).toBe("angebot, Folie 4");
  });

  it.each([
    ["preisliste.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["angebot.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"]
  ])("saves %s under its name, as no viewer here shows it at a page", async (fileName, type) => {
    fetchMock.mockResolvedValue(new Response("PK", { headers: { "content-type": type } }));
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
    expect(label()?.getAttribute("data-knowledge-source-state")).toBe("idle");
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
      ["en", "reiserichtlinie, p. 3"],
      ["de", "reiserichtlinie, S. 3"]
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
      ["en", "reiserichtlinie, p. 3 · source no longer available"],
      ["de", "reiserichtlinie, S. 3 · Quelle nicht mehr verfügbar"]
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

  it("KB-13 says a synced source cannot be reached, in English and German, and can be tried again", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        {
          error: {
            code: "CONFLICT",
            message: "The source of this document cannot be reached right now.",
            details: { reason: "knowledge_source_unreachable" }
          }
        },
        { status: 409 }
      )
    );
    for (const [locale, words] of [
      ["en", "reiserichtlinie, p. 3 · source not reachable"],
      ["de", "reiserichtlinie, S. 3 · Quelle nicht erreichbar"]
    ] as const) {
      show(hotel, locale);
      await act(async () => chip()?.click());
      await settle();
      expect(label()?.textContent).toBe(words);
      expect(label()?.getAttribute("data-knowledge-source-state")).toBe("unreachable");
      act(() => root.render(null));
    }
    expect(openMock).not.toHaveBeenCalled();
    // Reachable again: the same chip opens the page.
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "CONFLICT",
              message: "x",
              details: { reason: "knowledge_source_unreachable" }
            }
          },
          { status: 409 }
        )
      )
      .mockResolvedValueOnce(
        new Response("Hotel: 145 € je Nacht", { headers: { "content-type": "text/plain" } })
      );
    show(hotel, "de");
    await act(async () => chip()?.click());
    await settle();
    expect(label()?.textContent).toBe("reiserichtlinie, S. 3 · Quelle nicht erreichbar");
    await act(async () => chip()?.click());
    await settle();
    expect(openMock).toHaveBeenCalledWith("blob:catalyst/source-1#page=3", "_blank");
    expect(label()?.textContent).toBe("reiserichtlinie, S. 3");
  });

  it("names the file whole with its date in its menu, and links the original where it is a web address", async () => {
    show({
      ...hotel,
      retrievedAt: "2026-11-19T08:00:00Z",
      originLink: "https://dms.example.test/akte/7?seite=3"
    });
    // One chip: the original is in its menu, not a second pill.
    expect(host.querySelectorAll("[data-knowledge-source]")).toHaveLength(1);
    expect(host.querySelector("a")).toBeNull();
    const items = await openMenu();
    expect(menuHeading()).toBe("reiserichtlinie.mdretrieved 19/11/2026");
    expect(items.map((item) => item.textContent)).toEqual([
      "Open p. 3",
      "Open original (dms.example.test)"
    ]);
    const origin = items[1];
    expect(origin?.tagName).toBe("A");
    expect(origin?.getAttribute("href")).toBe("https://dms.example.test/akte/7?seite=3");
    expect(origin?.getAttribute("target")).toBe("_blank");
    expect(origin?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(origin?.getAttribute("aria-label")).toBe(
      "Open original (dms.example.test), opens in a new tab"
    );
    act(() => root.render(null));
    show({ ...hotel, originLink: "javascript:alert(1)" });
    expect((await openMenu()).map((item) => item.textContent)).toEqual(["Open p. 3"]);
  });

  it("names a file store the reader knows by its name, in English and German", async () => {
    const stored = { ...hotel, originLink: "https://www.dropbox.com/scl/fi/abc/reise.pdf" };
    show(stored);
    expect((await openMenu()).at(-1)?.textContent).toBe("Open in Dropbox");
    act(() => root.render(null));
    show(stored, "de");
    expect((await openMenu()).at(-1)?.textContent).toBe("In Dropbox öffnen");
  });

  it("C44 offers the stored copy at its page and the original location, each opened apart", async () => {
    fetchMock.mockResolvedValue(
      new Response("Hotel: 145 € je Nacht", { headers: { "content-type": "text/plain" } })
    );
    show({ ...hotel, originLink: "https://dms.example.test/akte/7" });
    // The chip opens the stored copy at its page through the API.
    await act(async () => chip()?.click());
    await settle();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(CONTENT);
    expect(openMock).toHaveBeenLastCalledWith("blob:catalyst/source-1#page=3", "_blank");
    // The original is a link out of its menu, which reads nothing through the API.
    const items = await openMenu();
    expect(items.at(-1)?.getAttribute("href")).toBe("https://dms.example.test/akte/7");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  function showRow(citations: KnowledgeCitationSource[], locale: "en" | "de" = "de") {
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
              createElement(AssistantKnowledgeSources, { citations })
            )
          )
        )
      )
    );
  }

  const chips = () => [...host.querySelectorAll("[data-knowledge-source]")];

  it("shows each document once with its pages merged, under the label Sources", async () => {
    showRow([
      { ...cited("hotel", "reiserichtlinie.pdf", 79), ref: "K1" },
      cited("vertrag", "rahmenvertrag.pdf", 2),
      { ...cited("hotel", "reiserichtlinie.pdf", 7), ref: "K3" },
      { ...cited("hotel", "reiserichtlinie.pdf", 79), ref: "K4" }
    ]);
    const row = host.querySelector('[role="group"]');
    expect(row?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.getElementById(row?.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(
      "Quellen"
    );
    expect(chips().map((chip) => chip.textContent)).toEqual([
      "reiserichtlinie, S. 7, 79",
      "rahmenvertrag, S. 2"
    ]);
    // The chip's button is read with its pages; its menu with the whole name.
    expect(chip()?.textContent).toBe("reiserichtlinie, S. 7, 79");
    expect(host.querySelector("[data-knowledge-source-details]")?.getAttribute("aria-label")).toBe(
      "reiserichtlinie.pdf: Seiten und Original"
    );
    expect((await openMenu()).map((item) => item.textContent)).toEqual([
      "S. 7 öffnen",
      "S. 79 öffnen"
    ]);
    expect(menuHeading()).toBe("reiserichtlinie.pdfabgerufen 19.11.2026");
  });

  it("opens the first cited page on a click, and any other from the menu", async () => {
    fetchMock.mockImplementation(
      async () => new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } })
    );
    showRow([
      cited("hotel", "reiserichtlinie.pdf", 79),
      { ...cited("hotel", "reiserichtlinie.pdf", 7), ref: "K2" }
    ]);
    await act(async () => chip()?.click());
    await settle();
    expect(openMock).toHaveBeenLastCalledWith("blob:catalyst/source-1#page=7", "_blank");
    const items = await openMenu();
    await act(async () => items[1]?.click());
    await settle();
    expect(openMock).toHaveBeenLastCalledWith("blob:catalyst/source-1#page=79", "_blank");
  });

  it("shows four documents and +n more past five, and the rest on a click, in English and German", async () => {
    const seven = ["a", "b", "c", "d", "e", "f", "g"].map((id, index) =>
      cited(id, `akte-${id}.pdf`, index + 1)
    );
    showRow(seven, "en");
    expect(chips()).toHaveLength(4);
    const more = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("+")
    );
    expect(more?.textContent).toBe("+3 more");
    showRow(seven, "de");
    const weitere = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "+3 weitere"
    );
    expect(weitere).toBeDefined();
    weitere?.focus();
    await act(async () => weitere?.click());
    expect(chips()).toHaveLength(7);
    expect(chips().map((chip) => chip.textContent)).toContain("akte-g, S. 7");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "+3 weitere")).toBe(
      false
    );
    // The focus goes to the first chip that showed.
    expect(document.activeElement).toBe(chip(chips()[4] ?? host));
  });

  it("shows five documents whole, as +1 more would take the room of the fifth", () => {
    showRow(["a", "b", "c", "d", "e"].map((id) => cited(id, `akte-${id}.pdf`, 1)));
    expect(chips()).toHaveLength(5);
    expect(host.textContent).not.toContain("weitere");
  });
});
