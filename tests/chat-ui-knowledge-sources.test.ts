import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BuildNavigationProvider,
  KnowledgeSourceChoice,
  KnowledgeSourceFolderPicker,
  KnowledgeSourcesSection,
  PublishQuestionLines,
  knowledgeBaseConfigToForm,
  knowledgeBaseFormToConfig,
  knowledgeSourcesToConfig,
  newKnowledgeSource,
  newSourceId,
  publishQuestionHolds,
  sourceDraftChange,
  sourceNextSyncAt,
  sourcesReadAgainIn,
  sourceStateView,
  syncsByItself,
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

/** What a source's folders read answers: the folder at `/Objekte/<id>`, holding two folders. */
function foldersOf(_connection: string, parent: string | undefined) {
  return ready({
    folder:
      parent === undefined
        ? { id: "0", name: "All files", path: "/" }
        : { id: parent, name: `Folder ${parent}`, path: `/Objekte/${parent}` },
    folders: [
      { id: "201", name: "Verträge" },
      { id: "202", name: "Grundrisse" }
    ]
  });
}

function sourceWith(
  sources: KnowledgeSources,
  connections: readonly {
    name: string;
    title: string;
    connectorType?: string;
    browsesFolders?: true;
    sourceFull?: string;
    sourceMinChanges?: number;
  }[],
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
    useSourceFolders: foldersOf,
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
              fields: [],
              operations: [],
              exposures: ["agent" as const]
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
    canPublish,
    live,
    publish
  }: {
    canWrite?: boolean;
    /** No revision is published yet. */
    unpublished?: boolean;
    sources?: KnowledgeSourceForm[];
    status?: KnowledgeSources;
    /** The Connections the reader may choose for a source. */
    connections?: readonly {
      name: string;
      title: string;
      connectorType?: string;
      browsesFolders?: true;
      sourceFull?: string;
      sourceMinChanges?: number;
    }[];
    /** The titles of the Connector types the instance can sync documents from. */
    sourceTypes?: readonly string[];
    /** The section sits in Studio, which can open the New connection dialog. */
    inBuild?: boolean;
    /** The Workflows that fill the Knowledge Base, as its state names them. */
    workflows?: readonly { id: string; name: string; title: string }[];
    /** The reader may publish the Knowledge Base. */
    canPublish?: boolean;
    /** The sources as the published revision names them. */
    live?: readonly KnowledgeSourceForm[];
    /** The page's publish of the saved draft. */
    publish?: { open(): void; unsaved: boolean };
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
    ...(live === undefined ? {} : { live }),
    ...(publish === undefined ? {} : { publish }),
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

  it("keeps the schedule of a source through a save", () => {
    const source = {
      id: "objekte",
      connection: "box",
      folders: ["1"],
      schedule: { full: "0 3 * * 1" }
    };
    const config = { ...stored, sources: [source] };
    expect(knowledgeBaseFormToConfig(knowledgeBaseConfigToForm(config))).toEqual(config);
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

  it("stays folded over failed items and counts them in its row; only a confirmation unfolds it", () => {
    const adjust = (page: string) =>
      /<button[^>]*data-knowledge-source-adjust=""[^>]*>/u.exec(page)?.[0] ??
      /<button[^>]*aria-expanded="[^"]*"[^>]*data-knowledge-source-adjust/u.exec(page)?.[0];
    const failing = render("de");
    expect(adjust(failing)).toContain('aria-expanded="false"');
    expect(failing).toMatch(/data-knowledge-source-failed="">.*?2 fehlgeschlagen/su);
    const calm = render("de", {
      status: { sources: [{ ...running, items: { ...running.items, failed: 0 }, failures: [] }] }
    });
    expect(calm).not.toContain("data-knowledge-source-failed");
    const waiting = render("de", {
      status: {
        sources: [
          {
            ...running,
            failures: [],
            confirmation: {
              syncRunId: "sync_1",
              items: 12_000,
              bytes: 1_000,
              stop: 10_000,
              storeBytes: 1_000
            }
          }
        ]
      }
    });
    expect(adjust(waiting)).toContain('aria-expanded="true"');
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
    expect(none).toContain("No document source is connected yet.");
    expect(none).not.toContain("data-knowledge-source-connect");
    // A reader who may not create Connections is told no type and offered no dialog.
    const unknown = render("en", { sources: [], connections: [] });
    expect(unknown).toContain("No connection here syncs folders yet.");
    expect(unknown).not.toContain("data-knowledge-source-connect");
    // With a Connection to choose, the chooser stands as before.
    expect(render("en", { sources: [], sourceTypes: ["Box"] })).toContain("Add source");
  });
});

