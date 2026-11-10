// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeCitationSource } from "@work-shape/catalyst-core";
import {
  KnowledgeSourcesSection,
  knowledgeSourcesFromConfig,
  knowledgeSourcesToConfig,
  newKnowledgeSource,
  type KnowledgeBaseSource,
  type KnowledgeRead,
  type KnowledgeSourceForm
} from "@work-shape/catalyst-chat-ui/build-area";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { TranslationProvider } from "./support/chat-ui/shared";
import { AssistantSourcePart, WorkspaceApiClientProvider } from "./support/chat-ui";

// A source of public web pages in Studio (KB-WEB): its form names pages, prefixes and sitemaps
// instead of folders and writes them back as the definition takes them, and a citation of one
// of its pages shows the date the page states.

const ready = <Answer>(data: Answer): KnowledgeRead<Answer> => ({ status: "ready", data });

describe("the form of a web source", () => {
  it("starts a source through a web Connection with addresses and writes only the lists it holds", () => {
    const source = newKnowledgeSource("public-pages", [], "web");
    expect(source).toMatchObject({ web: true, pages: "", prefixes: "", sitemaps: "" });
    const typed: KnowledgeSourceForm = {
      ...source,
      pages: "https://www.example.org/terms\n",
      prefixes: "https://www.example.org/docs/, https://www.example.org/help/",
      include: "/docs/**"
    };
    expect(knowledgeSourcesToConfig([typed])).toEqual([
      {
        id: "public-pages",
        connection: "public-pages",
        pages: ["https://www.example.org/terms"],
        prefixes: ["https://www.example.org/docs/", "https://www.example.org/help/"],
        include: ["/docs/**"]
      }
    ]);
  });

  it("reads a stored web source back as it was, with the depth it does not edit", () => {
    const stored = [
      {
        id: "laws",
        connection: "public-pages",
        sitemaps: ["https://www.example.org/sitemap.xml"],
        maxDepth: 2,
        schedule: { full: "0 3 * * 1" }
      }
    ];
    expect(knowledgeSourcesToConfig(knowledgeSourcesFromConfig(stored))).toEqual(stored);
    // A folder source stays one.
    const folders = [{ id: "files", connection: "box", folders: ["100"] }];
    expect(knowledgeSourcesToConfig(knowledgeSourcesFromConfig(folders))).toEqual(folders);
  });

  it("shows address fields for a web Connection, and no folder field", () => {
    const failed = { ok: false as const, refused: false, message: undefined };
    const source = {
      useState: () => ({ status: "loading" }),
      check: async () => failed,
      query: async () => failed,
      search: async () => failed,
      useDataStores: () => ready({ items: [] }),
      useStoreTables: () => ready([]),
      useKnowledgeBases: () => ready({ items: [] }),
      useDocuments: () => ready({ documents: [] }),
      retry: async () => ({ ok: true, data: {} }),
      remove: async () => ({ ok: true, data: {} }),
      addFiles: async () => ({ ok: true, data: { count: 0 } }),
      uploadFile: async () => ({ ok: true, data: { count: 0 } }),
      useOpenableFiles: () => ready({ items: [] }),
      useSourceConnections: () =>
        ready({ items: [{ name: "public-pages", title: "Public pages", connectorType: "web" }] }),
      useSources: () => ready({ sources: [] }),
      syncSource: async () => ({ ok: true, data: {} }),
      retrySource: async () => ({ ok: true, data: { queued: 0 } }),
      confirmSource: async () => ({ ok: true, data: {} })
    } satisfies KnowledgeBaseSource;
    const html = renderToStaticMarkup(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { locale: "en", children: null },
          createElement(KnowledgeSourcesSection, {
            source,
            knowledgeBase: "public",
            published: undefined,
            owner: undefined,
            sources: [
              {
                ...newKnowledgeSource("public-pages", [], "web"),
                pages: "https://www.example.org/a"
              }
            ],
            canWrite: true,
            onChange: () => undefined
          })
        )
      )
    );
    expect(html).toContain('data-knowledge-source-field="pages"');
    expect(html).toContain('data-knowledge-source-field="prefixes"');
    expect(html).toContain("https://www.example.org/a");
    expect(html).toContain("Everything below");
    expect(html).not.toContain('data-knowledge-source-field="folders"');
  });
});

describe("the citation of a web page", () => {
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

  function show(locale: "en" | "de", source: KnowledgeCitationSource = page) {
    act(() =>
      root.render(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(
            TranslationProvider,
            { locale, children: null },
            createElement(
              WorkspaceApiClientProvider,
              { apiBaseUrl: "https://api.example.test", children: null },
              createElement(AssistantSourcePart, {
                type: "source",
                sourceType: "document",
                id: "knowledge:K1",
                title: source.fileName,
                filename: source.fileName,
                mediaType: "application/octet-stream",
                providerMetadata: { vivdCatalyst: { knowledge: { ...source } } },
                status: { type: "complete" }
              } as const)
            )
          )
        )
      )
    );
  }

  it("names the page with the date it states, and links the page", () => {
    show("de");
    expect(host.querySelector("[data-knowledge-source]")?.textContent).toBe(
      "Section 7 Depreciation, Stand 01.11.2026"
    );
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://www.example.org/law/s7");
    show("en");
    expect(host.querySelector("[data-knowledge-source]")?.textContent).toBe(
      "Section 7 Depreciation, as of 01/11/2026"
    );
  });

  it("names a page that states no date only with the day it was retrieved, never as its Stand", () => {
    const { statedAt: _stated, ...unstated } = page;
    show("de", unstated);
    expect(host.querySelector("[data-knowledge-source]")?.textContent).toBe(
      "Section 7 Depreciation, abgerufen 10.11.2026"
    );
    show("en", unstated);
    expect(host.querySelector("[data-knowledge-source]")?.textContent).toBe(
      "Section 7 Depreciation, retrieved 10/11/2026"
    );
  });
});
