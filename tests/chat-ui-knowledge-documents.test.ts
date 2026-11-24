// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_DOCUMENT_FAILURE_CODES } from "@work-shape/catalyst-asset-schemas";
import { TranslationProvider } from "./support/chat-ui/shared";
import {
  documentsStillIndexing,
  KNOWLEDGE_DOCUMENT_FAILURES,
  KnowledgeAddDialog,
  KnowledgeDocuments,
  knowledgeStateStillChanging,
  nextUpload,
  queueUploads,
  retryUpload,
  settleUpload,
  uploadableFile,
  uploadFileMaxBytes,
  uploadFormats,
  type KnowledgeBaseSource,
  type KnowledgeBaseState,
  type KnowledgeDocument,
  type KnowledgeOpenableFile,
  type KnowledgeRead
} from "@work-shape/catalyst-chat-ui/build-area";
import { UiRoot, uiLabelsDe, uiLabelsEn } from "@work-shape/catalyst-ui";
import { required } from "./support/assertions";

// The Documents section of a Knowledge Base that keeps documents (KB-5f) and its Add dialog,
// against planted answers of `knowledge.<id>.list_documents`, `retry`, `remove_documents` and
// `add_files`: each state with the reason of a failed one in plain words, Add, Retry and Remove
// only for whoever may change the Knowledge Base, and the limits of one add (20 files, 100 MiB
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

function section(source: KnowledgeBaseSource, canWrite = true, publishedRevision = 1) {
  return createElement(KnowledgeDocuments, {
    source,
    knowledgeBase: "objektunterlagen",
    publishedRevision,
    canWrite
  });
}

