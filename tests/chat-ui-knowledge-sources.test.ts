import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  KnowledgeSourcesSection,
  PublishQuestionLines,
  knowledgeBaseConfigToForm,
  knowledgeBaseFormToConfig,
  knowledgeSourcesToConfig,
  newKnowledgeSource,
  newSourceId,
  publishQuestionHolds,
  sourceStateView,
  type KnowledgeBaseSource,
  type KnowledgeRead,
  type KnowledgeSourceForm,
  type KnowledgeSourceStatus,
  type KnowledgeSources,
  type PublishQuestionRead
} from "@work-shape/catalyst-chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The synced sources on the page of a Knowledge Base of documents (SRC-2): the list the draft
// holds, written back with what the page does not show, the state of each published source in
// English and German, and the buttons only who may change it gets.

const ready = <Answer>(data: Answer): KnowledgeRead<Answer> => ({ status: "ready", data });

const handbookSource: KnowledgeSourceForm = {
  id: "handbook-folders",
  connection: "handbook-folders",
  folders: "100",
  include: "",
  exclude: ""
};

const initialSync = {
  syncRunId: "sync_1",
  mode: "initial",
  startedAt: "2026-10-21T08:00:00.000Z",
  itemsPerMinute: 12,
  estimatedEndAt: "2026-10-21T09:30:00.000Z"
} satisfies KnowledgeSourceStatus["running"];

const running: KnowledgeSourceStatus = {
  id: "handbook-folders",
  connection: "handbook-folders",
  items: { discovered: 3, fetched: 1, indexed: 40, failed: 2, withdrawn: 5 },
  failures: [{ code: "knowledge_fetch_failed", count: 2 }],
  running: initialSync,
  lastChangeAt: "2026-10-21T08:10:00.000Z",
  oldestOpenChangeAt: "2026-10-21T08:05:00.000Z"
};

function sourceWith(sources: KnowledgeSources): KnowledgeBaseSource {
  const failed = { ok: false as const, refused: false, message: undefined };
  return {
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
      ready({ items: [{ name: "handbook-folders", title: "Handbook folders" }] }),
    useSources: () => ready(sources),
    syncSource: async () => ({ ok: true, data: {} }),
    retrySource: async () => ({ ok: true, data: { queued: 2 } })
  };
}

function render(
  locale: "en" | "de",
  {
    canWrite = true,
    unpublished = false,
    sources = [handbookSource],
    status = { sources: [running] }
  }: {
    canWrite?: boolean;
    /** No revision is published yet. */
    unpublished?: boolean;
    sources?: KnowledgeSourceForm[];
    status?: KnowledgeSources;
  } = {}
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(KnowledgeSourcesSection, {
        source: sourceWith(status),
        knowledgeBase: "handbook-kb",
        published: unpublished ? undefined : 2,
        owner: undefined,
        sources,
        canWrite,
        onChange: () => undefined
      })
    )
  );
}

describe("the synced sources of a Knowledge Base's definition", () => {
  const stored = {
    name: "handbook-kb",
    title: "Handbook",
    description: "The staff handbook.",
    methods: ["keyword"],
    sources: [
      {
        id: "handbook-folders",
        connection: "handbook-folders",
        folders: ["100", "101"],
        include: ["*.pdf", "*.{md,txt}"]
      }
    ],
    documentTypes: [{ id: "policy", label: "Policy" }],
    extraction: { maxPagesPerDocument: 200 }
  };

  it("writes a definition back as it was read, with what the page does not show", () => {
    expect(knowledgeBaseFormToConfig(knowledgeBaseConfigToForm(stored))).toEqual(stored);
  });

  it("writes a changed source and leaves the rest of the definition as it was", () => {
    const form = knowledgeBaseConfigToForm(stored);
    const [first] = form.sources;
    if (!first) throw new Error("The form has no source");
    const written = knowledgeBaseFormToConfig({
      ...form,
      sources: [{ ...first, folders: " 100 ,\n200\n100\n", include: "\n" }]
    });
    expect(written).toEqual({
      ...stored,
      sources: [{ id: "handbook-folders", connection: "handbook-folders", folders: ["100", "200"] }]
    });
  });

  it("writes no sources where the draft has none left", () => {
    const form = knowledgeBaseConfigToForm(stored);
    const { sources: _sources, ...rest } = stored;
    expect(knowledgeBaseFormToConfig({ ...form, sources: [] })).toEqual(rest);
  });

  it("names a new source after its Connection, once, in the form a source id takes", () => {
    expect(newSourceId("Box_Handbuch", [])).toBe("box-handbuch");
    expect(newSourceId("box-handbuch", ["box-handbuch", "box-handbuch-2"])).toBe("box-handbuch-3");
    expect(newSourceId("2026-ablage", [])).toBe("source-2026-ablage");
    const long = newSourceId("a".repeat(80), ["a".repeat(60)]);
    expect(long).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
    expect(long.length).toBeLessThanOrEqual(63);
    expect(newKnowledgeSource("handbook-folders", [handbookSource]).id).toBe("handbook-folders-2");
    expect(knowledgeSourcesToConfig([newKnowledgeSource("x", [])])).toEqual([
      { id: "x", connection: "x", folders: [] }
    ]);
  });
});