describe("what a published source does right now, in the line of its card", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const at = (time: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(time));
  };
  const line = (page: string) =>
    /data-knowledge-source-live="(?<state>[^"]*)"[^>]*>(?<text>.*?)<\/p>/su.exec(page)?.groups;
  const lastSync = {
    syncRunId: "sync_0",
    source: "handbook-folders",
    mode: "changes" as const,
    state: "done" as const,
    counts: { discovered: 0, added: 0, changed: 0, moved: 0, withdrawn: 0, failed: 0, skipped: 0 },
    bytesFetched: 0,
    startedAt: "2026-10-21T08:00:00.000Z",
    endedAt: "2026-10-21T08:00:20.000Z"
  };
  const every15 = { changes: 15, full: "0 2 * * *", defaultChanges: 15, defaultFull: "0 2 * * *" };
  const idle: KnowledgeSourceStatus = {
    id: "handbook-folders",
    connection: "handbook-folders",
    items: { discovered: 0, fetched: 0, indexed: 46, failed: 0, withdrawn: 0 },
    failures: [],
    last: lastSync,
    schedule: every15
  };

  it("names the sync that runs with how many of its items are through, and no badge beside it", () => {
    const page = render("de", {
      status: { sources: [{ ...running, running: { ...initialSync, mode: "changes" } }] }
    });
    expect(line(page)?.state).toBe("running");
    // Searchable and failed of the items it found: 40 + 2 of 46.
    expect(line(page)?.text).toContain("Synchronisiert gerade … (42 von 46)");
    expect(page.split("Synchronisiert gerade").length - 1).toBe(2);
    expect(line(render("en"))?.text).toContain("Initial import running … (42 of 46)");
    const listing = {
      ...running,
      items: { ...running.items, discovered: 0, fetched: 0, indexed: 0, failed: 0 }
    };
    expect(line(render("de", { status: { sources: [listing] } }))?.text).toContain(
      "Erstimport läuft …<"
    );
    // A changes sync of a source that is through gives no count: it would read "46 of 46".
    const through = { ...idle, running: { ...initialSync, mode: "changes" as const } };
    expect(line(render("de", { status: { sources: [through] } }))?.text).toContain(
      "Synchronisiert gerade …<"
    );
  });

  it("says when it last synced and when it syncs next, one interval after the last start", () => {
    at("2026-10-21T08:05:00.000Z");
    const page = render("de", { status: { sources: [idle] } });
    expect(line(page)?.state).toBe("idle");
    expect(line(page)?.text).toContain(
      "Zuletzt synchronisiert vor 4 Min., nächster Abgleich in 10 Min."
    );
    expect(line(render("en", { status: { sources: [idle] } }))?.text).toContain(
      "Last synced 4 min ago, next sync in 10 min."
    );
    expect(sourceNextSyncAt(idle)?.toISOString()).toBe("2026-10-21T08:15:00.000Z");
  });

  it("says the next sync is due once its time has come, and names a last sync that failed", () => {
    at("2026-10-21T08:14:30.000Z");
    expect(line(render("de", { status: { sources: [idle] } }))?.text).toContain(
      "nächster Abgleich steht an."
    );
    const failed = {
      ...idle,
      last: {
        ...lastSync,
        state: "failed" as const,
        failureCode: "knowledge_source_unreachable" as const
      }
    };
    expect(line(render("de", { status: { sources: [failed] } }))?.text).toContain(
      "Letzter Versuch fehlgeschlagen vor 14 Min., nächster Abgleich steht an."
    );
  });

  it("names the full sync where it fetches no changes by itself, and only the last where it syncs by hand", () => {
    at("2026-10-21T08:05:00.000Z");
    const fullOnly = { ...idle, schedule: { ...every15, changes: "off" as const } };
    expect(sourceNextSyncAt(fullOnly)).toBeUndefined();
    expect(line(render("en", { status: { sources: [fullOnly] } }))?.text).toMatch(
      /Last synced 4 min ago, next sync [a-z].*02:00|2:00/u
    );
    const off = { ...idle, schedule: { ...every15, changes: "off" as const, full: "off" } };
    expect(line(render("de", { status: { sources: [off] } }))?.text).toContain(
      "Zuletzt synchronisiert vor 4 Min.<"
    );
  });

  it("says nothing where the badge says it all: never synced, or waiting for a person", () => {
    const { last: _last, ...never } = idle;
    expect(line(render("de", { status: { sources: [never] } }))).toBeUndefined();
    const waiting = {
      ...running,
      confirmation: {
        syncRunId: "sync_1",
        items: 12_000,
        bytes: 1_000,
        stop: 10_000,
        storeBytes: 1
      }
    };
    const page = render("de", { status: { sources: [waiting] } });
    expect(line(page)).toBeUndefined();
    expect(page).toContain("Wartet auf Bestätigung");
  });

  it("is read once more shortly after the next sync is expected, and not again once that has passed", () => {
    const before = new Date("2026-10-21T08:05:00.000Z");
    // 10 minutes to the next sync, and a margin for the instance to start it.
    expect(sourcesReadAgainIn({ sources: [idle] }, before)).toBe(10 * 60_000 + 75_000);
    expect(
      sourcesReadAgainIn({ sources: [idle] }, new Date("2026-10-21T08:15:10.000Z"))
    ).toBeUndefined();
    expect(sourcesReadAgainIn({ sources: [running] }, before)).toBeUndefined();
    const off = { ...idle, schedule: { ...every15, changes: "off" as const } };
    expect(sourcesReadAgainIn({ sources: [off] }, before)).toBeUndefined();
  });
});

