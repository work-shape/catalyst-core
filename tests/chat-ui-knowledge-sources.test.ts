import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  BuildNavigationProvider,
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
import { required } from "./support/assertions";

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

function sourceWith(
  sources: KnowledgeSources,
  connections: readonly { name: string; title: string }[],
  sourceTypes: readonly string[] | undefined
): KnowledgeBaseSource {
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
    useSourceConnections: () => ready({ items: [...connections] }),
    ...(sourceTypes === undefined
      ? {}
      : {
          useSourceTypes: () =>
            sourceTypes.map((title) => ({
              type: title.toLowerCase(),
              title,
              description: "",
              documentSource: true,
              authScheme: "none" as const,
              settings: {},
              fields: []
            }))
        }),
    useSources: () => ready(sources),
    syncSource: async () => ({ ok: true, data: {} }),
    retrySource: async () => ({ ok: true, data: { queued: 2 } }),
    confirmSource: async () => ({ ok: true, data: {} })
  };
}

function render(
  locale: "en" | "de",
  {
    canWrite = true,
    unpublished = false,
    sources = [handbookSource],
    status = { sources: [running] },
    connections = [{ name: "handbook-folders", title: "Handbook folders" }],
    sourceTypes,
    inBuild = false,
    workflows,
    canPublish
  }: {
    canWrite?: boolean;
    /** No revision is published yet. */
    unpublished?: boolean;
    sources?: KnowledgeSourceForm[];
    status?: KnowledgeSources;
    /** The Connections the reader may choose for a source. */
    connections?: readonly { name: string; title: string }[];
    /** The titles of the Connector types the instance can sync documents from. */
    sourceTypes?: readonly string[];
    /** The section sits in Studio, which can open the New connection dialog. */
    inBuild?: boolean;
    /** The Workflows that fill the Knowledge Base, as its state names them. */
    workflows?: readonly { id: string; name: string; title: string }[];
    /** The reader may publish the Knowledge Base. */
    canPublish?: boolean;
  } = {}
): string {
  const section = createElement(KnowledgeSourcesSection, {
    source: sourceWith(status, connections, sourceTypes),
    knowledgeBase: "handbook-kb",
    published: unpublished ? undefined : 2,
    owner: undefined,
    sources,
    canWrite,
    ...(workflows ? { workflows } : {}),
    ...(canPublish === undefined ? {} : { canPublish }),
    onChange: () => undefined
  });
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      inBuild
        ? createElement(BuildNavigationProvider, {
            value: {
              location: { kindPath: "knowledge-bases", name: "handbook-kb" },
              open: () => undefined,
              href: (place) => `/build/${place.kindPath ?? ""}`
            },
            children: section
          })
        : section
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

  it("where no Connection can sync folders, says in one neutral line what to connect first", () => {
    const page = render("de", {
      sources: [],
      connections: [],
      sourceTypes: ["Box", "SharePoint"],
      inBuild: true
    });
    expect(page).toContain(
      "Um Ordner aus Box oder SharePoint zu synchronisieren, lege zuerst eine Verbindung an."
    );
    expect(page).toMatch(
      /<a[^>]*href="\/build\/connections"[^>]*data-knowledge-source-connect=""/u
    );
    expect(page).toContain("Neue Verbindung");
    // No empty list, no chooser, no error and no note on the draft beside it.
    expect(page).not.toContain("Noch keine Quelle.");
    expect(page).not.toContain("Quelle hinzufügen");
    expect(page).not.toContain("Lege zuerst unter Verbindungen");
    expect(page).not.toContain("sobald der Entwurf veröffentlicht ist");
    const none = render("en", { sources: [], connections: [], sourceTypes: [], inBuild: true });
    expect(none).toContain("This instance connects no document source yet.");
    expect(none).not.toContain("data-knowledge-source-connect");
    // A reader who may not create Connections is told no type and offered no dialog.
    const unknown = render("en", { sources: [], connections: [] });
    expect(unknown).toContain("No connection here syncs folders yet.");
    expect(unknown).not.toContain("data-knowledge-source-connect");
    // With a Connection to choose, the chooser stands as before.
    expect(render("en", { sources: [], sourceTypes: ["Box"] })).toContain("Add source");
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

describe("a source a Workflow fills (KBW-1)", () => {
  const hour = 60 * 60 * 1000;
  const fed = (endedAt: string) =>
    ({
      id: "workflow:nightly-import",
      kind: "workflow",
      workflowId: "nightly-import",
      items: { discovered: 0, fetched: 0, indexed: 198, failed: 2, withdrawn: 10 },
      failures: [{ code: "knowledge_extraction_failed", count: 2 }],
      last: {
        syncRunId: "kbsync_1",
        source: "workflow:nightly-import",
        mode: "ingest",
        state: "done",
        counts: {
          discovered: 200,
          added: 198,
          changed: 0,
          moved: 0,
          withdrawn: 10,
          failed: 2,
          skipped: 0
        },
        bytesFetched: 0,
        startedAt: endedAt,
        endedAt
      }
    }) satisfies KnowledgeSourceStatus;

  it.each([
    [
      "de",
      "Nachtimport",
      "Stand: letzter Lauf vor 2 Std.",
      "Letzter Lauf",
      "bestimmen die Läufe des Workflows"
    ],
    [
      "en",
      "Nachtimport",
      "As of the last run 2 hr ago",
      "Last run",
      "decide what this source holds"
    ]
  ] as const)(
    "names the Workflow, its last run and how fresh it is in %s, with no Sync now or Try again",
    (locale, title, freshness, lastRun, note) => {
      const html = render(locale, {
        sources: [],
        status: { sources: [fed(new Date(Date.now() - 2 * hour - 60_000).toISOString())] },
        workflows: [{ id: "wf_1", name: "nightly-import", title }]
      });
      expect(html).toContain('data-knowledge-source-kind="workflow"');
      expect(html).toContain(title);
      expect(html).toContain(freshness);
      expect(html).toContain(lastRun);
      expect(html).toContain(note);
      expect(html).not.toContain("data-knowledge-source-sync");
      expect(html).not.toContain("knowledgeSources.");
      expect(html).not.toContain(locale === "de" ? "Erneut versuchen" : "Try again");
      // A Workflow-fed source alone is no empty list of synced sources.
      expect(html).not.toContain(locale === "de" ? "Noch keine Quelle." : "No source yet.");
    }
  );

  it.each([
    ["de", "Von Hand entfernt. Der Workflow bringt es nicht zurück.", "Wieder zulassen"],
    ["en", "Removed by hand. The workflow does not bring it back.", "Allow again"]
  ] as const)(
    "offers Allow again on documents removed by hand only to who may publish, in %s (KBW-2b)",
    (locale, reason, allow) => {
      const held = {
        ...fed(new Date().toISOString()),
        failures: [{ code: "knowledge_item_removed", count: 3 }]
      } satisfies KnowledgeSourceStatus;
      const publisher = render(locale, {
        sources: [],
        status: { sources: [held] },
        canPublish: true
      });
      expect(publisher).toContain(reason);
      expect(publisher).toContain("data-knowledge-source-release");
      expect(publisher).toContain(allow);
      const writer = render(locale, { sources: [], status: { sources: [held] } });
      expect(writer).toContain(reason);
      expect(writer).not.toContain("data-knowledge-source-release");
    }
  );

  it("names the Workflow by its id where the reader may not read it", () => {
    const html = render("en", {
      sources: [],
      status: { sources: [fed(new Date().toISOString())] }
    });
    expect(html).toContain("nightly-import");
  });

  it("shows a pass that runs as taking documents in, and one its run cut short as ended early", () => {
    expect(
      sourceStateView({
        running: { syncRunId: "s", mode: "ingest", startedAt: "2026-10-24T08:00:00.000Z" }
      })
    ).toMatchObject({ label: "knowledgeSources.stateIngesting" });
    expect(
      sourceStateView({
        last: {
          ...fed("2026-10-24T08:00:00.000Z").last,
          state: "failed",
          failureCode: "knowledge_ingest_cancelled"
        }
      })
    ).toMatchObject({ state: "failed", label: "knowledgeSources.stateRunEnded" });
  });
});

describe("a first import that waits for a confirmation (KB-ISO-1b)", () => {
  const waiting: KnowledgeSourceStatus = {
    ...running,
    running: { syncRunId: "sync_1", mode: "initial", startedAt: "2026-10-21T08:00:00.000Z" },
    confirmation: {
      syncRunId: "sync_1",
      items: 12_000,
      bytes: 318_000_000_000,
      stop: 10_000,
      tokens: { min: 63_600_000, max: 95_400_000 },
      passages: { min: 124_219, max: 186_329 },
      model: "text-embedding-3-small",
      cost: { min: 250, max: 380, currency: "EUR" },
      room: true,
      storeBytes: 1_000_000,
      addedBytes: 1_200_000_000
    }
  };

  it("is its own state, ahead of the running import", () => {
    expect(sourceStateView(waiting)).toMatchObject({
      state: "waiting",
      label: "knowledgeSources.stateWaiting"
    });
  });

  it("states count, size and cost in German, with the button for who may publish", () => {
    const html = render("de", { status: { sources: [waiting] }, canPublish: true });
    expect(html).toContain("Wartet auf Bestätigung");
    expect(html).toMatch(/12\.000 Dateien, 318\sGB, geschätzte Kosten der Einbettung/u);
    expect(html).toMatch(/250,00\s€ bis 380,00\s€/u);
    expect(html).toContain("Die ersten 10.000 werden eingelesen.");
    expect(html).toContain('data-knowledge-source-confirm=""');
    expect(html).toContain("Import fortsetzen");
  });

  it("shows a reader who may not publish the same, without the button", () => {
    for (const canPublish of [false, undefined]) {
      const html = render("en", {
        status: { sources: [waiting] },
        ...(canPublish === undefined ? {} : { canPublish })
      });
      expect(html).toContain("Waiting for confirmation");
      expect(html).toMatch(/12,000 files, 318\sGB, estimated embedding cost/u);
      expect(html).toContain("data-knowledge-source-confirmation");
      expect(html).not.toContain('data-knowledge-source-confirm=""');
    }
  });

  it("says where the model has no price, and where the store may run out of room", () => {
    const { cost: _cost, ...unpriced } = required(waiting.confirmation);
    const html = render("en", {
      status: {
        sources: [
          {
            ...waiting,
            confirmation: { ...unpriced, room: false, limitBytes: 1_000_000_000 }
          }
        ]
      }
    });
    expect(html).toContain("The embedding model has no price");
    expect(html).toContain("The store may not have room");
  });

  it("states only count and size where nothing is embedded (KB-ISO-1b review)", () => {
    const { syncRunId, items, bytes, stop, storeBytes } = required(waiting.confirmation);
    for (const locale of ["en", "de"] as const) {
      const html = render(locale, {
        status: {
          sources: [
            {
              ...waiting,
              confirmation: { syncRunId, items, bytes, stop, storeBytes, limitBytes: 1_000 }
            }
          ]
        }
      });
      expect(html).toContain(
        locale === "en" ? "does not search by meaning" : "sucht nicht nach Bedeutung"
      );
      expect(html).not.toMatch(/Passages \(estimated\)|Passagen \(geschätzt\)/u);
      expect(html).not.toMatch(/Tokens \((estimated|geschätzt)\)/u);
      expect(html).not.toMatch(/may not have room|womöglich keinen Platz/u);
    }
  });

  it("shows a source that never stopped without the confirmation", () => {
    const html = render("en", { canPublish: true });
    expect(html).not.toContain("data-knowledge-source-confirmation");
  });
});
