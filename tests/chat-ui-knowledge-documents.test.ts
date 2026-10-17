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
  const source: KnowledgeBaseSource = {
    useState: () => ({ status: "loading" }),
    check: unused,
    query: unused,
    search: unused,
    useDataStores: () => ready([]),
    useStoreTables: () => ready([]),
    useKnowledgeBases: () => ready([]),
    useDocuments: () => ready({ documents }),
    useOpenableFiles: () => ready([]),
    retry,
    remove,
    addFiles,
    ...overrides
  };
  return Object.assign(source, { retried: retry, removed: remove, added: addFiles });
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

  it("names the page limit of a document with too many pages, in both languages", () => {
    const long = document_("akte", "failed", {
      format: "pdf",
      fileName: "akte.pdf",
      failureCode: "knowledge_file_too_many_pages"
    });
    const source = plantedSource({ useDocuments: () => ready({ documents: [long] }) });
    const props = {
      source,
      knowledgeBase: "objektunterlagen",
      publishedRevision: 1,
      canWrite: true
    };
    show(createElement(KnowledgeDocuments, props));
    expect(row("akte").textContent).toContain("More than 500 pages.");
    expect(button("Retry", row("akte"))).toBeDefined();
    show(createElement(KnowledgeDocuments, props), "de");
    expect(row("akte").textContent).toContain("Mehr als 500 Seiten.");
    expect(row("akte").textContent).not.toContain("knowledge_file_too_many_pages");
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
    expect(removeDialog()?.textContent).toContain("The file stays in its conversation.");
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
    const source = plantedSource({ useOpenableFiles: () => ready([file("Reiseregeln.md")]) });
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
      "No documents yet. Add files from your conversations."
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
    expect(notice()?.textContent).toBe(
      "Verarbeitung wartet: Der Dienst für Wissensdatenbanken meldet sich nicht."
    );
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

describe("the Add dialog", () => {
  function openDialog(source: KnowledgeBaseSource, locale: "en" | "de" = "en") {
    show(
      createElement(KnowledgeAddDialog, {
        source,
        knowledgeBase: "objektunterlagen",
        onClose: () => undefined,
        onAdded: () => undefined
      }),
      locale
    );
  }

  it("names the limits of one add", () => {
    openDialog(plantedSource());
    expect(document.body.textContent).toContain(
      "Up to 20 files at once, each up to 25 MiB: PDF, DOCX, TXT or Markdown."
    );

    openDialog(plantedSource(), "de");
    expect(document.body.textContent).toContain(
      "Bis zu 20 Dateien auf einmal, jede bis 25 MiB: PDF, DOCX, TXT oder Markdown."
    );
  });

  it("lets no file over 25 MiB and no file in another format be chosen, and says why", () => {
    openDialog(
      plantedSource({
        useOpenableFiles: () =>
          ready([
            file("handbuch.md"),
            file("gross.pdf", { bytes: 25 * MiB + 1 }),
            file("genau.pdf", { bytes: 25 * MiB }),
            file("tabelle.xlsx")
          ])
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
    ).toContain("A knowledge base reads PDF, DOCX, TXT and Markdown only.");
  });

  it("stops at 20 files and adds exactly the chosen ones", async () => {
    const files = Array.from({ length: 22 }, (_, index) => file(`notiz-${index}.txt`));
    const source = plantedSource({ useOpenableFiles: () => ready(files) });
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
        useOpenableFiles: () => ready([file("handbuch.md")]),
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
      "Upload a file in a conversation, then add it here."
    );
  });
});
