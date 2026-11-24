// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranslationProvider } from "./support/chat-ui/shared";
import {
  KnowledgeTestSearch,
  type KnowledgeBaseSource,
  type KnowledgeRead,
  type KnowledgeSearchAnswer
} from "@work-shape/catalyst-chat-ui/build-area";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";

// The Test search of a Knowledge Base that keeps documents (KB-7a), against planted answers of
// `knowledge.<id>.search`: the passages best first with their ref, document, page and heading,
// the lists the search fused, and the sentence of a refused or empty search, in German du-form
// first.

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const ready = <Answer>(data: Answer): KnowledgeRead<Answer> => ({ status: "ready", data });

const answer: KnowledgeSearchAnswer = {
  passages: [
    {
      ref: "K1",
      knowledgeBase: "objekte",
      documentId: "kbdoc_1",
      fileId: "file_1",
      fileName: "Mietvertrag.pdf",
      title: "Mietvertrag",
      page: 3,
      heading: "Mietvertrag > Kaution",
      text: "Die Kaution beträgt drei Monatsmieten.",
      score: 0.032
    },
    {
      ref: "K2",
      knowledgeBase: "objekte",
      documentId: "kbdoc_2",
      fileId: "file_2",
      fileName: "Hausordnung.txt",
      title: "Hausordnung",
      text: "Die Kaution wird verzinst.",
      score: 0.016
    }
  ],
  signals: ["semantic", "keyword", "title"]
};

function plantedSource(search: KnowledgeBaseSource["search"]): KnowledgeBaseSource {
  const unused = async () => ({ ok: false as const, refused: false, message: undefined });
  return {
    useState: () => ({ status: "loading" }),
    check: unused,
    query: unused,
    search,
    useDataStores: () => ready({ items: [] }),
    useStoreTables: () => ready([]),
    useKnowledgeBases: () => ready({ items: [] }),
    useDocuments: () => ready({ documents: [] }),
    useOpenableFiles: () => ready({ items: [] }),
    retry: unused,
    remove: unused,
    addFiles: unused,
    uploadFile: unused
  };
}

/** The panel as the page holds it: inside the form that saves the Knowledge Base. */
function show(source: KnowledgeBaseSource, onPageSubmit = () => undefined) {
  act(() =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { locale: "en", children: null },
          createElement(
            "form",
            {
              onSubmit: (event: Event) => {
                event.preventDefault();
                onPageSubmit();
              }
            },
            createElement(KnowledgeTestSearch, { source, knowledgeBase: "objekte" })
          )
        )
      )
    )
  );
}

async function searchFor(text: string, buttonName = "Search") {
  const input = host.querySelector<HTMLInputElement>('input[type="search"]');
  if (!input) throw new Error("no search field");
  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === buttonName
  );
  if (!button) throw new Error(`no button ${buttonName}`);
  await act(async () => button.click());
}

describe("the Test search of a Knowledge Base of documents", () => {
  it("searches for the trimmed words and shows the passages best first", async () => {
    const search = vi.fn<KnowledgeBaseSource["search"]>(async () => ({ ok: true, data: answer }));
    show(plantedSource(search));
    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Search"
    );
    // Nothing to search for yet: the button waits for words.
    expect(button?.disabled).toBe(true);

    await searchFor("  Kautionen  ");

    expect(search).toHaveBeenCalledWith("objekte", "Kautionen");
    const passages = [...host.querySelectorAll<HTMLElement>("[data-knowledge-passage]")];
    expect(passages.map((passage) => passage.dataset.knowledgePassage)).toEqual(["K1", "K2"]);
    expect(passages[0]?.textContent).toContain("Die Kaution beträgt drei Monatsmieten.");
  });

  it("searches on Enter without submitting the page's form, which saves the Knowledge Base", async () => {
    const search = vi.fn<KnowledgeBaseSource["search"]>(async () => ({ ok: true, data: answer }));
    const saved = vi.fn();
    show(plantedSource(search), saved);
    const input = host.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error("no search field");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "Kaution"
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(search).toHaveBeenCalledWith("objekte", "Kaution");
    expect(saved).not.toHaveBeenCalled();
  });

  it("shows no passage where the reader may not search", async () => {
    show(plantedSource(async () => ({ ok: false, refused: true, message: "Forbidden" })));
    await searchFor("Grundschuld");
    expect(host.querySelector("[data-knowledge-search-failed]")).not.toBeNull();
    expect(host.querySelector("[data-knowledge-passage]")).toBeNull();
  });
});
