// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_DOCUMENT_FAILURE_CODES } from "@work-shape/catalyst-asset-schemas";
import { TranslationProvider } from "@work-shape/catalyst-chat-ui";
import {
  documentsStillIndexing,
  KNOWLEDGE_DOCUMENT_FAILURES,
  KnowledgeAddDialog,
  KnowledgeDocuments,
  knowledgeStateStillChanging,
  type KnowledgeBaseSource,
  type KnowledgeBaseState,
  type KnowledgeDocument,
  type KnowledgeOpenableFile,
  type KnowledgeRead
} from "@work-shape/catalyst-chat-ui/build-area";
import { UiRoot, uiLabelsDe, uiLabelsEn } from "@work-shape/catalyst-ui";

// The Documents section of a Knowledge Base that keeps documents (KB-5f) and its Add dialog,
// against planted answers of `knowledge.<id>.list_documents`, `retry`, `remove_documents` and
// `add_files`: each state with the reason of a failed one in plain words, Add, Retry and Remove
// only for whoever may change the Knowledge Base, and the limits of one add (20 files, 25 MiB
// each) kept by the dialog.

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

const MiB = 1024 * 1024;
const ready = <Answer>(data: Answer): KnowledgeRead<Answer> => ({ status: "ready", data });

function document_(
  id: string,
  state: KnowledgeDocument["state"],
  extra: Partial<KnowledgeDocument> = {}
): KnowledgeDocument {
  return {
    id,
    fileId: `file_${id}`,
    fileName: `${id}.md`,
    title: id,
    format: "markdown",
    bytes: 2048,
    state,
    addedAt: "2026-10-17T09:00:00.000Z",
    updatedAt: "2026-10-17T09:00:00.000Z",
    ...extra
  };
}

const documents: KnowledgeDocument[] = [
  document_("handbuch", "pending"),
  document_("vertrag", "indexed", { format: "pdf", fileName: "vertrag.pdf", bytes: 3 * MiB }),
  document_("scan", "failed", {
    format: "pdf",
    fileName: "scan.pdf",
    failureCode: "knowledge_text_empty"
  })
];

function file(name: string, extra: Partial<KnowledgeOpenableFile> = {}): KnowledgeOpenableFile {
  return {
    conversationId: "conv_1",
    fileId: `file_${name}`,
    name,
    bytes: 1024,
    conversationTitle: "Objektunterlagen",
    ...extra
  };
}

function plantedSource(overrides: Partial<KnowledgeBaseSource> = {}) {
  const unused = async () => ({ ok: false as const, refused: false, message: undefined });
  const retry = vi.fn<KnowledgeBaseSource["retry"]>(async () => ({ ok: true, data: {} }));
  const remove = vi.fn<KnowledgeBaseSource["remove"]>(async () => ({ ok: true, data: {} }));
  const addFiles = vi.fn<KnowledgeBaseSource["addFiles"]>(async () => ({
    ok: true,
    data: { count: 1 }
  }));
  const uploadFile = vi.fn<KnowledgeBaseSource["uploadFile"]>(async () => ({
    ok: true,
    data: { count: 1 }
  }));
  const source: KnowledgeBaseSource = {
    useState: () =>
      ready({ id: "asset_objektunterlagen", name: "objektunterlagen", status: "ok", tables: [] }),
    check: unused,
    query: unused,
    search: unused,
    useDataStores: () => ready({ items: [] }),
    useStoreTables: () => ready([]),
    useKnowledgeBases: () => ready({ items: [] }),
    useDocuments: () => ready({ documents }),
    useOpenableFiles: () => ready({ items: [] }),
    retry,
    remove,
    addFiles,
    uploadFile,
    ...overrides
  };
  return Object.assign(source, {
    retried: retry,
    removed: remove,
    added: addFiles,
    uploaded: uploadFile
  });
}

function show(element: ReturnType<typeof createElement>, locale: "en" | "de" = "en") {
  act(() =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: locale === "de" ? uiLabelsDe : uiLabelsEn },
        createElement(TranslationProvider, { locale, children: null }, element)
      )
    )
  );
}