describe("the Documents section", () => {
  it("shows each document with its state, and the reason of a failed one, never its code", () => {
    show(section(plantedSource()));
    expect(row("handbuch").dataset.knowledgeDocumentState).toBe("pending");
    expect(row("vertrag").dataset.knowledgeDocumentState).toBe("indexed");
    expect(row("scan").textContent).toContain("The file has no text to search");
    expect(row("scan").textContent).not.toContain("knowledge_text_empty");
  });

  it("has a sentence for every failure code the instance sends", () => {
    expect(Object.keys(KNOWLEDGE_DOCUMENT_FAILURES).sort()).toEqual(
      [...KNOWLEDGE_DOCUMENT_FAILURE_CODES].sort()
    );
  });

  it("counts from the instance's summary, not the rows, while more pages follow", () => {
    const more = { loading: false, load: () => undefined };
    show(
      section(
        plantedSource({
          useDocuments: () =>
            ready({
              documents: [document_("a", "indexed")],
              more,
              summary: { count: 1200, state: "indexed" }
            })
        }),
        false
      )
    );
    expect(document.querySelector("[data-knowledge-tally]")?.textContent).toBe(
      "All 1,200 documents are searchable"
    );
  });

  // fix: the main action waits for the documents too, and a sync that only partly started says so.
  it("leads with Sync now where every document comes from a synced source, and with Add otherwise", async () => {
    const synced = (id: string) => ({
      id,
      connection: "ablage",
      items: { discovered: 0, fetched: 0, indexed: 1, failed: 0, withdrawn: 0 },
      failures: []
    });
    const syncSource = vi.fn<NonNullable<KnowledgeBaseSource["syncSource"]>>(async () => ({
      ok: true,
      data: {}
    }));
    const fromSource = [document_("richtlinie", "indexed", { sourceId: "ablage" })];
    const shown = (list: KnowledgeDocument[], extra: Partial<KnowledgeBaseSource> = {}) =>
      show(
        section(
          plantedSource({
            useDocuments: () => ready({ documents: list }),
            useSources: () => ready({ sources: [synced("ablage"), synced("archiv")] }),
            syncSource,
            ...extra
          })
        )
      );
    const sync = () => document.querySelector<HTMLButtonElement>("[data-knowledge-sync]");
    const add = () => document.querySelector("[data-knowledge-add]");

    shown(fromSource);
    expect(sync()).not.toBeNull();
    expect(add()).toBeNull();
    await act(async () => sync()?.click());
    expect(syncSource.mock.calls).toEqual([
      ["objektunterlagen", "ablage"],
      ["objektunterlagen", "archiv"]
    ]);
    syncSource.mockImplementation(async (_knowledgeBase, id) =>
      id === "archiv" ? { ok: false, refused: true, message: undefined } : { ok: true, data: {} }
    );
    await act(async () => sync()?.click());
    expect(document.querySelector("[data-knowledge-sync-notice]")?.textContent).toContain("1 of 2");

    shown([...fromSource, document_("notiz", "indexed")]);
    expect(add()).not.toBeNull();
    expect(sync()).not.toBeNull();
    shown(fromSource, { useSources: () => ready({ sources: [] }) });
    expect(sync()).toBeNull();
    expect(add()).not.toBeNull();
    // Until sources and documents are read neither stands there.
    shown(fromSource, { useSources: () => ({ status: "loading" }) });
    expect(sync()).toBeNull();
    expect(add()).toBeNull();
    shown(fromSource, { useDocuments: () => ({ status: "loading" }) });
    expect(sync()).toBeNull();
    expect(add()).toBeNull();
    shown(fromSource, {
      useDocuments: () => ({ status: "failed", message: undefined, retry: () => undefined })
    });
    expect(add()).not.toBeNull();
    shown(fromSource, { syncSource: undefined });
    expect(sync()).toBeNull();
    expect(add()).not.toBeNull();
  });

  it("marks a searchable document whose fields wait, and says why with the token limit", () => {
    const waiting = [
      document_("monat", "indexed", {
        fieldsPending: true,
        fieldsPendingReason: { reason: "monthly_budget" }
      }),
      document_("gross", "indexed", {
        fieldsPending: true,
        fieldsPendingReason: {
          reason: "token_budget",
          estimatedTokens: 184_250,
          reservedOutputTokens: 512,
          maxTokensPerDocument: 120_000
        }
      }),
      document_("angebot", "indexed", { fieldsPending: false }),
      document_("kaputt", "failed", { fieldsPending: true, failureCode: "knowledge_text_empty" })
    ];
    show(section(plantedSource({ useDocuments: () => ready({ documents: waiting }) })));
    expect(row("monat").hasAttribute("data-knowledge-fields-pending")).toBe(true);
    expect(row("monat").textContent).toContain("once the budget resets or is raised");
    expect(row("gross").textContent).toMatch(/184,250.*512.*120,000/u);
    expect(row("gross").textContent).not.toMatch(/token_budget|undefined/u);
    expect(row("angebot").hasAttribute("data-knowledge-fields-pending")).toBe(false);
    expect(row("kaputt").textContent).not.toContain("Fields pending");
  });

  // fix: preserve counted conversion timeout failures (#330).
  it("names the page limit or page count of a failed document where the instance sends one", () => {
    const shown = (failed: KnowledgeDocument) =>
      show(section(plantedSource({ useDocuments: () => ready({ documents: [failed] }) })));
    shown(
      document_("akte", "failed", {
        failureCode: "knowledge_file_too_many_pages",
        failurePageLimit: 12_345
      })
    );
    expect(row("akte").textContent).toContain("12,345 pages");
    shown(document_("akte", "failed", { failureCode: "knowledge_file_too_many_pages" }));
    expect(row("akte").textContent).not.toMatch(/\d+ pages|undefined/u);
    shown(
      document_("akte", "failed", {
        failureCode: "knowledge_conversion_timeout",
        failurePageCount: 6001
      })
    );
    expect(row("akte").textContent).toContain("6,001 pages");
    expect(button("Retry", row("akte"))).toBeDefined();
    shown(document_("akte", "failed", { failureCode: "knowledge_conversion_timeout" }));
    expect(row("akte").textContent).not.toMatch(/\d+ pages|undefined|\{count\}/u);
  });

  it("offers Retry on a failed document alone, retries it by its id, and says a refusal", async () => {
    const source = plantedSource();
    show(section(source));
    expect(button("Retry", row("handbuch"))).toBeUndefined();
    expect(button("Retry", row("vertrag"))).toBeUndefined();
    await act(async () => button("Retry", row("scan"))?.click());
    expect(source.retried).toHaveBeenCalledWith("objektunterlagen", ["scan"]);

    show(
      section(
        plantedSource({ retry: async () => ({ ok: false, refused: true, message: undefined }) })
      )
    );
    await act(async () => button("Retry", row("scan"))?.click());
    expect(document.body.textContent).toContain("You may not change this knowledge base.");
  });

  it("removes a document only once the remover confirms, and the row leaves", async () => {
    let shown = documents;
    const source = plantedSource({ useDocuments: () => ready({ documents: shown }) });
    source.removed.mockImplementation(async (_knowledgeBase, ids) => {
      shown = shown.filter((document) => !ids.includes(document.id));
      return { ok: true, data: { removed: ids.length } };
    });
    show(section(source));

    await act(async () => removeButton("scan")?.click());
    await act(async () => button("Cancel", required(removeDialog()))?.click());
    expect(removeDialog()).toBeNull();
    expect(source.removed).not.toHaveBeenCalled();

    await act(async () => removeButton("vertrag")?.click());
    await act(async () => button("Remove", required(removeDialog()))?.click());
    expect(source.removed).toHaveBeenCalledWith("objektunterlagen", ["vertrag"]);
    expect(removeDialog()).toBeNull();
    expect(document.querySelector('[data-knowledge-document="vertrag"]')).toBeNull();
  });

  it("keeps the confirmation open and the row where a removal did not run", async () => {
    show(
      section(
        plantedSource({ remove: async () => ({ ok: false, refused: false, message: undefined }) })
      )
    );
    await act(async () => removeButton("vertrag")?.click());
    await act(async () => button("Remove", required(removeDialog()))?.click());
    expect(removeDialog()?.textContent).toContain("could not be removed");
    expect(row("vertrag")).toBeDefined();
  });

  // fix: no Remove for synced documents (#279); a Workflow-fed one can be removed (KBW-2b).
  it("offers no Remove for a document synced from a source, but for a Workflow-fed one", () => {
    const synced = document_("preisliste", "indexed", { sourceId: "sharepoint" });
    const fed = document_("nachtimport", "indexed", { sourceId: "workflow:nightly-import" });
    show(
      section(
        plantedSource({ useDocuments: () => ready({ documents: [synced, fed, ...documents] }) })
      )
    );
    expect(removeButton("preisliste")).toBeNull();
    expect(removeButton("nachtimport")).not.toBeNull();
    expect(removeButton("vertrag")).not.toBeNull();
  });

  describe("the origin link (DS-6b)", () => {
    /** Types into a field as React hears it. */
    async function type(field: HTMLInputElement, value: string) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          field,
          value
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    const editButton = (id: string) =>
      document.querySelector<HTMLButtonElement>(`[data-knowledge-origin-edit="${id}"]`);
    const originDialog = () => {
      const dialog = document.querySelector("[data-knowledge-origin-dialog]")?.closest("dialog");
      return dialog?.open ? dialog : null;
    };
    const input = () =>
      required(document.querySelector<HTMLInputElement>("[data-knowledge-origin-input]"));
    const save = () => document.querySelector<HTMLButtonElement>("[data-knowledge-origin-save]");

    it("opens a web address without opener, and leaves out any address that is no web address", async () => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      const linked = [
        document_("vertrag", "indexed", { originLink: "https://dms.example.test/akte/7" }),
        document_("skript", "indexed", { originLink: "javascript:alert(1)" })
      ];
      show(section(plantedSource({ useDocuments: () => ready({ documents: linked }) }), false));
      const anchor = row("vertrag").querySelector<HTMLAnchorElement>(
        "a[data-knowledge-origin-link]"
      );
      expect(anchor?.getAttribute("href")).toBe("https://dms.example.test/akte/7");
      await act(async () => anchor?.click());
      expect(open).toHaveBeenCalledWith(
        "https://dms.example.test/akte/7",
        "_blank",
        "noopener,noreferrer"
      );
      expect(row("skript").querySelector("a")).toBeNull();
      // A reader who may only use the Knowledge Base cannot change it.
      expect(editButton("vertrag")).toBeNull();
      open.mockRestore();
    });

    it("lets whoever may change it set and clear the link of a file added by hand, never of a synced one", async () => {
      let shown: KnowledgeDocument[] = [
        document_("vertrag", "indexed"),
        document_("preisliste", "indexed", { sourceId: "sharepoint" }),
        document_("nachtimport", "indexed", { sourceId: "workflow:nightly-import" })
      ];
      const setOriginLink = vi.fn<NonNullable<KnowledgeBaseSource["setOriginLink"]>>(
        async (_knowledgeBase, documentId, originLink) => {
          shown = shown.map((entry) =>
            entry.id === documentId
              ? { ...entry, ...(originLink === null ? { originLink: undefined } : { originLink }) }
              : entry
          );
          return { ok: true, data: {} };
        }
      );
      const source = plantedSource({
        useDocuments: () => ready({ documents: shown }),
        setOriginLink
      });
      show(section(source));
      expect(editButton("preisliste")).toBeNull();
      expect(editButton("nachtimport")).toBeNull();

      // Refused before it is sent: no web address, or one with a password.
      await act(async () => editButton("vertrag")?.click());
      for (const refused of ["javascript:alert(1)", "https://user:pw@dms.example.test/a"]) {
        await type(input(), refused);
        await act(async () => save()?.click());
        expect(originDialog()?.querySelector('[data-tone="error"]')).not.toBeNull();
      }
      expect(setOriginLink).not.toHaveBeenCalled();

      await type(input(), "https://dms.example.test/akte/7");
      await act(async () =>
        input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      );
      expect(setOriginLink).toHaveBeenLastCalledWith(
        "objektunterlagen",
        "vertrag",
        "https://dms.example.test/akte/7"
      );
      expect(originDialog()).toBeNull();

      show(section(source));
      await act(async () => editButton("vertrag")?.click());
      await act(async () =>
        document.querySelector<HTMLButtonElement>("[data-knowledge-origin-clear]")?.click()
      );
      expect(setOriginLink).toHaveBeenLastCalledWith("objektunterlagen", "vertrag", null);

      const noSave = plantedSource();
      delete (noSave as Partial<KnowledgeBaseSource>).setOriginLink;
      show(section(noSave));
      expect(document.querySelector("[data-knowledge-origin-edit]")).toBeNull();
    });
  });

  it("shows whoever may only use it the list without Add, Retry or Remove, and refuses who may not", () => {
    show(section(plantedSource(), false));
    expect(document.querySelectorAll("[data-knowledge-document]")).toHaveLength(3);
    expect(document.querySelector("[data-knowledge-add]")).toBeNull();
    expect(button("Retry", row("scan"))).toBeUndefined();
    expect(document.querySelector("[data-knowledge-remove]")).toBeNull();

    show(section(plantedSource({ useDocuments: () => ({ status: "refused" }) }), false));
    expect(document.querySelector("[data-knowledge-document]")).toBeNull();
    expect(document.body.textContent).toContain("You may not see the documents");
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

  it("says that processing waits only while the instance says no worker takes the documents", () => {
    show(section(plantedSource({ useState: () => ready(state({ processingWaiting: true })) })));
    expect(notice()).not.toBeNull();
    for (const answer of [state({ processingWaiting: false }), state()]) {
      show(section(plantedSource({ useState: () => ready(answer) })));
      expect(notice()).toBeNull();
    }
  });

  it("watches processing with no document pending, and reads the state again while it changes", () => {
    const useState = vi.fn<KnowledgeBaseSource["useState"]>(() => ready(state()));
    show(
      section(plantedSource({ useState, useDocuments: () => ready({ documents: [] }) }), true, 3)
    );
    expect(useState).toHaveBeenLastCalledWith("objektunterlagen", 3, true);
    expect(knowledgeStateStillChanging(state(), true)).toBe(true);
    expect(knowledgeStateStillChanging(state({ processingWaiting: true }), false)).toBe(true);
    expect(knowledgeStateStillChanging(state({ status: "preparing" }), false)).toBe(true);
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
  const preparingNotice = () => document.querySelector("[data-knowledge-documents-preparing]");

  it("goes from loading to being made to listed without a reload, reading documents only once ready", () => {
    let current: KnowledgeRead<KnowledgeBaseState> = { status: "loading" };
    const useDocuments = vi.fn<KnowledgeBaseSource["useDocuments"]>((_name, enabled) =>
      enabled === true
        ? ready({ documents })
        : { status: "failed", message: sqlError, retry: () => undefined }
    );
    const shown = () =>
      createElement(KnowledgeDocuments, {
        source: plantedSource({ useState: () => current, useDocuments }),
        knowledgeBase: "richtlinien",
        publishedRevision: 1,
        canWrite: true
      });
    show(shown());
    expect(useDocuments).toHaveBeenLastCalledWith("richtlinien", false);
    expect(document.querySelector("[data-knowledge-document]")).toBeNull();
    expect(document.body.textContent).not.toContain("SQLSTATE");
    expect(button("Try again")).toBeUndefined();
    for (const status of ["preparing", "unchecked"] as const) {
      current = ready(stateOf(status));
      show(shown());
      expect(useDocuments).toHaveBeenLastCalledWith("richtlinien", false);
      expect(preparingNotice()).not.toBeNull();
      expect(document.body.textContent).not.toContain("SQLSTATE");
    }
    current = ready(stateOf("ok"));
    show(shown());
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
      section(
        plantedSource({
          useState: () => ({ status: "failed", message: sqlError, retry }),
          useDocuments
        })
      )
    );
    expect(useDocuments).toHaveBeenLastCalledWith("objektunterlagen", false);
    expect(document.body.textContent).not.toContain("SQLSTATE");
    act(() => button("Try again")?.click());
    expect(retry).toHaveBeenCalled();
  });
});

describe("the Add dialog", () => {
  function openDialog(
    source: KnowledgeBaseSource,
    formats: readonly string[] = ["txt", "markdown", "pdf", "docx"]
  ) {
    show(
      createElement(KnowledgeAddDialog, {
        source,
        knowledgeBase: "objektunterlagen",
        formats,
        onClose: () => undefined,
        onAdded: () => undefined
      })
    );
  }

  it("lets no file in a format the instance does not read, and none over its limit, be chosen", () => {
    const files = () =>
      ready({
        items: [
          file("handbuch.md"),
          file("expose.pdf"),
          file("genau.pdf", { bytes: 100 * MiB }),
          file("gross.pdf", { bytes: 100 * MiB + 1 }),
          file("lang.md", { bytes: 25 * MiB + 1 }),
          file("tabelle.xlsx")
        ]
      });
    openDialog(plantedSource({ useOpenableFiles: files }), ["txt", "markdown"]);
    expect(checkbox("handbuch.md").disabled).toBe(false);
    expect(checkbox("expose.pdf").disabled).toBe(true);

    openDialog(plantedSource({ useOpenableFiles: files }));
    expect(checkbox("expose.pdf").disabled).toBe(false);
    expect(checkbox("genau.pdf").disabled).toBe(false);
    expect(checkbox("gross.pdf").disabled).toBe(true);
    // A Markdown file is its own text, which one document holds 25 MiB of.
    expect(checkbox("lang.md").disabled).toBe(true);
    expect(checkbox("tabelle.xlsx").disabled).toBe(true);
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
    // A chosen box can still be cleared.
    expect(checkbox("notiz-0.txt").disabled).toBe(false);
    await act(async () => submit()?.click());

    expect(source.added).toHaveBeenCalledTimes(1);
    const [knowledgeBase, sent] = source.added.mock.calls[0] ?? [];
    expect(knowledgeBase).toBe("objektunterlagen");
    expect(sent?.map((each) => each.fileId)).toEqual(files.slice(0, 20).map((each) => each.fileId));
  });
});

describe("uploading from the computer in the Add dialog (ACCEPT-FIX-1, F1)", () => {
  type Upload = KnowledgeBaseSource["uploadFile"];

  function openUpload(uploadFile: Upload, formats: readonly string[], onAdded = vi.fn()) {
    const upload = vi.fn<Upload>(uploadFile);
    show(
      createElement(KnowledgeAddDialog, {
        source: plantedSource({ uploadFile: upload }),
        knowledgeBase: "handbuch",
        formats,
        onClose: () => undefined,
        onAdded
      })
    );
    return upload;
  }
  const picker = () =>
    required(
      document.querySelector<HTMLInputElement>("[data-knowledge-upload] input[data-file-picker]")
    );
  async function choose(...files: File[]) {
    const input = picker();
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  const text = (name: string) => new File(["Urlaubstage: 28"], name, { type: "text/plain" });
  const uploadState = (name: string) =>
    document
      .querySelector(`[data-knowledge-upload-file="${name}"]`)
      ?.getAttribute("data-knowledge-upload-state");
  async function settle() {
    for (let turn = 0; turn < 5; turn++) await act(async () => Promise.resolve());
  }

  it("offers PDF and DOCX only where the instance reads them", () => {
    openUpload(async () => ({ ok: true, data: { count: 1 } }), ["txt", "markdown"]);
    expect(picker().multiple).toBe(true);
    expect(picker().accept).not.toContain(".pdf");
    openUpload(async () => ({ ok: true, data: { count: 1 } }), ["txt", "markdown", "pdf", "docx"]);
    expect(picker().accept).toContain(".pdf");
    expect(picker().accept).toContain(".docx");
  });

  it("uploads each chosen file in turn and sends only a failed one again", async () => {
    const failing = new Set(["reisen.md", "support.txt"]);
    const onAdded = vi.fn<(count: number) => void>();
    const upload = openUpload(
      async (_knowledgeBase, file) => {
        if (!failing.delete(file.name)) return { ok: true, data: { count: 1 } };
        // No answer arrived for one; the instance answered the other with a failure.
        return file.name === "reisen.md"
          ? { ok: false, refused: false, message: "The connection was lost.", unanswered: true }
          : {
              ok: false,
              refused: false,
              message: "The knowledge base cannot take documents now.",
              reason: "knowledge_store_not_ready"
            };
      },
      ["txt", "markdown"],
      onAdded
    );

    await choose(text("urlaub.txt"), text("reisen.md"), text("support.txt"));
    await settle();

    expect(upload.mock.calls.map(([knowledgeBase, file]) => [knowledgeBase, file.name])).toEqual([
      ["handbuch", "urlaub.txt"],
      ["handbuch", "reisen.md"],
      ["handbuch", "support.txt"]
    ]);
    const keys = upload.mock.calls.map(([, , key]) => key);
    expect(new Set(keys).size).toBe(3);
    expect([
      uploadState("urlaub.txt"),
      uploadState("reisen.md"),
      uploadState("support.txt")
    ]).toEqual(["added", "failed", "failed"]);
    // Only the failed files can be sent again; the added one never is.
    expect(document.querySelectorAll("[data-knowledge-upload-retry]")).toHaveLength(2);

    for (const name of ["reisen.md", "support.txt"]) {
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(`[data-knowledge-upload-retry="${name}"]`)
          ?.click()
      );
      await settle();
    }

    // Without an answer the call may have run: the same key lets its run answer. A failure
    // the instance answered would only be answered again: the retry is a new call.
    expect(upload.mock.calls[3]?.[2]).toBe(keys[1]);
    expect(upload.mock.calls[4]?.[2]).not.toBe(keys[2]);
    expect([uploadState("reisen.md"), uploadState("support.txt")]).toEqual(["added", "added"]);

    act(() => document.querySelector<HTMLButtonElement>("[data-knowledge-add-close]")?.click());
    expect(onAdded).toHaveBeenCalledWith(3);
  });

  it("refuses a file in a format the instance does not read without sending it", async () => {
    const upload = openUpload(async () => ({ ok: true, data: { count: 1 } }), ["txt", "markdown"]);
    await choose(new File(["%PDF-1.7"], "expose.pdf", { type: "application/pdf" }));
    await settle();
    expect(upload).not.toHaveBeenCalled();
    expect(uploadState("expose.pdf")).toBe("failed");
    expect(document.querySelector("[data-knowledge-upload-retry]")).toBeNull();
  });
});

const chosenFile = (name: string, size = 10, type = "") => ({ name, size, type });
let counter = 0;
const newId = () => `up_${++counter}`;

describe("the upload queue of a Knowledge Base (ACCEPT-FIX-1, F1)", () => {
  it("reads text formats where the instance names none", () => {
    expect(uploadFormats(undefined)).toEqual(["txt", "markdown"]);
    expect(uploadFormats([])).toEqual(["txt", "markdown"]);
  });

  it("refuses before sending a format the instance does not read and a file over its limit", () => {
    const text = ["txt", "markdown"];
    expect(uploadableFile(chosenFile("a.md"), text)).toEqual({ uploadable: true });
    expect(uploadableFile(chosenFile("a.pdf"), text)).toMatchObject({ uploadable: false });
    expect(uploadableFile(chosenFile("a.pdf"), [...text, "pdf"])).toEqual({ uploadable: true });
    expect(uploadableFile(chosenFile("a.csv"), [...text, "pdf"])).toMatchObject({
      uploadable: false
    });
    expect(uploadableFile(chosenFile("a.txt", 25 * 1024 * 1024 + 1), text)).toEqual({
      uploadable: false,
      reason: "knowledge.addTooLarge"
    });
    // A PDF up to the instance's limit, 100 MiB unless it says; TXT and Markdown up to the
    // 25 MiB of text one document holds, however large the limit.
    const pdf = [...text, "pdf"];
    const mib = 1024 * 1024;
    expect(uploadableFile(chosenFile("a.pdf", 100 * mib), pdf)).toEqual({ uploadable: true });
    expect(uploadableFile(chosenFile("a.pdf", 100 * mib + 1), pdf)).toMatchObject({
      uploadable: false
    });
    expect(uploadableFile(chosenFile("a.pdf", 30 * mib), pdf, 20 * mib)).toMatchObject({
      uploadable: false
    });
    expect(uploadableFile(chosenFile("a.pdf", 150 * mib), pdf, 200 * mib)).toEqual({
      uploadable: true
    });
    expect(uploadableFile(chosenFile("a.md", 25 * mib + 1), pdf, 200 * mib)).toMatchObject({
      uploadable: false
    });
    expect(uploadFileMaxBytes(chosenFile("a.pdf"))).toBe(100 * mib);
    expect(uploadFileMaxBytes(chosenFile("a.md"), 200 * mib)).toBe(25 * mib);
    expect(uploadFileMaxBytes(chosenFile("a.md"), 10 * mib)).toBe(10 * mib);
  });

  it("sends one file at a time, and Retry sends again only a failed one", () => {
    let queue = queueUploads(
      [],
      [chosenFile("a.txt"), chosenFile("b.txt"), chosenFile("c.pdf")],
      ["txt"],
      newId
    );
    expect(queue.map((item) => item.state)).toEqual(["waiting", "waiting", "failed"]);

    const first = nextUpload(queue);
    expect(first?.name).toBe("a.txt");
    queue = settleUpload(queue, first?.id ?? "", { state: "uploading" });
    expect(nextUpload(queue)).toBeUndefined();
    queue = settleUpload(queue, first?.id ?? "", { state: "added" });

    const second = nextUpload(queue);
    queue = settleUpload(queue, second?.id ?? "", {
      state: "failed",
      failure: { message: "refused" }
    });
    expect(nextUpload(queue)).toBeUndefined();

    // An added file and one refused before sending stay as they are.
    const refusedId = queue[2]?.id ?? "";
    expect(retryUpload(queue, first?.id ?? "", ["txt"], newId)).toEqual(queue);
    expect(retryUpload(queue, refusedId, ["txt"], newId)).toEqual(queue);

    // The instance answered the failure: its run would answer it again, so a new key.
    queue = retryUpload(queue, second?.id ?? "", ["txt"], newId);
    const again = nextUpload(queue);
    expect(again).toMatchObject({ id: second?.id, name: "b.txt", state: "waiting" });
    expect(again?.key).not.toBe(second?.key);
    expect(queue[1]?.failure).toBeUndefined();
  });

  it("keeps the key of a call that got no answer, so its run answers instead of a second add", () => {
    let queue = queueUploads([], [chosenFile("a.txt")], ["txt"], newId);
    const sent = nextUpload(queue);
    queue = settleUpload(queue, sent?.id ?? "", {
      state: "failed",
      failure: { message: "offline" },
      unanswered: true
    });
    queue = retryUpload(queue, sent?.id ?? "", ["txt"], newId);
    expect(nextUpload(queue)).toMatchObject({ key: sent?.key, state: "waiting" });
    expect(queue[0]?.unanswered).toBeUndefined();
  });
});
