import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BuildNavigationProvider,
  KnowledgeSourcesSection,
  knowledgeBaseConfigToForm,
  knowledgeBaseFormToConfig,
  knowledgeSourcesFromConfig,
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
  type KnowledgeSources
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
    service?: { title: string; mark: { color?: string; logo?: string } };
    opens?: true;
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
      service?: { title: string; mark: { color?: string; logo?: string } };
      opens?: true;
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
              href: (place) => `/build/${[place.kindPath, place.name].filter(Boolean).join("/")}`
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
        include: ["*.pdf", "*.{md,txt}"],
        schedule: { full: "0 3 * * 1" }
      }
    ],
    documentTypes: [{ id: "policy", label: "Policy" }],
    extraction: { maxPagesPerDocument: 200 }
  };

  it("writes a definition back as it was read, with what the page does not show", () => {
    expect(knowledgeBaseFormToConfig(knowledgeBaseConfigToForm(stored))).toEqual(stored);
  });

  it("writes a changed source and leaves the rest as it was, and no sources where none are left", () => {
    const form = knowledgeBaseConfigToForm(stored);
    const first = required(form.sources[0]);
    const written = knowledgeBaseFormToConfig({
      ...form,
      sources: [{ ...first, folders: " 100 ,\n200\n100\n", include: "\n", schedule: {} }]
    });
    expect(written).toEqual({
      ...stored,
      sources: [{ id: "handbook-folders", connection: "handbook-folders", folders: ["100", "200"] }]
    });
    const { sources: _sources, ...rest } = stored;
    expect(knowledgeBaseFormToConfig({ ...form, sources: [] })).toEqual(rest);
    expect(
      knowledgeSourcesToConfig([{ ...handbookSource, schedule: { changes: "off", full: "off" } }])
    ).toEqual([
      {
        id: "handbook-folders",
        connection: "handbook-folders",
        folders: ["100"],
        schedule: { changes: "off", full: "off" }
      }
    ]);
    expect(syncsByItself({ changes: "off", full: "off" })).toBe(false);
    expect(syncsByItself({ changes: "off" })).toBe(true);
    expect(syncsByItself(undefined)).toBe(true);
  });

  it("names a new source after its Connection, once, in the form a source id takes", () => {
    expect(newSourceId("Box_Handbuch", [])).toBe("box-handbuch");
    expect(newSourceId("box-handbuch", ["box-handbuch", "box-handbuch-2"])).toBe("box-handbuch-3");
    expect(newSourceId("2026-ablage", [])).toBe("source-2026-ablage");
    const long = newSourceId("a".repeat(80), ["a".repeat(60)]);
    expect(long).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
    expect(long.length).toBeLessThanOrEqual(63);
    expect(newKnowledgeSource("handbook-folders", [handbookSource]).id).toBe("handbook-folders-2");
  });
});

describe("the state of a synced source", () => {
  const last = {
    syncRunId: "sync_0",
    source: "handbook-folders",
    mode: "changes" as const,
    counts: { discovered: 0, added: 0, changed: 0, moved: 0, withdrawn: 0, failed: 0, skipped: 0 },
    bytesFetched: 0,
    startedAt: "2026-10-21T07:00:00.000Z"
  };

  it("is a waiting confirmation's, else the running sync's, else how the last one ended", () => {
    expect(sourceStateView(running).state).toBe("initial");
    expect(sourceStateView({ running: { ...initialSync, mode: "changes" } }).state).toBe("syncing");
    expect(sourceStateView({}).state).toBe("never");
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
    expect(
      sourceStateView({
        ...running,
        confirmation: { syncRunId: "sync_1", items: 12_000, bytes: 1, stop: 10_000, storeBytes: 1 }
      }).state
    ).toBe("waiting");
    expect(
      sourceStateView({
        running: { syncRunId: "s", mode: "ingest", startedAt: "2026-10-24T08:00:00.000Z" }
      })
    ).toMatchObject({ label: "knowledgeSources.stateIngesting" });
    expect(
      sourceStateView({
        last: {
          ...last,
          mode: "ingest",
          state: "failed",
          failureCode: "knowledge_ingest_cancelled"
        }
      })
    ).toMatchObject({ state: "failed", label: "knowledgeSources.stateRunEnded" });
  });

  it("gives a reader who may not change it no button and no field to type in", () => {
    const writer = render("en");
    expect(writer).toContain("data-knowledge-source-sync");
    expect(writer).toContain("data-knowledge-source-remove");
    const page = render("en", { canWrite: false });
    expect(page).toContain("Initial import running");
    expect(page).not.toContain("Try again");
    expect(page).not.toContain("data-knowledge-source-sync=");
    expect(page).not.toContain("data-knowledge-source-add");
    expect(page).not.toContain("data-knowledge-source-remove");
    expect(page).toMatch(/<textarea[^>]*readOnly=""[^>]*data-knowledge-source-field="folders"/u);
    const settings = render("en", {
      canWrite: false,
      sources: [{ ...handbookSource, schedule: { changes: "off", full: "off" } }]
    });
    expect(settings).toMatch(
      /data-knowledge-source-sync-auto=""[^>]*disabled=""|disabled=""[^>]*data-knowledge-source-sync-auto=""/u
    );
  });

  it("offers a new Connection only where no Connection can sync folders and Studio can make one", () => {
    const page = render("en", {
      sources: [],
      connections: [],
      sourceTypes: ["Box"],
      inBuild: true
    });
    expect(page).toMatch(
      /<a[^>]*href="\/build\/connections"[^>]*data-knowledge-source-connect=""/u
    );
    expect(page).not.toContain("data-knowledge-source-add");
    expect(render("en", { sources: [], connections: [] })).not.toContain(
      "data-knowledge-source-connect"
    );
    expect(
      render("en", { sources: [], connections: [], sourceTypes: [], inBuild: true })
    ).not.toContain("data-knowledge-source-connect");
  });
});