describe("a source the draft changed and the published revision does not hold yet", () => {
  const moved: KnowledgeSourceForm = { ...handbookSource, folders: "100\n200" };
  const publishButton = (page: string) =>
    /<button[^>]*data-knowledge-source-publish=""[^>]*>/u.exec(page)?.[0];

  it("tells folders, addresses and other settings apart, and nothing where both hold the same", () => {
    expect(sourceDraftChange(handbookSource, [handbookSource])).toBeUndefined();
    expect(
      sourceDraftChange(handbookSource, [{ ...handbookSource, folders: " 100 " }])
    ).toBeUndefined();
    expect(sourceDraftChange(moved, [handbookSource])).toBe("folders");
    expect(sourceDraftChange({ ...handbookSource, include: "*.pdf" }, [handbookSource])).toBe(
      "settings"
    );
    expect(
      sourceDraftChange({ ...handbookSource, schedule: { changes: 30 } }, [handbookSource])
    ).toBe("settings");
    const web: KnowledgeSourceForm = { ...handbookSource, web: true, pages: "https://a.example" };
    expect(sourceDraftChange({ ...web, pages: "https://b.example" }, [web])).toBe("addresses");
    // One the published revision does not have says it syncs once published, not this.
    expect(sourceDraftChange(moved, [])).toBeUndefined();
    expect(sourceDraftChange(moved, undefined)).toBeUndefined();
  });

  it("says the changed folders are not active yet, with Publish for who may publish", () => {
    const page = render("de", {
      sources: [moved],
      live: [handbookSource],
      publish: { open: () => undefined, unsaved: false }
    });
    expect(page).toContain('data-knowledge-source-draft="folders"');
    expect(page).toContain(
      "Noch nicht aktiv: die geänderten Ordner gelten nach dem Veröffentlichen."
    );
    expect(publishButton(page)).toBeDefined();
    expect(publishButton(page)).not.toContain(' disabled=""');
    expect(page).toContain("Veröffentlichen</button>");
    // The line of the card goes on about the published source.
    expect(page).toContain("Erstimport läuft … (42 von 46)");
    expect(render("en", { sources: [moved], live: [handbookSource] })).toContain(
      "Not active yet: the changed folders apply once published."
    );
  });

  it("gives a reader who may not publish the note alone, and holds Publish while changes are unsaved", () => {
    const note = render("de", { sources: [moved], live: [handbookSource] });
    expect(note).toContain("Noch nicht aktiv");
    expect(note).not.toContain("data-knowledge-source-publish");
    const unsaved = render("de", {
      sources: [moved],
      live: [handbookSource],
      publish: { open: () => undefined, unsaved: true }
    });
    expect(publishButton(unsaved)).toContain(' disabled=""');
    expect(publishButton(unsaved)).toContain("Speichere zuerst deine Änderungen");
    expect(render("de", { live: [handbookSource] })).not.toContain("Noch nicht aktiv");
    expect(
      render("de", { sources: [moved], live: [handbookSource], unpublished: true })
    ).not.toContain("Noch nicht aktiv");
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

describe("folders chosen by name (KB-FOLDERS-1)", () => {
  const browsing = [
    {
      name: "handbook-folders",
      title: "Box Objekte",
      connectorType: "box",
      browsesFolders: true as const
    }
  ];

  it("shows the folders by their paths, with a button to choose them and ids under Advanced", () => {
    const page = render("en", { connections: browsing });
    expect(page).toContain("Box Objekte");
    expect(page).toContain('data-knowledge-source-folder="100"');
    expect(page).toContain("/Objekte/100");
    expect(page).toContain("Choose folders");
    expect(page).toContain("Advanced settings");
    // The ids and the patterns wait under Advanced settings, closed.
    expect(page).not.toContain('data-knowledge-source-field="folders"');
  });

  it("keeps the folder ids in view where the Connection cannot list its folders", () => {
    const page = render("de");
    expect(page).toContain('data-knowledge-source-field="folders"');
    expect(page).not.toContain("Ordner wählen");
  });

  it("lists the folders inside one folder, each to tick or to open", () => {
    const page = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "de" },
        createElement(KnowledgeSourceFolderPicker, {
          source: sourceWith({ sources: [] }, browsing, undefined),
          connection: "handbook-folders",
          connectionTitle: "Box Objekte",
          chosen: ["202"],
          exclude: "Archiv/**",
          onClose: () => undefined,
          onChoose: () => undefined
        })
      )
    );
    expect(page).toContain("Ordner wählen");
    expect(page).toContain("Box Objekte");
    expect(page).toContain('data-knowledge-folder="201"');
    expect(page).toContain("Verträge öffnen");
    // How many folders are chosen and how many left out below them.
    expect(page).toContain("1 Ordner · 1 ausgelassen");
    expect(page).toContain("Diese Ordner übernehmen");
  });

  it("names the folders a source leaves out after its folders, each to read again", () => {
    const page = render("de", {
      connections: browsing,
      sources: [{ ...handbookSource, exclude: "Archiv/**\n**/*.tmp\n2019/Alt/**" }]
    });
    expect(page).toContain("/Objekte/100</span>, ohne Archiv, 2019/Alt");
    expect(page).toContain('data-knowledge-source-excluded-folder="Archiv"');
    expect(page).toContain('data-knowledge-source-excluded-folder="2019/Alt"');
    expect(page).toContain("Archiv wieder lesen");
    // A pattern that names no single folder stays under Advanced settings alone.
    expect(page).not.toContain('data-knowledge-source-excluded-folder="**');
  });

  it("asks a new Knowledge Base where its knowledge comes from, a connected source among them", () => {
    const page = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "de" },
        createElement(KnowledgeSourceChoice, {
          source: sourceWith({ sources: [] }, browsing, ["Box", "Dropbox"]),
          owner: undefined,
          form: knowledgeBaseConfigToForm({ name: "objekte", title: "Objekte" }),
          canWrite: true,
          uploadDescription: "PDF und Word",
          update: () => undefined
        })
      )
    );
    expect(page).toContain("Woher kommt ihr Wissen?");
    expect(page).toContain("Dateien hochladen");
    expect(page).toContain("Box Objekte");
    expect(page).toContain("Verbunden");
    expect(page).toContain("Ordner aus Box");
    expect(page).toContain("Tabellen eines Datenspeichers");
    // Box has a Connection; Dropbox has none yet.
    expect(page).toContain("Noch nicht verbunden: Dropbox.");
  });
});