function row(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-knowledge-document="${id}"]`);
  if (!found) throw new Error(`no row for ${id}`);
  return found;
}

function button(name: string, within: ParentNode = document): HTMLButtonElement | undefined {
  return [...within.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name
  );
}

function removeButton(id: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`[data-knowledge-remove="${id}"]`);
}

/** The confirmation of a removal, while it is open. */
function removeDialog(): HTMLDialogElement | null {
  const dialog = document.querySelector("[data-knowledge-remove-dialog]")?.closest("dialog");
  return dialog?.open ? dialog : null;
}

function checkbox(name: string): HTMLButtonElement {
  const item = document.querySelector(`[data-knowledge-add-file="${name}"]`);
  const box = item?.querySelector<HTMLButtonElement>('[role="checkbox"]');
  if (!box) throw new Error(`no box for ${name}`);
  return box;
}

describe("the Documents section", () => {
  it("shows each document with its state, and the reason of a failed one in plain words", () => {
    show(
      createElement(KnowledgeDocuments, {
        source: plantedSource(),
        knowledgeBase: "objektunterlagen",
        publishedRevision: 1,
        canWrite: true
      })
    );

    expect(row("handbuch").dataset.knowledgeDocumentState).toBe("pending");
    expect(row("handbuch").textContent).toContain("Being indexed");
    expect(row("handbuch").textContent).toContain("Markdown · 2 KiB");
    expect(row("vertrag").textContent).toContain("Searchable");
    expect(row("vertrag").textContent).toContain("PDF · 3 MiB");
    expect(row("scan").textContent).toContain("Failed");
    expect(row("scan").textContent).toContain(
      "The file has no text to search, such as a scanned PDF without a text layer."
    );
    // The code itself is the instance's, not the reader's.
    expect(row("scan").textContent).not.toContain("knowledge_text_empty");
  });

  it("speaks German, du-form, first", () => {
    show(
      createElement(KnowledgeDocuments, {
        source: plantedSource(),
        knowledgeBase: "objektunterlagen",
        publishedRevision: 1,
        canWrite: true
      }),
      "de"
    );

    expect(row("handbuch").textContent).toContain("Wird indexiert");
    expect(row("vertrag").textContent).toContain("Durchsuchbar");
    expect(row("scan").textContent).toContain("Fehlgeschlagen");
    expect(row("scan").textContent).toContain(
      "Die Datei hat keinen Text zum Durchsuchen, zum Beispiel ein gescanntes PDF ohne Textebene."
    );
    expect(button("Erneut versuchen", row("scan"))).toBeDefined();
    expect(button("Dokumente hinzufügen")).toBeDefined();
  });

  it("says plainly when a document's original is stored at its source", () => {
    const synced = [
      document_("richtlinie", "indexed", {
        format: "pdf",
        fileName: "richtlinie.pdf",
        originalStatus: "released"
      }),
      document_("kopie", "indexed", { originalStatus: "available" }),
      document_("leer", "failed", {
        originalStatus: "released",
        failureCode: "knowledge_text_empty"
      })
    ];
    const source = plantedSource({ useDocuments: () => ready({ documents: synced }) });
    const shown = {
      source,
      knowledgeBase: "objektunterlagen",
      publishedRevision: 1,
      canWrite: true
    };

    show(createElement(KnowledgeDocuments, shown));
    expect(row("richtlinie").textContent).toContain(
      "PDF · 2 KiB · Original is stored at the source"
    );
    expect(row("richtlinie").textContent).toContain("Searchable");
    expect(row("kopie").textContent).not.toContain("Original is stored at the source");
    expect(row("leer").textContent).toContain(
      "The file has no text to search, such as a scanned PDF without a text layer. · Original is stored at the source"
    );
    // No way to open the original: the notice is text, not an action.
    expect(button("Open", row("richtlinie"))).toBeUndefined();

    show(createElement(KnowledgeDocuments, shown), "de");
    expect(row("richtlinie").textContent).toContain("Original liegt in der Quelle");
    expect(row("kopie").textContent).not.toContain("Original liegt in der Quelle");
  });

  it("marks a searchable document whose fields wait for the budget, in both languages", () => {
    const paused = [
      document_("rechnung", "indexed", {
        format: "pdf",
        fileName: "rechnung.pdf",
        fieldsPending: true
      }),
      document_("angebot", "indexed", { fieldsPending: false }),
      document_("kaputt", "failed", { fieldsPending: true, failureCode: "knowledge_text_empty" })
    ];
    const shown = {
      source: plantedSource({ useDocuments: () => ready({ documents: paused }) }),
      knowledgeBase: "objektunterlagen",
      publishedRevision: 1,
      canWrite: true
    };

    show(createElement(KnowledgeDocuments, shown));
    // Still searchable: the pause is beside the state, not instead of it.
    expect(row("rechnung").textContent).toContain("Searchable");
    expect(row("rechnung").textContent).toContain("Fields pending");
    expect(row("rechnung").textContent).toContain(
      "PDF · 2 KiB · Fields are filled in once the budget resets or is raised"
    );
    expect(row("rechnung").hasAttribute("data-knowledge-fields-pending")).toBe(true);
    expect(row("angebot").textContent).not.toContain("Fields pending");
    // A failed document says why it failed; the pause is not its concern.
    expect(row("kaputt").textContent).not.toContain("Fields pending");
    expect(row("rechnung").textContent).not.toContain("fieldsPending");

    show(createElement(KnowledgeDocuments, shown), "de");
    expect(row("rechnung").textContent).toContain("Durchsuchbar");
    expect(row("rechnung").textContent).toContain("Felder ausstehend");
    expect(row("rechnung").textContent).toContain(
      "Felder werden gefüllt, sobald das Budget zurückgesetzt oder erhöht wird"
    );
    expect(row("angebot").textContent).not.toContain("Felder ausstehend");
  });

  it("says why fields wait: the monthly budget, or a document over the token limit", () => {
    const waiting = [
      document_("monat", "indexed", {
        fieldsPending: true,
        fieldsPendingReason: { reason: "monthly_budget" }
      }),
      document_("gross", "indexed", {
        format: "pdf",
        fileName: "gross.pdf",
        fieldsPending: true,
        fieldsPendingReason: {
          reason: "token_budget",
          estimatedTokens: 184_250,
          reservedOutputTokens: 512,
          maxTokensPerDocument: 120_000
        }
      })
    ];
    const shown = {
      source: plantedSource({ useDocuments: () => ready({ documents: waiting }) }),
      knowledgeBase: "objektunterlagen",
      publishedRevision: 1,
      canWrite: true
    };
    const budget = "Fields are filled in once the budget resets or is raised";

    show(createElement(KnowledgeDocuments, shown));
    expect(row("monat").textContent).toContain(budget);
    expect(row("monat").textContent).not.toContain("tokens");
    expect(row("gross").textContent).toContain("Searchable");
    expect(row("gross").textContent).toContain("Fields pending");
    expect(row("gross").textContent).toContain(
      "Fields wait: this document needs an estimated 184,250 input tokens plus 512 reserved output tokens, exceeding the limit of 120,000 tokens per document. Raise the limit to fill them in"
    );
    expect(row("gross").textContent).not.toContain(budget);
    expect(row("gross").textContent).not.toMatch(/token_budget|maxTokensPerDocument|undefined/);
    // The whole reason wraps instead of being cut off.
    expect(row("gross").innerHTML).toContain("break-words");

    show(createElement(KnowledgeDocuments, shown), "de");
    expect(row("monat").textContent).toContain(
      "Felder werden gefüllt, sobald das Budget zurückgesetzt oder erhöht wird"
    );
    expect(row("gross").textContent).toContain(
      "Felder warten: Dieses Dokument braucht geschätzt 184.250 Eingabe-Tokens plus 512 reservierte Ausgabe-Tokens und überschreitet damit die Grenze von 120.000 Tokens je Dokument. Erhöhe die Grenze, damit sie gefüllt werden"
    );
  });

  it("names the page limit of a document with too many pages, in both languages", () => {
    const showDocument = (long: KnowledgeDocument, locale?: "de") =>
      show(
        createElement(KnowledgeDocuments, {
          source: plantedSource({ useDocuments: () => ready({ documents: [long] }) }),
          knowledgeBase: "objektunterlagen",
          publishedRevision: 1,
          canWrite: true
        }),
        locale
      );
    const overLimit: Partial<KnowledgeDocument> = {
      format: "pdf",
      fileName: "akte.pdf",
      failureCode: "knowledge_file_too_many_pages"
    };
    const long = document_("akte", "failed", { ...overLimit, failurePageLimit: 12_345 });

    showDocument(long);
    expect(row("akte").textContent).toContain(
      "Page limit reached. The current limit is 12,345 pages. Split the file, or ask the operator for a higher limit and retry."
    );
    expect(button("Retry", row("akte"))).toBeDefined();
    showDocument(long, "de");
    expect(row("akte").textContent).toContain(
      "Seitengrenze erreicht. Die aktuelle Grenze liegt bei 12.345 Seiten."
    );
    expect(row("akte").textContent).not.toContain("knowledge_file_too_many_pages");

    // An older instance sends no limit: the sentence names no number.
    const withoutLimit = document_("akte", "failed", overLimit);
    showDocument(withoutLimit);
    expect(row("akte").textContent).toContain(
      "Page limit reached. Split the file, or ask the operator for a higher limit and retry."
    );
    expect(row("akte").textContent).not.toMatch(/\d+ pages|undefined/);
    showDocument(withoutLimit, "de");
    expect(row("akte").textContent).toContain("Seitengrenze erreicht. Teile die Datei");
    expect(row("akte").textContent).not.toMatch(/\d+ Seiten|undefined/);
  });

  it("names the page count of a document that took too long to convert, in both languages", () => {
    const showDocument = (slow: KnowledgeDocument, locale?: "de") =>
      show(
        createElement(KnowledgeDocuments, {
          source: plantedSource({ useDocuments: () => ready({ documents: [slow] }) }),
          knowledgeBase: "objektunterlagen",
          publishedRevision: 1,
          canWrite: true
        }),
        locale
      );
    const timedOut: Partial<KnowledgeDocument> = {
      format: "pdf",
      fileName: "akte.pdf",
      failureCode: "knowledge_conversion_timeout"
    };
    const counted = document_("akte", "failed", { ...timedOut, failurePageCount: 6001 });

    showDocument(counted);
    expect(row("akte").textContent).toContain(
      "This document of 6,001 pages took too long to convert. Split it into smaller files and retry."
    );
    expect(button("Retry", row("akte"))).toBeDefined();
    showDocument(counted, "de");
    expect(row("akte").textContent).toContain(
      "Dieses Dokument mit 6.001 Seiten hat zu lange zum Umwandeln gebraucht."
    );
    expect(row("akte").textContent).not.toContain("knowledge_conversion_timeout");

    // Without a page count the sentence names no number.
    const uncounted = document_("akte", "failed", timedOut);
    showDocument(uncounted);
    expect(row("akte").textContent).toContain(
      "This document took too long to convert. Split it into smaller files and retry."
    );
    expect(row("akte").textContent).not.toMatch(/\d+ pages|undefined|\{count\}/);
    showDocument(uncounted, "de");
    expect(row("akte").textContent).toContain(
      "Dieses Dokument hat zu lange zum Umwandeln gebraucht."
    );
    expect(row("akte").textContent).not.toMatch(/\d+ Seiten|undefined|\{count\}/);
  });

  it("has a sentence for every failure code the instance sends", () => {
    expect(Object.keys(KNOWLEDGE_DOCUMENT_FAILURES).sort()).toEqual(
      [...KNOWLEDGE_DOCUMENT_FAILURE_CODES].sort()
    );
  });

  it("offers Retry on a failed document alone, and retries it by its id", async () => {
    const source = plantedSource();
    show(
      createElement(KnowledgeDocuments, {
        source,
        knowledgeBase: "objektunterlagen",
        publishedRevision: 1,
        canWrite: true
      })
    );

    expect(button("Retry", row("handbuch"))).toBeUndefined();
    expect(button("Retry", row("vertrag"))).toBeUndefined();
    await act(async () => button("Retry", row("scan"))?.click());

    expect(source.retried).toHaveBeenCalledWith("objektunterlagen", ["scan"]);
  });

  it("says why a retry did not run", async () => {
    const source = plantedSource({
      retry: async () => ({ ok: false, refused: true, message: undefined })
    });
    show(
      createElement(KnowledgeDocuments, {
        source,
        knowledgeBase: "objektunterlagen",
        publishedRevision: 1,
        canWrite: true
      })
    );

    await act(async () => button("Retry", row("scan"))?.click());

    expect(document.body.textContent).toContain("You may not change this knowledge base.");
  });

  it("removes a document once the remover confirms it by name, and the row leaves", async () => {
    let shown = documents;
    const source = plantedSource({ useDocuments: () => ready({ documents: shown }) });
    source.removed.mockImplementation(async (_knowledgeBase, ids) => {
      shown = shown.filter((document) => !ids.includes(document.id));
      return { ok: true, data: { removed: ids.length } };
    });
    show(
      createElement(KnowledgeDocuments, {
        source,
        knowledgeBase: "objektunterlagen",
        publishedRevision: 1,
        canWrite: true
      })
    );

    // Every document can be removed, whatever its state, and the control names it.
    for (const id of ["handbuch", "vertrag", "scan"]) expect(removeButton(id)).not.toBeNull();
    expect(removeButton("vertrag")?.getAttribute("aria-label")).toBe("Remove vertrag");
    await act(async () => removeButton("vertrag")?.click());

    expect(removeDialog()?.textContent).toContain("Remove the document vertrag?");
    expect(removeDialog()?.textContent).toContain("A file added from a conversation stays there.");
    expect(source.removed).not.toHaveBeenCalled();
    const dialog = removeDialog();
    if (!dialog) throw new Error("no confirmation");
    await act(async () => button("Remove", dialog)?.click());

    expect(source.removed).toHaveBeenCalledWith("objektunterlagen", ["vertrag"]);
    expect(removeDialog()).toBeNull();
    expect(document.querySelector('[data-knowledge-document="vertrag"]')).toBeNull();
    expect(document.querySelectorAll("[data-knowledge-document]")).toHaveLength(2);
    expect(document.body.textContent).toContain("The document vertrag was removed.");
  });

  it("says only what happened last: a removal after an add replaces the added notice", async () => {
    const source = plantedSource({
      useOpenableFiles: () => ready({ items: [file("Reiseregeln.md")] })
    });
    show(
      createElement(KnowledgeDocuments, {
        source,
        knowledgeBase: "objektunterlagen",
        publishedRevision: 1,
        canWrite: true
      })
    );

    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-knowledge-add]")?.click()
    );
    await act(async () => checkbox("Reiseregeln.md").click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-knowledge-add-submit]")?.click()
    );
    expect(document.body.textContent).toContain("1 document added.");

    await act(async () => removeButton("vertrag")?.click());
    const dialog = removeDialog();
    if (!dialog) throw new Error("no confirmation");
    await act(async () => button("Remove", dialog)?.click());

    expect(document.body.textContent).toContain("The document vertrag was removed.");
    expect(document.body.textContent).not.toContain("1 document added.");
  });

  it("removes nothing when the remover cancels", async () => {
    const source = plantedSource();
    show(
      createElement(KnowledgeDocuments, {
        source,
        knowledgeBase: "objektunterlagen",
        publishedRevision: 1,
        canWrite: true
      })
    );

    await act(async () => removeButton("scan")?.click());
    const dialog = removeDialog();
    if (!dialog) throw new Error("no confirmation");
    await act(async () => button("Cancel", dialog)?.click());

    expect(removeDialog()).toBeNull();
    expect(source.removed).not.toHaveBeenCalled();
    expect(row("scan")).toBeDefined();
  });

  it("keeps the confirmation open and says why a removal did not run", async () => {
    const source = plantedSource({
      remove: async () => ({ ok: false, refused: false, message: undefined })
    });
    show(
      createElement(KnowledgeDocuments, {
        source,
        knowledgeBase: "objektunterlagen",
        publishedRevision: 1,
        canWrite: true
      }),
      "de"
    );

    expect(removeButton("vertrag")?.getAttribute("aria-label")).toBe("vertrag entfernen");
    await act(async () => removeButton("vertrag")?.click());
    const dialog = removeDialog();
    if (!dialog) throw new Error("no confirmation");
    expect(dialog.textContent).toContain("Dokument vertrag entfernen?");
    await act(async () => button("Entfernen", dialog)?.click());

    expect(removeDialog()?.textContent).toContain("Das Dokument konnte nicht entfernt werden.");
    expect(row("vertrag")).toBeDefined();
    expect(document.body.textContent).not.toContain("wurde entfernt");
  });

  it("offers no Remove for a document synced from a source, which its source removes", () => {
    const synced = document_("preisliste", "indexed", { sourceId: "sharepoint" });
    show(
      createElement(KnowledgeDocuments, {
        source: plantedSource({ useDocuments: () => ready({ documents: [synced, ...documents] }) }),
        knowledgeBase: "objektunterlagen",
        publishedRevision: 1,
        canWrite: true
      })
    );

    expect(row("preisliste")).toBeDefined();
    expect(removeButton("preisliste")).toBeNull();
    expect(removeButton("vertrag")).not.toBeNull();
  });

  it("says in German why a synced document was refused, not the instance's English", async () => {
    const source = plantedSource({
      remove: async () => ({
        ok: false,
        refused: false,
        message: "Synced documents cannot be removed locally.",
        reason: "knowledge_synced_document_remove_refused"
      })
    });
    show(
      createElement(KnowledgeDocuments, {
        source,
        knowledgeBase: "objektunterlagen",
        publishedRevision: 1,
        canWrite: true
      }),
      "de"
    );

    await act(async () => removeButton("vertrag")?.click());
    const dialog = removeDialog();
    if (!dialog) throw new Error("no confirmation");
    await act(async () => button("Entfernen", dialog)?.click());

    expect(removeDialog()?.textContent).toContain(
      "Dieses Dokument kommt aus einer Quelle und lässt sich hier nicht entfernen."
    );
    expect(document.body.textContent).not.toContain("cannot be removed locally");
  });

  it("shows whoever may only use the Knowledge Base the list, without Add, Retry or Remove", () => {
    show(
      createElement(KnowledgeDocuments, {
        source: plantedSource(),
        knowledgeBase: "objektunterlagen",
        publishedRevision: 1,
        canWrite: false
      })
    );

    expect(document.querySelectorAll("[data-knowledge-document]")).toHaveLength(3);
    expect(document.querySelector("[data-knowledge-add]")).toBeNull();
    expect(button("Retry", row("scan"))).toBeUndefined();
    expect(document.querySelector("[data-knowledge-remove]")).toBeNull();
  });

  it("tells a reader without the right to use it that they may not see the documents", () => {
    show(
      createElement(KnowledgeDocuments, {
        source: plantedSource({ useDocuments: () => ({ status: "refused" }) }),
        knowledgeBase: "objektunterlagen",
        publishedRevision: 1,
        canWrite: false
      })
    );

    expect(document.body.textContent).toContain(
      "You may not see the documents of this knowledge base."
    );
  });

  it("says who adds documents to an empty Knowledge Base", () => {
    const empty = plantedSource({ useDocuments: () => ready({ documents: [] }) });
    show(
      createElement(KnowledgeDocuments, {
        source: empty,
        knowledgeBase: "kb",
        publishedRevision: 1,
        canWrite: true
      })
    );
    expect(document.body.textContent).toContain(
      "No documents yet. Upload files from your computer or add files from your conversations."
    );

    show(
      createElement(KnowledgeDocuments, {
        source: empty,
        knowledgeBase: "kb",
        publishedRevision: 1,
        canWrite: false
      })
    );
    expect(document.body.textContent).toContain(
      "No documents yet. Somebody who may change this knowledge base adds them."
    );
  });

  it("reads the documents again while one is being indexed, and stops once none is", () => {
    expect(documentsStillIndexing(documents)).toBe(true);
    expect(documentsStillIndexing(documents.filter((each) => each.state !== "pending"))).toBe(
      false
    );
  });
});

describe("processing that waits for a worker", () => {
  const state = (extra: Partial<KnowledgeBaseState> = {}): KnowledgeBaseState => ({
    id: "asset_objektunterlagen",
    name: "objektunterlagen",
    status: "ok",
    tables: [],
    ...extra
  });
  const notice = () => document.querySelector("[data-knowledge-processing-waiting]");

  it("says that processing waits while no worker takes the documents, in English and German", () => {
    const source = plantedSource({ useState: () => ready(state({ processingWaiting: true })) });
    const props = {
      source,
      knowledgeBase: "objektunterlagen",
      publishedRevision: 1,
      canWrite: true
    };
    show(createElement(KnowledgeDocuments, props));
    expect(notice()?.textContent).toBe(
      "Processing is waiting: the knowledge base service is not responding."
    );
    show(createElement(KnowledgeDocuments, props), "de");
    expect(notice()?.textContent).toBe("Verarbeitung wartet auf den Dienst für Wissensbasen.");
  });

  it("says nothing while a worker takes them, and nothing for an instance that does not say", () => {
    for (const answer of [state({ processingWaiting: false }), state()]) {
      show(
        createElement(KnowledgeDocuments, {
          source: plantedSource({ useState: () => ready(answer) }),
          knowledgeBase: "objektunterlagen",
          publishedRevision: 1,
          canWrite: true
        })
      );
      expect(notice()).toBeNull();
    }
  });

  it("watches processing with no document pending, as a sync queued before any document", () => {
    const useState = vi.fn<KnowledgeBaseSource["useState"]>(() => ready(state()));
    const props = { knowledgeBase: "objektunterlagen", publishedRevision: 3, canWrite: true };
    for (const listed of [[], documents.filter((each) => each.state !== "pending"), documents]) {
      show(
        createElement(KnowledgeDocuments, {
          ...props,
          source: plantedSource({ useState, useDocuments: () => ready({ documents: listed }) })
        })
      );
      expect(useState).toHaveBeenLastCalledWith("objektunterlagen", 3, true);
    }
  });

  it("reads the state again while watched, made or waiting, and a structured one stops after", () => {
    // The Documents section watches: a sync before any document leaves no pending document.
    expect(knowledgeStateStillChanging(state(), true)).toBe(true);
    expect(knowledgeStateStillChanging(state({ processingWaiting: true }), false)).toBe(true);
    expect(knowledgeStateStillChanging(state({ status: "preparing" }), false)).toBe(true);
    // The Status section of a Knowledge Base of tables polls as before.
    expect(knowledgeStateStillChanging(state({ status: "needs_attention" }), false)).toBe(false);
    expect(knowledgeStateStillChanging(state(), false)).toBe(false);
  });
});

describe("a Knowledge Base whose store is still being made (ACCEPT-FIX-8, E7)", () => {
  // Right after a publish the store has no documents table yet, and listing the documents
  // failed with the instance's raw SQL error. The section now waits for the state to say the
  // store is ready, says so meanwhile, and reads the documents by itself once it is.
  const sqlError =
    "Listing the documents names a table or view that does not exist (SQLSTATE 42P01)";
  const stateOf = (status: KnowledgeBaseState["status"]): KnowledgeBaseState => ({
    id: "asset_richtlinien",
    name: "richtlinien",
    status,
    tables: []
  });
  const sectionOf = (
    status: KnowledgeBaseState["status"],
    useDocuments: KnowledgeBaseSource["useDocuments"]
  ) =>
    createElement(KnowledgeDocuments, {
      source: plantedSource({ useState: () => ready(stateOf(status)), useDocuments }),
      knowledgeBase: "richtlinien",
      publishedRevision: 1,
      canWrite: true
    });
  const preparingNotice = () => document.querySelector("[data-knowledge-documents-preparing]");

  it("reads no documents while its store is made and says so, in English and German", () => {
    const useDocuments = vi.fn<KnowledgeBaseSource["useDocuments"]>(() => ({
      status: "failed",
      message: sqlError,
      retry: () => undefined
    }));
    show(sectionOf("preparing", useDocuments));
    expect(useDocuments).toHaveBeenLastCalledWith("richtlinien", false);
    expect(preparingNotice()?.textContent).toBe(
      "Its store is being made. The documents show here by themselves once it is ready."
    );
    expect(document.body.textContent).not.toContain("SQLSTATE");
    expect(button("Try again")).toBeUndefined();

    show(sectionOf("preparing", useDocuments), "de");
    expect(preparingNotice()?.textContent).toBe(
      "Ihr Speicher wird angelegt. Die Dokumente erscheinen hier von selbst, sobald er bereit ist."
    );
    expect(document.body.textContent).not.toContain("SQLSTATE");
  });

  it("reads no documents before the state answered, so a page opened right after a publish shows no error", () => {
    const useDocuments = vi.fn<KnowledgeBaseSource["useDocuments"]>(() => ({
      status: "failed",
      message: sqlError,
      retry: () => undefined
    }));
    show(
      createElement(KnowledgeDocuments, {
        source: plantedSource({ useState: () => ({ status: "loading" }), useDocuments }),
        knowledgeBase: "richtlinien",
        publishedRevision: 1,
        canWrite: true
      })
    );
    expect(useDocuments).toHaveBeenLastCalledWith("richtlinien", false);
    expect(document.body.textContent).not.toContain("SQLSTATE");
    expect(button("Try again")).toBeUndefined();
  });

  it("goes from loading to being made to listed without a reload, reading documents only once ready", () => {
    let current: KnowledgeRead<KnowledgeBaseState> = { status: "loading" };
    const useDocuments = vi.fn<KnowledgeBaseSource["useDocuments"]>((_name, enabled) =>
      enabled === true
        ? ready({ documents })
        : { status: "failed", message: sqlError, retry: () => undefined }
    );
    const section = () =>
      createElement(KnowledgeDocuments, {
        source: plantedSource({ useState: () => current, useDocuments }),
        knowledgeBase: "richtlinien",
        publishedRevision: 1,
        canWrite: true
      });
    // Opened right after the publish: the state has not answered yet.
    show(section());
    expect(useDocuments).toHaveBeenLastCalledWith("richtlinien", false);
    expect(document.querySelector("[data-knowledge-document]")).toBeNull();
    expect(document.body.textContent).not.toContain("SQLSTATE");
    // Its store is being made, or the check that would say so has not found it yet.
    for (const status of ["preparing", "unchecked"] as const) {
      current = ready(stateOf(status));
      show(section());
      expect(useDocuments).toHaveBeenLastCalledWith("richtlinien", false);
      expect(preparingNotice()).not.toBeNull();
      expect(document.body.textContent).not.toContain("SQLSTATE");
    }
    // It stands: the documents are read and listed.
    current = ready(stateOf("ok"));
    show(section());
    expect(useDocuments).toHaveBeenLastCalledWith("richtlinien", true);
    expect(preparingNotice()).toBeNull();
    expect(row("vertrag").getAttribute("data-knowledge-document-state")).toBe("indexed");
  });

  it("reads no documents where the state could not be read, and offers to try again without the instance's words", () => {
    const retry = vi.fn();
    const useDocuments = vi.fn<KnowledgeBaseSource["useDocuments"]>(() => ({
      status: "failed",
      message: sqlError,
      retry: () => undefined
    }));
    show(
      createElement(KnowledgeDocuments, {
        source: plantedSource({
          useState: () => ({ status: "failed", message: sqlError, retry }),
          useDocuments
        }),
        knowledgeBase: "richtlinien",
        publishedRevision: 1,
        canWrite: true
      })
    );
    expect(useDocuments).toHaveBeenLastCalledWith("richtlinien", false);
    expect(document.body.textContent).not.toContain("SQLSTATE");
    expect(document.body.textContent).toContain("The documents could not be loaded.");
    act(() => button("Try again")?.click());
    expect(retry).toHaveBeenCalled();
  });
});

describe("the Add dialog", () => {
  function openDialog(
    source: KnowledgeBaseSource,
    locale: "en" | "de" = "en",
    formats: readonly string[] = ["txt", "markdown", "pdf", "docx"]
  ) {
    show(
      createElement(KnowledgeAddDialog, {
        source,
        knowledgeBase: "objektunterlagen",
        formats,
        onClose: () => undefined,
        onAdded: () => undefined
      }),
      locale
    );
  }

  it("names the limits of one add, with the formats the instance reads", () => {
    openDialog(plantedSource());
    expect(document.body.textContent).toContain(
      "Up to 20 files at once, each up to 25 MiB: TXT, Markdown, PDF, and DOCX."
    );

    openDialog(plantedSource(), "de");
    expect(document.body.textContent).toContain(
      "Bis zu 20 Dateien auf einmal, jede bis 25 MiB: TXT, Markdown, PDF und DOCX."
    );

    // Without document processing, no hint in the dialog promises PDF or DOCX.
    openDialog(plantedSource(), "en", ["txt", "markdown"]);
    expect(document.body.textContent).toContain(
      "Up to 20 files at once, each up to 25 MiB: TXT and Markdown."
    );
    expect(document.body.textContent).not.toMatch(/PDF|DOCX/u);
    openDialog(plantedSource(), "de", ["txt", "markdown"]);
    expect(document.body.textContent).toContain(
      "Bis zu 20 Dateien auf einmal, jede bis 25 MiB: TXT und Markdown."
    );
    expect(document.body.textContent).not.toMatch(/PDF|DOCX/u);
  });

  it("lets no PDF or DOCX of a conversation be chosen where the instance reads only text", () => {
    const files = () =>
      ready({
        items: [file("handbuch.md"), file("notiz.txt"), file("expose.pdf"), file("vertrag.docx")]
      });
    openDialog(plantedSource({ useOpenableFiles: files }), "en", ["txt", "markdown"]);

    expect(checkbox("handbuch.md").disabled).toBe(false);
    expect(checkbox("notiz.txt").disabled).toBe(false);
    for (const name of ["expose.pdf", "vertrag.docx"]) {
      expect(checkbox(name).disabled).toBe(true);
      expect(document.querySelector(`[data-knowledge-add-file="${name}"]`)?.textContent).toContain(
        "Knowledge bases here read TXT and Markdown only."
      );
    }

    openDialog(plantedSource({ useOpenableFiles: files }), "de", ["txt", "markdown"]);
    expect(checkbox("expose.pdf").disabled).toBe(true);
    expect(document.querySelector('[data-knowledge-add-file="expose.pdf"]')?.textContent).toContain(
      "Wissensbasen lesen hier nur TXT und Markdown."
    );

    // With document processing the same files can be chosen.
    openDialog(plantedSource({ useOpenableFiles: files }));
    expect(checkbox("expose.pdf").disabled).toBe(false);
    expect(checkbox("vertrag.docx").disabled).toBe(false);
  });

  it("lets no file over 25 MiB and no file in another format be chosen, and says why", () => {
    openDialog(
      plantedSource({
        useOpenableFiles: () =>
          ready({
            items: [
              file("handbuch.md"),
              file("gross.pdf", { bytes: 25 * MiB + 1 }),
              file("genau.pdf", { bytes: 25 * MiB }),
              file("tabelle.xlsx")
            ]
          })
      })
    );

    expect(checkbox("handbuch.md").disabled).toBe(false);
    expect(checkbox("genau.pdf").disabled).toBe(false);
    expect(checkbox("gross.pdf").disabled).toBe(true);
    expect(document.querySelector('[data-knowledge-add-file="gross.pdf"]')?.textContent).toContain(
      "Larger than 25 MiB"
    );
    expect(checkbox("tabelle.xlsx").disabled).toBe(true);
    expect(
      document.querySelector('[data-knowledge-add-file="tabelle.xlsx"]')?.textContent
    ).toContain("Knowledge bases here read TXT, Markdown, PDF, and DOCX only.");
  });

  it("stops at 20 files and adds exactly the chosen ones", async () => {
    const files = Array.from({ length: 22 }, (_, index) => file(`notiz-${index}.txt`));
    const source = plantedSource({ useOpenableFiles: () => ready({ items: files }) });
    openDialog(source);
    const submit = () => document.querySelector<HTMLButtonElement>("[data-knowledge-add-submit]");

    expect(submit()?.disabled).toBe(true);
    for (const each of files.slice(0, 20)) {
      act(() => checkbox(each.name).click());
    }

    expect(checkbox("notiz-20.txt").disabled).toBe(true);
    expect(checkbox("notiz-21.txt").disabled).toBe(true);
    // A chosen box can still be cleared.
    expect(checkbox("notiz-0.txt").disabled).toBe(false);
    expect(document.querySelector("[data-knowledge-chosen]")?.textContent).toContain(
      "20 chosen, the most for one add."
    );
    await act(async () => submit()?.click());

    expect(source.added).toHaveBeenCalledTimes(1);
    const [knowledgeBase, sent] = source.added.mock.calls[0] ?? [];
    expect(knowledgeBase).toBe("objektunterlagen");
    expect(sent?.map((each) => each.fileId)).toEqual(files.slice(0, 20).map((each) => each.fileId));
  });

  it("says a refusal of the instance in plain words", async () => {
    openDialog(
      plantedSource({
        useOpenableFiles: () => ready({ items: [file("handbuch.md")] }),
        addFiles: async () => ({
          ok: false,
          refused: false,
          message: "Knowledge Base 'objektunterlagen' holds 10000 documents.",
          reason: "knowledge_documents_limit"
        })
      }),
      "de"
    );

    act(() => checkbox("handbuch.md").click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-knowledge-add-submit]")?.click()
    );

    expect(document.body.textContent).toContain(
      "Die Wissensbasis enthält schon so viele Dokumente, wie sie darf."
    );
  });

  it("says how to get a file into the list when the workspace has none", () => {
    openDialog(plantedSource());
    expect(document.body.textContent).toContain(
      "The conversations of your workspace hold no uploaded files yet. Upload files from your computer above."
    );
  });
});