describe("what a published source does right now", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const line = (page: string) =>
    /data-knowledge-source-live="(?<state>[^"]*)"[^>]*>(?<text>.*?)<\/p>/su.exec(page)?.groups;
  const every15 = { changes: 15, full: "0 2 * * *", defaultChanges: 15, defaultFull: "0 2 * * *" };
  const idle: KnowledgeSourceStatus = {
    id: "handbook-folders",
    connection: "handbook-folders",
    items: { discovered: 0, fetched: 0, indexed: 46, failed: 0, withdrawn: 0 },
    failures: [],
    last: {
      syncRunId: "sync_0",
      source: "handbook-folders",
      mode: "changes",
      state: "done",
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
      startedAt: "2026-10-21T08:00:00.000Z",
      endedAt: "2026-10-21T08:00:20.000Z"
    },
    schedule: every15
  };

  // fix: a running sync gives its count only while items still wait.
  it("counts the items through only while some still wait", () => {
    const page = render("en", {
      status: { sources: [{ ...running, running: { ...initialSync, mode: "changes" } }] }
    });
    expect(line(page)?.state).toBe("running");
    // Searchable and failed of the items it found: 40 + 2 of 46 (withdrawn left out).
    expect(line(page)?.text).toContain("(42 of 46)");
    const through = { ...idle, running: { ...initialSync, mode: "changes" as const } };
    expect(line(render("en", { status: { sources: [through] } }))?.text).not.toContain(" of ");
  });

  it("syncs next one interval after the last start, and is read again just after that", () => {
    expect(sourceNextSyncAt(idle)?.toISOString()).toBe("2026-10-21T08:15:00.000Z");
    const fullOnly = { ...idle, schedule: { ...every15, changes: "off" as const } };
    expect(sourceNextSyncAt(fullOnly)).toBeUndefined();
    const before = new Date("2026-10-21T08:05:00.000Z");
    expect(sourcesReadAgainIn({ sources: [idle] }, before)).toBe(10 * 60_000 + 75_000);
    expect(
      sourcesReadAgainIn({ sources: [idle] }, new Date("2026-10-21T08:15:10.000Z"))
    ).toBeUndefined();
    expect(sourcesReadAgainIn({ sources: [running] }, before)).toBeUndefined();
    expect(sourcesReadAgainIn({ sources: [fullOnly] }, before)).toBeUndefined();
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
    expect(
      sourceDraftChange({ ...handbookSource, schedule: { changes: 30 } }, [handbookSource])
    ).toBe("settings");
    const web: KnowledgeSourceForm = { ...handbookSource, web: true, pages: "https://a.example" };
    expect(sourceDraftChange({ ...web, pages: "https://b.example" }, [web])).toBe("addresses");
    expect(sourceDraftChange(moved, [])).toBeUndefined();
    expect(sourceDraftChange(moved, undefined)).toBeUndefined();
  });

  it("offers Publish only to who may publish, held while changes are unsaved", () => {
    const page = render("en", {
      sources: [moved],
      live: [handbookSource],
      publish: { open: () => undefined, unsaved: false }
    });
    expect(page).toContain('data-knowledge-source-draft="folders"');
    expect(publishButton(page)).not.toContain(' disabled=""');
    const note = render("en", { sources: [moved], live: [handbookSource] });
    expect(note).toContain('data-knowledge-source-draft="folders"');
    expect(note).not.toContain("data-knowledge-source-publish");
    const unsaved = render("en", {
      sources: [moved],
      live: [handbookSource],
      publish: { open: () => undefined, unsaved: true }
    });
    expect(publishButton(unsaved)).toContain(' disabled=""');
    expect(
      render("en", { sources: [moved], live: [handbookSource], unpublished: true })
    ).not.toContain("data-knowledge-source-draft");
  });

  it("holds the publish while the question before it reads or failed", () => {
    expect(publishQuestionHolds({ status: "loading" })).toBe(true);
    expect(publishQuestionHolds({ status: "failed" })).toBe(true);
    expect(publishQuestionHolds({ status: "ready", lines: [] })).toBe(false);
    expect(publishQuestionHolds({ status: "none" })).toBe(false);
  });
});