describe("the state of a synced source", () => {
  it("is the running sync's, else how the last one ended", () => {
    expect(sourceStateView(running).state).toBe("initial");
    expect(sourceStateView({ running: { ...initialSync, mode: "changes" } }).state).toBe("syncing");
    expect(sourceStateView({}).state).toBe("never");
    const last = {
      syncRunId: "sync_0",
      source: "handbook-folders",
      mode: "changes" as const,
      counts: {
        discovered: 0,
        added: 0,
        changed: 0,
        moved: 0,
        withdrawn: 0,
        failed: 0,
        skipped: 0
      },
      bytesFetched: 0,
      startedAt: "2026-10-21T07:00:00.000Z"
    };
    expect(sourceStateView({ last: { ...last, state: "done" } }).state).toBe("current");
    expect(
      sourceStateView({
        last: { ...last, state: "failed", failureCode: "knowledge_source_unreachable" }
      }).state
    ).toBe("unreachable");
    expect(
      sourceStateView({
        last: { ...last, state: "failed", failureCode: "knowledge_source_refused" }
      }).state
    ).toBe("refused");
  });

  it("shows the initial import with its counts, its estimated end and its failures, in German", () => {
    const page = render("de");
    expect(page).toContain("Erstimport läuft");
    // Found leaves out what was withdrawn.
    expect(page).toContain("46 gefunden");
    expect(page).toContain("40 durchsuchbar");
    expect(page).toContain("2 fehlgeschlagen");
    expect(page).toContain("Voraussichtlich fertig");
    expect(page).toContain("Letzte Änderung verarbeitet");
    expect(page).toContain("Älteste offene Änderung");
    expect(page).toContain("Das Laden ist auch nach mehreren Versuchen fehlgeschlagen.");
    expect(page).toContain("Erneut versuchen");
    expect(page).toContain("Jetzt synchronisieren");
    expect(page).toContain("Quelle hinzufügen");
  });

  it("shows the same in English", () => {
    const page = render("en");
    expect(page).toContain("Initial import running");
    expect(page).toContain("46 found");
    expect(page).toContain("Fetching failed, even after several tries.");
    expect(page).toContain("Try again");
    expect(page).toContain("Sync now");
  });

  it("gives a reader who may not change it no button and no field to type in", () => {
    const page = render("de", { canWrite: false });
    expect(page).toContain("Erstimport läuft");
    expect(page).not.toContain("Erneut versuchen");
    expect(page).not.toContain("Jetzt synchronisieren");
    expect(page).not.toContain("Quelle hinzufügen");
    expect(page).not.toContain("data-knowledge-source-remove");
    expect(page).toMatch(/<textarea[^>]*readOnly=""[^>]*data-knowledge-source-field="folders"/u);
  });

  it("says a source the draft adds syncs once it is published", () => {
    const added = newKnowledgeSource("handbook-folders", [handbookSource]);
    const page = render("en", { sources: [handbookSource, added] });
    expect(page).toContain("It syncs once it is published.");
    expect(render("en", { unpublished: true })).not.toContain("Initial import running");
  });
});

describe("the question before a publish", () => {
  const lines = (question: PublishQuestionRead, locale: "en" | "de" = "en") =>
    renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(PublishQuestionLines, { question, onRetry: () => undefined })
      )
    );

  it("lists the lines the instance answered, and holds the publish while it reads or failed", () => {
    const line =
      "3 Personen mit Zugriff auf „Handbuch“ finden alles im Ordner 100, gelesen mit dem gemeinsamen Konto Box. Die eigenen Rechte dieser Personen in der Quelle gelten hier nicht.";
    expect(lines({ status: "ready", lines: [line] }, "de")).toContain(line);
    expect(lines({ status: "failed" }, "de")).toContain("Erneut lesen");
    expect(publishQuestionHolds({ status: "loading" })).toBe(true);
    expect(publishQuestionHolds({ status: "failed" })).toBe(true);
    expect(publishQuestionHolds({ status: "ready", lines: [] })).toBe(false);
    expect(publishQuestionHolds({ status: "none" })).toBe(false);
  });
});