describe("when a source syncs by itself (SRC-SYNC)", () => {
  const off: KnowledgeSourceForm = { ...handbookSource, schedule: { changes: "off", full: "off" } };
  const schedule = (
    changes: number | "off",
    full: string,
    type: { defaultFull?: string; minChanges?: number } = {}
  ) => ({
    sources: [
      {
        ...running,
        running: undefined,
        schedule: { changes, full, defaultChanges: 15, defaultFull: "0 2 * * *", ...type }
      }
    ]
  });

  it("writes both fields off and reads them back, and leaves out what is the default", () => {
    expect(knowledgeSourcesToConfig([off])).toEqual([
      {
        id: "handbook-folders",
        connection: "handbook-folders",
        folders: ["100"],
        schedule: { changes: "off", full: "off" }
      }
    ]);
    expect(knowledgeSourcesToConfig([{ ...handbookSource, schedule: {} }])).toEqual([
      { id: "handbook-folders", connection: "handbook-folders", folders: ["100"] }
    ]);
    expect(syncsByItself(off.schedule)).toBe(false);
    expect(syncsByItself({ changes: "off" })).toBe(true);
    expect(syncsByItself(undefined)).toBe(true);
  });

  it("says in one sentence how a source keeps itself current, from its schedule and defaults", () => {
    const sentence = (page: string) =>
      page.split('data-knowledge-source-sentence="">')[1]?.split("</p>")[0];
    // Nothing set: the instance's interval and the nightly pass.
    expect(sentence(render("de", { status: schedule(30, "0 2 * * *") }))).toBe(
      "Hält sich automatisch aktuell: neue und geänderte Dateien alle 15 Minuten, gelöschte Dateien werden nachts entfernt."
    );
    expect(sentence(render("en", { status: schedule(30, "0 2 * * *") }))).toBe(
      "Keeps itself up to date: new and changed files every 15 minutes, deleted files are removed every night."
    );
    const set = (value: KnowledgeSourceForm["schedule"]) =>
      sentence(render("de", { sources: [{ ...handbookSource, schedule: value }] }));
    expect(set({ changes: 60, full: "0 14 * * *" })).toBe(
      "Hält sich automatisch aktuell: neue und geänderte Dateien stündlich, gelöschte Dateien werden jeden Tag, 14:00 entfernt."
    );
    expect(set({ full: "off" })).toContain("Gelöschte Dateien werden nicht automatisch entfernt.");
    expect(set({ changes: "off" })).toContain("Wird nachts mit der Quelle abgeglichen");
    expect(set({ changes: "off", full: "off" })).toContain("Hält sich nicht automatisch aktuell.");
    // The controls wait behind the row's toggle. This source has failed items, so the toggle
    // leads to them; a fetch failure has no document row and its retry lives in here.
    expect(render("de")).toMatch(/data-knowledge-source-adjust=""[^>]*>.*?Fehler ansehen/su);
    expect(render("de")).toMatch(/data-knowledge-source-failed=""[^>]*>.*?2 fehlgeschlagen/su);
  });

  it("offers the switch, the interval and the full sync, with the default named", () => {
    const page = render("de", { status: schedule(30, "0 2 * * *") });
    expect(page).toContain('data-knowledge-source-schedule="on"');
    expect(page).toContain("Automatisch synchronisieren");
    expect(page).toContain("Änderungen abrufen");
    expect(page).toContain("Standard (alle 15 Minuten)");
    expect(page).toContain("Gelöschtes entfernen");
    // What the pass does is said without the word "vollständig".
    expect(page).not.toMatch(/vollständig/iu);
    // The published source says how it syncs now, where the draft sets it otherwise.
    expect(page).toContain("Ruft Änderungen ab");
    expect(page).toContain("Alle 30 Minuten");
    expect(page).not.toContain("Zeitzone</");
  });

  it("sets each of them in a row of its own, the control beside its words", () => {
    const page = render("de", { status: schedule(15, "0 2 * * *") });
    const rows = page.match(/data-slot="settings-row"/gu) ?? [];
    expect(rows).toHaveLength(3);
    // No heading says "Synchronisierung" over "Automatisch synchronisieren".
    expect(page).not.toMatch(/<legend[^>]*>Synchronisierung</u);
    // Deleted files leave with the pass of their own row, not with the changes.
    expect(page).toContain("Holt neue und geänderte Dateien.");
    expect(page).not.toContain("Neue, geänderte und gelöschte Dateien seit");
    expect(page).toContain("Nimmt heraus, was in der Quelle gelöscht oder verschoben wurde.");
    // The time is one button that reads as the schedule does.
    expect(page).toMatch(/data-knowledge-source-sync-when=""[^>]*>Täglich um 02:00</u);
    expect(page).not.toContain("Wiederholt sich");
    // It syncs as the rows say, so the published state does not say it again.
    expect(page).not.toContain("Ruft Änderungen ab");
    expect(render("en", { status: schedule(15, "0 2 * * *") })).toMatch(
      /data-knowledge-source-sync-when=""[^>]*>Daily at 02:00 AM</u
    );
    // Several days of a week read as a list in both languages.
    const weekly = (locale: "de" | "en") =>
      render(locale, {
        sources: [{ ...handbookSource, schedule: { full: "0 2 * * 1,3,5" } }],
        status: schedule(15, "0 2 * * 1,3,5")
      });
    expect(weekly("en")).toContain(">Mon, Wed, and Fri at 02:00 AM<");
    expect(weekly("de")).toContain(">Mo, Mi und Fr um 02:00<");
  });

  it("offers no interval below its type's floor, and shows its type's full sync as the default", () => {
    const page = render("en", {
      status: schedule(60, "0 3 * * 1", { defaultFull: "0 3 * * 1", minChanges: 60 })
    });
    expect(page).toContain("Fetches new and changed files, at most every hour.");
    expect(page).not.toContain('value="15"');
    expect(page).toContain('value="60"');
    expect(page).toContain('value="240"');
    // Weekly on Monday, as the type gives it, where the source sets nothing.
    expect(page).toMatch(/>Every Monday at 03:00 AM</u);
    // Before its first publish the Connection's list says the same.
    const draft = render("en", {
      unpublished: true,
      connections: [
        {
          name: "handbook-folders",
          title: "Handbook folders",
          sourceFull: "0 3 * * 1",
          sourceMinChanges: 60
        }
      ]
    });
    expect(draft).toContain("Fetches new and changed files, at most every hour.");
    expect(draft).not.toContain('value="15"');
  });

  it("says a source switched off syncs only by hand, and keeps Sync now", () => {
    const page = render("de", { sources: [off], status: schedule("off", "off") });
    expect(page).toContain('data-knowledge-source-schedule="off"');
    expect(page).toContain("Synchronisiert nur, wenn jemand auf „Jetzt synchronisieren“ klickt.");
    expect(page.match(/data-slot="settings-row"/gu)).toHaveLength(1);
    expect(page).not.toContain("Änderungen abrufen");
    expect(page).toContain("Automatische Synchronisierung aus");
    expect(page).toContain("Jetzt synchronisieren");
    expect(page).toContain(
      "Dateien, die in der Quelle gelöscht oder nicht mehr freigegeben sind, bleiben bis zur nächsten Synchronisierung durchsuchbar."
    );
    const english = render("en", { sources: [off], status: schedule("off", "off") });
    expect(english).toContain("Automatic sync off");
    expect(english).toContain(
      "Files deleted or made private in the source stay searchable until the next sync."
    );
  });

  it("shows a full sync it cannot put in its fields as the cron it is, and one switched off as never", () => {
    const custom = render("en", {
      sources: [{ ...handbookSource, schedule: { full: "*/30 1-5 * * *" } }],
      status: schedule(60, "off")
    });
    expect(custom).toContain('value="*/30 1-5 * * *"');
    expect(custom).toContain("Every hour");
    expect(custom).toMatch(/>Removes what was deleted<\/dt>.*?>Never</su);
  });

  it("gives a reader who may not change it the settings to read, not to change", () => {
    const page = render("de", { canWrite: false, sources: [off], status: schedule("off", "off") });
    expect(page).toMatch(
      /data-knowledge-source-sync-auto=""[^>]*disabled=""|disabled=""[^>]*data-knowledge-source-sync-auto=""/u
    );
  });
});
