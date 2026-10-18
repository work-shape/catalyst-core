// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranslationProvider } from "@work-shape/catalyst-chat-ui";
import {
  KnowledgeAddDialog,
  type KnowledgeBaseSource,
  type KnowledgeRead
} from "@work-shape/catalyst-chat-ui/build-area";
import { UiRoot, uiLabelsDe, uiLabelsEn } from "@work-shape/catalyst-ui";

// Uploading files from the person's device in the Add dialog of a Knowledge Base (ACCEPT-FIX-1,
// F1): text files always, PDF and DOCX only where the instance reads them, one call per file,
// and Retry sends only a failed file again, under its first idempotency key.

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
const TEXT = ["txt", "markdown"];
const ALL = ["txt", "markdown", "pdf", "docx"];

type Upload = KnowledgeBaseSource["uploadFile"];

function plantedSource(uploadFile: Upload) {
  const unused = async () => ({ ok: false as const, refused: false, message: undefined });
  const upload = vi.fn<Upload>(uploadFile);
  const source: KnowledgeBaseSource = {
    useState: () => ({ status: "loading" }),
    check: unused,
    query: unused,
    search: unused,
    useDataStores: () => ready({ items: [] }),
    useStoreTables: () => ready([]),
    useKnowledgeBases: () => ready({ items: [] }),
    useDocuments: () => ready({ documents: [] }),
    useOpenableFiles: () => ready({ items: [] }),
    retry: unused,
    remove: unused,
    addFiles: unused,
    uploadFile: upload
  };
  return { source, upload };
}

function openDialog(
  source: KnowledgeBaseSource,
  formats: readonly string[],
  locale: "en" | "de" = "en",
  onAdded: (count: number) => void = () => undefined
) {
  act(() =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: locale === "de" ? uiLabelsDe : uiLabelsEn },
        createElement(
          TranslationProvider,
          { locale, children: null },
          createElement(KnowledgeAddDialog, {
            source,
            knowledgeBase: "handbuch",
            formats,
            onClose: () => undefined,
            onAdded
          })
        )
      )
    )
  );
}

function picker(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    "[data-knowledge-upload] input[data-file-picker]"
  );
  if (!input) throw new Error("no upload picker");
  return input;
}

/** Chooses files in the system dialog, as the browser reports it. */
async function choose(...files: File[]) {
  const input = picker();
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const text = (name: string, type = "text/plain") => new File(["Urlaubstage: 28"], name, { type });

function state(name: string): string | null | undefined {
  return document
    .querySelector(`[data-knowledge-upload-file="${name}"]`)
    ?.getAttribute("data-knowledge-upload-state");
}

/** Lets every pending answer settle. */
async function settle() {
  for (let turn = 0; turn < 5; turn++) await act(async () => Promise.resolve());
}

describe("uploading from the computer in the Add dialog", () => {
  it("offers TXT and Markdown, and PDF and DOCX only where the instance reads them", () => {
    const { source } = plantedSource(async () => ({ ok: true, data: { count: 1 } }));
    openDialog(source, TEXT);
    expect(picker().multiple).toBe(true);
    expect(picker().accept.split(",")).toEqual([
      ".txt",
      "text/plain",
      ".md",
      ".markdown",
      "text/markdown"
    ]);
    expect(document.body.textContent).toContain("Upload from your computer");
    expect(document.body.textContent).toContain("TXT and Markdown, each up to 25 MiB.");

    openDialog(source, ALL, "de");
    expect(picker().accept).toContain(".pdf");
    expect(picker().accept).toContain(".docx");
    expect(document.body.textContent).toContain("Von deinem Computer hochladen");
    expect(document.body.textContent).toContain(
      "TXT, Markdown, PDF und DOCX, jede Datei bis 25 MiB."
    );
  });

  it("uploads each chosen file in turn and sends only a failed one again", async () => {
    const failing = new Set(["reisen.md", "support.txt"]);
    const { source, upload } = plantedSource(async (_knowledgeBase, file) => {
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
    });
    const onAdded = vi.fn<(count: number) => void>();
    openDialog(source, TEXT, "en", onAdded);

    await choose(text("urlaub.txt"), text("reisen.md", "text/markdown"), text("support.txt"));
    await settle();

    expect(upload.mock.calls.map(([knowledgeBase, file]) => [knowledgeBase, file.name])).toEqual([
      ["handbuch", "urlaub.txt"],
      ["handbuch", "reisen.md"],
      ["handbuch", "support.txt"]
    ]);
    const keys = upload.mock.calls.map(([, , key]) => key);
    expect(new Set(keys).size).toBe(3);
    expect([state("urlaub.txt"), state("reisen.md"), state("support.txt")]).toEqual([
      "added",
      "failed",
      "failed"
    ]);
    expect(
      document.querySelector('[data-knowledge-upload-file="reisen.md"]')?.textContent
    ).toContain("The connection was lost.");
    expect(
      document.querySelector('[data-knowledge-upload-file="support.txt"]')?.textContent
    ).toContain("The knowledge base cannot take documents right now. Check its status.");
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

    expect(upload.mock.calls.slice(3).map(([, file]) => file.name)).toEqual([
      "reisen.md",
      "support.txt"
    ]);
    // Without an answer the call may have run: the same key lets its run answer. A failure
    // the instance answered would only be answered again: the retry is a new call.
    expect(upload.mock.calls[3]?.[2]).toBe(keys[1]);
    expect(upload.mock.calls[4]?.[2]).not.toBe(keys[2]);
    expect([state("reisen.md"), state("support.txt")]).toEqual(["added", "added"]);

    // Closed, the dialog reports the three files the Knowledge Base took.
    const close = document.querySelector<HTMLButtonElement>("[data-knowledge-add-close]");
    expect(close?.textContent).toBe("Close");
    act(() => close?.click());
    expect(onAdded).toHaveBeenCalledWith(3);
  });

  it("refuses a file in a format the instance does not read without sending it", async () => {
    const { source, upload } = plantedSource(async () => ({ ok: true, data: { count: 1 } }));
    openDialog(source, TEXT);

    await choose(new File(["%PDF-1.7"], "expose.pdf", { type: "application/pdf" }));
    await settle();

    expect(upload).not.toHaveBeenCalled();
    expect(state("expose.pdf")).toBe("failed");
    expect(document.querySelector("[data-knowledge-upload-retry]")).toBeNull();
    expect(document.body.textContent).toContain("Knowledge bases here do not read this format.");
  });

  it("says that an upload cannot wait for an approval", async () => {
    const { source } = plantedSource(async () => ({
      ok: false,
      refused: false,
      message: "The instance's policy asks for another person's approval.",
      reason: "approval_unavailable"
    }));
    openDialog(source, TEXT, "de");

    await choose(text("urlaub.txt"));
    await settle();

    expect(state("urlaub.txt")).toBe("failed");
    expect(document.body.textContent).toContain(
      "ein Upload kann nicht darauf warten. Frag eine Administratorin oder einen Administrator."
    );
  });
});