describe("a source a Workflow fills (KBW-1)", () => {
  const fed = {
    id: "workflow:nightly-import",
    kind: "workflow",
    workflowId: "nightly-import",
    items: { discovered: 0, fetched: 0, indexed: 198, failed: 2, withdrawn: 10 },
    failures: [{ code: "knowledge_item_removed", count: 3 }],
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
      startedAt: "2026-10-24T08:00:00.000Z",
      endedAt: "2026-10-24T08:00:00.000Z"
    }
  } satisfies KnowledgeSourceStatus;

  it("has no Sync now, and offers Allow again on documents removed by hand only to who may publish (KBW-2b)", () => {
    const publisher = render("en", { sources: [], status: { sources: [fed] }, canPublish: true });
    expect(publisher).toContain('data-knowledge-source-kind="workflow"');
    expect(publisher).not.toContain("data-knowledge-source-sync=");
    expect(publisher).toContain("data-knowledge-source-release");
    const writer = render("en", { sources: [], status: { sources: [fed] } });
    expect(writer).not.toContain("data-knowledge-source-release");
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

  it("states count and cost, with the button only for who may publish", () => {
    const html = render("de", { status: { sources: [waiting] }, canPublish: true });
    expect(html).toMatch(/250,00\s€ bis 380,00\s€/u);
    expect(html).toContain('data-knowledge-source-confirm=""');
    for (const canPublish of [false, undefined]) {
      const reader = render("en", {
        status: { sources: [waiting] },
        ...(canPublish === undefined ? {} : { canPublish })
      });
      expect(reader).toContain("data-knowledge-source-confirmation");
      expect(reader).not.toContain('data-knowledge-source-confirm=""');
    }
    expect(render("en", { canPublish: true })).not.toContain("data-knowledge-source-confirmation");
  });

  it("states no passages, tokens or room where nothing is embedded (KB-ISO-1b review)", () => {
    const { syncRunId, items, bytes, stop, storeBytes } = required(waiting.confirmation);
    const html = render("en", {
      status: {
        sources: [
          {
            ...waiting,
            confirmation: { syncRunId, items, bytes, stop, storeBytes, limitBytes: 1_000 }
          }
        ]
      }
    });
    expect(html).not.toMatch(/Passages \(estimated\)/u);
    expect(html).not.toMatch(/Tokens \(estimated\)/u);
    expect(html).not.toMatch(/may not have room/u);
  });
});

describe("folders chosen by name (KB-FOLDERS-1)", () => {
  it("lists the folders by path where the Connection browses them, and ids where it cannot", () => {
    const browsing = [
      {
        name: "handbook-folders",
        title: "Box",
        connectorType: "box",
        browsesFolders: true as const
      }
    ];
    const page = render("en", {
      connections: browsing,
      sources: [{ ...handbookSource, exclude: "Archiv/**\n**/*.tmp" }]
    });
    expect(page).toContain('data-knowledge-source-folder="100"');
    expect(page).toContain("/Objekte/100");
    expect(page).toContain('data-knowledge-source-excluded-folder="Archiv"');
    expect(page).not.toContain('data-knowledge-source-excluded-folder="**');
    expect(page).not.toContain('data-knowledge-source-field="folders"');
    expect(render("en")).toContain('data-knowledge-source-field="folders"');
  });
});

describe("where a source's documents come from (CONN-IA)", () => {
  it("names the service, the Connection and the folders, with a link only for who may open it", () => {
    const files = {
      name: "handbook-folders",
      title: "Team files",
      connectorType: "box",
      browsesFolders: true as const,
      service: { title: "Box", mark: { color: "#0061d5" } }
    };
    const page = render("de", { connections: [{ ...files, opens: true }], inBuild: true });
    expect(page).toContain('data-knowledge-source-connection="handbook-folders"');
    expect(page).toContain("Verbindung: ");
    expect(page).toContain('href="/build/connections/handbook-folders"');
    expect(page).toMatch(/data-knowledge-source-paths[^>]*>.*\/Objekte\/100/su);
    const reader = render("de", { connections: [files], inBuild: true });
    expect(reader).toContain("Team files");
    expect(reader).not.toContain('href="/build/connections/handbook-folders"');
  });
});

describe("a source of public web pages (KB-WEB)", () => {
  it("starts through a web Connection with addresses and writes only the lists it holds", () => {
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
    const folders = [{ id: "files", connection: "box", folders: ["100"] }];
    expect(knowledgeSourcesToConfig(knowledgeSourcesFromConfig(folders))).toEqual(folders);
  });

  it("shows address fields for a web Connection, and no folder field", () => {
    const html = render("en", {
      unpublished: true,
      sources: [
        { ...newKnowledgeSource("public-pages", [], "web"), pages: "https://www.example.org/a" }
      ],
      connections: [{ name: "public-pages", title: "Public pages", connectorType: "web" }]
    });
    expect(html).toContain('data-knowledge-source-field="pages"');
    expect(html).toContain('data-knowledge-source-field="prefixes"');
    expect(html).not.toContain('data-knowledge-source-field="folders"');
  });
});
