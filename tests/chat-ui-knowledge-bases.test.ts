import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  agentConfigToForm,
  agentFormToConfig,
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  clearBuildStartRequest,
  knowledgeBaseConfigToForm,
  knowledgeBaseFormToConfig,
  knowledgeBaseKindOn,
  requestBuildStart,
  resolveBuildRights,
  startedKnowledgeBaseForm,
  type AvailabilityChoice,
  type BuildAsset,
  type BuildSource,
  type KnowledgeBaseSource,
  type KnowledgeBaseState,
  type KnowledgeDocument,
  type KnowledgeRead
} from "@work-shape/catalyst-chat-ui/build-area";
import {
  SettingsPageProvider,
  type SettingsPageContextValue
} from "@work-shape/catalyst-chat-ui/settings-page-context";
import { WorkflowsHostProvider, type WorkflowsHost } from "@work-shape/catalyst-chat-ui/workflows";
import { buildPageSettings } from "./chat-ui-build-page-harness";
import { required } from "./support/assertions";
import { platformContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The Knowledge Base page in Build against planted answers of `knowledge_bases.get` and the
// asset reads: the draft and its publish in the frame's head, the tables of the store with
// those it describes, and the last check of what is published.

const noop = () => undefined;
const ready = <Answer>(data: Answer): KnowledgeRead<Answer> => ({ status: "ready", data });

function knowledgeBase(pointers: { revision: number; publishedRevision?: number }): BuildAsset {
  return {
    id: "asset_findings",
    kind: "knowledge_base",
    name: "findings-kb",
    scope: { kind: "instance" },
    ...pointers,
    draftRevision: pointers.revision,
    config: {
      name: "findings-kb",
      title: "Findings",
      description: "What the monthly check of bookings found.",
      methods: ["structured"],
      backend: { dataStore: "findings" },
      tables: [
        { name: "findings", description: "One row per finding." },
        { name: "invoices", description: "One row per invoice." }
      ]
    },
    updatedAt: "2026-10-13T10:00:00.000Z"
  };
}

const needsAttention: KnowledgeBaseState = {
  id: "asset_findings",
  name: "findings-kb",
  status: "needs_attention",
  revision: 2,
  checkedAt: "2026-10-13T09:00:00.000Z",
  tables: [
    { name: "findings", readable: true },
    { name: "invoices", readable: false }
  ]
};

/** A Knowledge Base without a backend: it keeps documents in a store of its own. */
function documentsKnowledgeBase(): BuildAsset {
  return {
    id: "asset_handbook",
    kind: "knowledge_base",
    name: "handbook-kb",
    scope: { kind: "instance" },
    revision: 2,
    publishedRevision: 2,
    draftRevision: 2,
    config: {
      name: "handbook-kb",
      title: "Handbook",
      description: "The staff handbook and its appendices.",
      methods: ["keyword"]
    },
    updatedAt: "2026-10-17T10:00:00.000Z"
  };
}

const handbookDocument: KnowledgeDocument = {
  id: "kbdoc_1",
  fileId: "file_1",
  fileName: "handbook.md",
  title: "handbook",
  format: "markdown",
  bytes: 4096,
  state: "indexed",
  addedAt: "2026-10-17T09:00:00.000Z",
  updatedAt: "2026-10-17T09:00:00.000Z"
};

const source: KnowledgeBaseSource = {
  useState: () => ready(needsAttention),
  check: async () => ({ ok: true, data: needsAttention }),
  query: async () => ({ ok: false, refused: false, message: undefined }),
  search: async () => ({ ok: false, refused: false, message: undefined }),
  useDataStores: () => ready({ items: [{ name: "findings", title: "Findings store" }] }),
  useStoreTables: () => ready(["findings", "runs"]),
  useKnowledgeBases: () => ready({ items: [] }),
  useDocuments: () => ready({ documents: [handbookDocument] }),
  retry: async () => ({ ok: true, data: {} }),
  remove: async () => ({ ok: true, data: {} }),
  addFiles: async () => ({ ok: true, data: { count: 1 } }),
  uploadFile: async () => ({ ok: true, data: { count: 1 } }),
  useOpenableFiles: () => ready({ items: [] })
};

/**
 * The page of `asset`, or with `newAsset` the page of the new one a start asked for, its state
 * as `state` says, in `locale`.
 */
function render(
  asset: BuildAsset,
  {
    newAsset = false,
    state = needsAttention,
    locale = "en",
    workflows,
    settings,
    availability,
    reindex,
    documents
  }: {
    newAsset?: boolean;
    state?: KnowledgeBaseState;
    locale?: "en" | "de";
    /** The Workflows area is open to the reader in this workspace. */
    workflows?: WorkflowsHost;
    /** The page sits in the settings page of an instance with this config. */
    settings?: SettingsPageContextValue;
    /** Where agents can use it, as the instance answers it to a reader who may change it. */
    availability?: AvailabilityChoice;
    /** The re-index the page may start. */
    reindex?: KnowledgeBaseSource["reindex"];
    /** Its documents, where not the handbook alone. */
    documents?: KnowledgeDocument[];
  } = {}
): string {
  const name = newAsset ? undefined : asset.name;
  const context = platformContext();
  const frame: BuildSource = {
    kinds: [{ kind: "knowledge_base", canCreate: true, canDelete: true }],
    rights: resolveBuildRights({ permissions: ["config_assets.write"] }, context),
    loading: false,
    error: undefined,
    reload: async () => undefined,
    useList: () => ({
      rows: [],
      error: undefined,
      hasMore: false,
      loadingMore: false,
      loadMore: noop,
      retry: noop
    }),
    useAsset: () => ({ status: "ready", asset, loadedAt: 1, reload: async () => "loaded" }),
    exists: async () => true,
    checkName: async () => ({ available: true }),
    writes: {
      put: async () => ({ revision: 1 }),
      readFiles: async () => [],
      delete: async () => undefined,
      publish: async () => ({ draftRevision: 1, publishedRevision: 1 }),
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    }
  };
  const planted = knowledgeBaseKindOn(() => ({
    ...source,
    useState: () => ready(state),
    ...(availability === undefined ? {} : { useAvailability: () => availability }),
    ...(reindex === undefined ? {} : { reindex }),
    ...(documents === undefined ? {} : { useDocuments: () => ready({ documents }) })
  }));
  const kinds = buildAssetKinds.map((kind) => (kind.kind === "knowledge_base" ? planted : kind));
  const page = createElement(
    TranslationProvider,
    { children: null, locale },
    createElement(
      BuildAssetKindsProvider,
      { value: kinds },
      createElement(
        BuildNavigationProvider,
        {
          value: {
            location: { kindPath: "knowledge-bases", ...(name === undefined ? {} : { name }) },
            open: noop,
            href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
          }
        },
        createElement(WorkflowsHostProvider, {
          value: workflows,
          children: createElement(BuildFrame, { source: frame })
        })
      )
    )
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      settings === undefined
        ? page
        : createElement(SettingsPageProvider, { value: settings, children: page })
    )
  );
}

/** The settings of an instance whose document processing is on or off as `documents` says. */
function instanceSettings(documents: boolean): SettingsPageContextValue {
  const settings = buildPageSettings(async () => new Response(null, { status: 404 }));
  return {
    ...settings,
    config: {
      ...settings.config,
      modules: { ...settings.config.modules, documents: { enabled: documents } }
    }
  };
}

describe("Knowledge Bases in Build", () => {
  it("says that a saved draft is ahead of what is published and offers to publish it", () => {
    const page = render(knowledgeBase({ revision: 3, publishedRevision: 2 }));

    expect(page).toContain("data-build-draft-state");
    expect(page).toContain(">Draft<");
    expect(page).toContain("data-build-publish");
  });

  it("says nothing of a draft when the saved revision is the published one", () => {
    const page = render(knowledgeBase({ revision: 2, publishedRevision: 2 }));

    expect(page).not.toContain("data-build-draft-state");
    expect(page).not.toContain("data-build-publish");
  });

  it("lists the store's tables, keeps a described table the store lacks, and shows the last check", () => {
    const page = render(knowledgeBase({ revision: 2, publishedRevision: 2 }));

    expect(page).toContain('data-knowledge-table="findings"');
    expect(page).toContain('data-knowledge-table="runs"');
    expect(page).toContain('data-knowledge-table="invoices"');
    expect(page).toContain("Not in the data store");
    // A box left clear is no error: a required box stopped the browser from sending the form.
    expect(page).not.toMatch(/role="checkbox"[^>]*aria-required="true"/u);
    expect(page).toContain('data-knowledge-state="needs_attention"');
    expect(page).toContain("Cannot be read");
    expect(page).toContain("Check now");
    expect(page).toContain("select * from findings limit 20");
    expect(page).toContain("Say what the rows are about");
  });

  // AVAIL-1: agents can use a Knowledge Base in the workspaces it is available in.
  it("says where agents can use it, saved with the page and applied at once", () => {
    const section = (page: string) =>
      /<section[^>]*id="availability">.*?<\/section>/su.exec(page)?.[0] ?? "";
    const available = section(
      render(knowledgeBase({ revision: 2, publishedRevision: 2 }), {
        availability: {
          saved: { mode: "selected", personalWorkspaces: false, collaborationWorkspaceIds: [] },
          workspaces: [{ id: "ws_sales", name: "Sales", createdAt: "2026-06-27T00:00:00.000Z" }],
          save: async () => undefined
        }
      })
    );

    expect(available).toContain("where agents can answer from this knowledge base");
    expect(available).toContain("but not open its settings or change it");
    expect(available).toContain("Sales");
    expect(available).toContain("With nothing selected, agents cannot use it in any workspace.");
    expect(section(render(knowledgeBase({ revision: 2, publishedRevision: 2 })))).toBe("");
  });

  it("asks for a publish before it shows a check or a test query", () => {
    const page = render(knowledgeBase({ revision: 1 }));

    expect(page).toContain(">Not published<");
    expect(page).not.toContain("data-knowledge-state");
    // One notice under the head, not a Status and a Test query section that each say "publish".
    expect(page).toContain("data-knowledge-not-published");
    expect(page).toContain(
      "Not published yet. Publish it to see whether it can read its tables and to try a query."
    );
    expect(page).not.toContain(">Test query<");
    expect(page).not.toContain(">Status<");
  });
});

describe("the data Workflows of a Knowledge Base (WF-KIND)", () => {
  const workflows: WorkflowsHost = {
    rights: { instance: { read: true, write: false, publish: false, delete: false } },
    viewerId: "user_1",
    workspace: { id: "ws_1", name: "Mine" },
    showRoute: noop
  };
  const withFlows = (dataFlows: KnowledgeBaseState["dataFlows"]): KnowledgeBaseState => ({
    ...needsAttention,
    ...(dataFlows ? { dataFlows } : {})
  });
  const section = (page: string, id: string) =>
    page.indexOf(`id="${id}"`) === -1
      ? undefined
      : (page.slice(page.indexOf(`id="${id}"`)).split("</section>")[0] ?? "");

  it("names the Workflows that fill it and those that process it, each a link to its page", () => {
    const state = withFlows({
      fills: [{ id: "asset_import", name: "findings-import", title: "Findings import" }],
      processes: [
        { id: "asset_extract", name: "findings-extract", title: "Extract findings" },
        { id: "asset_classify", name: "findings-classify", title: "" }
      ],
      hidden: { fills: 2, processes: 0 },
      truncated: true
    });
    const page = render(knowledgeBase({ revision: 2, publishedRevision: 2 }), {
      state,
      workflows
    });
    const filled = required(section(page, "filled-by"));
    expect(filled).toContain(">Filled by</h2>");
    expect(filled).toContain(">Findings import<");
    expect(filled).toContain('href="/w/ws_1/workflows/findings-import"');
    expect(filled).toContain("and 2 more you can&#x27;t see");
    const processed = required(section(page, "processed-by"));
    expect(processed).toContain(">Processed by</h2>");
    expect(processed).toContain(">Extract findings<");
    // A Workflow without a title is named by its name.
    expect(processed).toContain(">findings-classify<");
    expect(processed).toContain('href="/w/ws_1/workflows/findings-extract"');
    // The note on a cut read stands once, under the last section.
    expect(page.split("this list may be incomplete").length - 1).toBe(1);
    expect(processed).toContain("this list may be incomplete");

    const german = render(knowledgeBase({ revision: 2, publishedRevision: 2 }), {
      state,
      workflows,
      locale: "de"
    });
    expect(german).toContain(">Gefüllt von</h2>");
    expect(german).toContain(">Verarbeitet von</h2>");
    // Where the Workflows area is closed to the reader, the names stand without a link.
    const closed = render(knowledgeBase({ revision: 2, publishedRevision: 2 }), { state });
    expect(closed).toContain(">Findings import<");
    expect(closed).not.toContain("/workflows/findings-import");
  });

  it("counts the Workflows the reader may not see without naming one, and has no section without any", () => {
    const hiddenOnly = render(knowledgeBase({ revision: 2, publishedRevision: 2 }), {
      state: withFlows({
        fills: [],
        processes: [],
        hidden: { fills: 3, processes: 0 },
        truncated: false
      }),
      workflows
    });
    const filled = required(section(hiddenOnly, "filled-by"));
    expect(filled).toContain("3 workflows you can&#x27;t see do this.");
    expect(filled).not.toContain("data-data-flow=");
    expect(section(hiddenOnly, "processed-by")).toBeUndefined();
    // A cut read that found none still says the list may be incomplete, once.
    const cut = render(knowledgeBase({ revision: 2, publishedRevision: 2 }), {
      state: withFlows({
        fills: [],
        processes: [],
        hidden: { fills: 0, processes: 0 },
        truncated: true
      })
    });
    expect(required(section(cut, "filled-by"))).toContain("this list may be incomplete");
    expect(cut.split("this list may be incomplete").length - 1).toBe(1);
    expect(section(cut, "processed-by")).toBeUndefined();
    for (const state of [
      needsAttention,
      withFlows({ fills: [], processes: [], hidden: { fills: 0, processes: 0 }, truncated: false })
    ]) {
      const page = render(knowledgeBase({ revision: 2, publishedRevision: 2 }), { state });
      expect(section(page, "filled-by")).toBeUndefined();
      expect(section(page, "processed-by")).toBeUndefined();
    }
  });
});

describe("Knowledge Bases of documents", () => {
  it("lists the documents of a published one with their state, and offers no SQL query", () => {
    const page = render(documentsKnowledgeBase());

    expect(page).toContain("data-knowledge-documents");
    expect(page).toContain('data-knowledge-document-state="indexed"');
    expect(page).toContain("Searchable");
    expect(page).toContain("data-knowledge-add");
    expect(page).toContain("Everyone who may use this knowledge base finds every document in it");
    // What it holds is told of its documents, not of rows of a table.
    expect(page).toContain("Say what the documents are about");
    expect(page).not.toContain("Say what the rows are about");
    // What it answers from is fixed once it exists: no choice, and no data store to pick.
    expect(page).toContain("What it answers from");
    expect(page).not.toContain('role="radiogroup"');
    expect(page).not.toContain("Choose a data store");
    expect(page).not.toContain("Test query");
    // Instead a search to try, as an agent searches.
    expect(page).toContain("Test search");
    expect(page).toContain("data-knowledge-test-search");
  });

  it("is being set up while its store is made, and needs no attention for that", () => {
    const preparing: KnowledgeBaseState = {
      id: "asset_handbook",
      name: "handbook-kb",
      status: "preparing",
      revision: 1,
      checkedAt: "2026-10-17T09:00:00.000Z",
      tables: [],
      problem: "The store for the Knowledge Base's documents is being made."
    };

    const page = render(documentsKnowledgeBase(), { state: preparing, locale: "de" });

    expect(page).toContain('data-knowledge-state="preparing"');
    expect(page).toContain("Wird eingerichtet");
    expect(page).toContain("data-knowledge-preparing");
    expect(page).not.toContain("Braucht Aufmerksamkeit");
    // What is no fault is shown as no error.
    expect(page).not.toContain("is being made.");
  });

  it("offers to embed the searchable documents of one that searches by meaning and has no index yet", () => {
    const semantic = documentsKnowledgeBase();
    const asset = { ...semantic, config: { ...semantic.config, methods: ["semantic", "keyword"] } };
    const unembedded: KnowledgeBaseState = {
      id: "asset_handbook",
      name: "handbook-kb",
      status: "ok",
      revision: 2,
      checkedAt: "2026-10-17T09:00:00.000Z",
      tables: [],
      embedding: {
        state: "none",
        target: { bindingId: "embedding", model: "text-embedding-small", dimensions: 8 }
      }
    };
    const reindex: KnowledgeBaseSource["reindex"] = async () => ({
      ok: true,
      data: { started: false, state: "none" }
    });

    const english = render(asset, { state: unembedded, reindex });
    expect(english).toContain('data-knowledge-embedding="none"');
    expect(english).toContain("data-knowledge-reindex");
    expect(english).toContain("Embed passages…");
    expect(english).toContain("The passages are not embedded yet");
    expect(english).not.toContain("Re-index…");
    const german = render(asset, { state: unembedded, reindex, locale: "de" });
    expect(german).toContain("Passagen einbetten…");
    expect(german).toContain("Die Passagen sind noch nicht eingebettet.");

    // With no searchable document there is nothing to embed, and nothing is offered.
    const empty = render(asset, { state: unembedded, reindex, documents: [] });
    expect(empty).toContain('data-knowledge-embedding="none"');
    expect(empty).not.toContain("data-knowledge-reindex");
  });

  it("starts a new Knowledge Base by asking where its knowledge comes from, upload chosen", () => {
    try {
      requestBuildStart("knowledge-bases", { name: "contracts-kb", title: "Contracts" });
      const page = render(documentsKnowledgeBase(), { newAsset: true });

      expect(page).toContain('role="radiogroup"');
      const checked = /<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*>/u.exec(page)?.[0];
      const label = checked ? /aria-labelledby="([^"]+)"/u.exec(checked)?.[1] : undefined;
      expect(label).toBeDefined();
      expect(page).toContain("Where does its knowledge come from?");
      expect(page).toMatch(new RegExp(`id="${label}" class="text-label">.*?Upload files<`, "u"));
      expect(page).toContain("Tables of a data store");
      expect(page).not.toContain("Choose a data store");
      // It goes live on create: no section waits for a publish, and the save bar says so.
      expect(page).toContain("Goes live when it is created, available in no workspace");
      expect(page).not.toContain("data-knowledge-not-published");
      expect(page).not.toContain(">Test search<");
      expect(page).not.toContain("Saves a draft.");
    } finally {
      clearBuildStartRequest();
    }
  });

  it("names on the create page exactly the formats the instance reads (ACCEPT-FIX-8, C13)", () => {
    // Before the first publish the page has no read of the store, so the formats come from the
    // instance: PDF and DOCX only with its document processing, else TXT and Markdown. Outside a
    // settings page it names the text formats, which every instance reads.
    try {
      requestBuildStart("knowledge-bases", { name: "contracts-kb", title: "Contracts" });
      for (const settings of [undefined, instanceSettings(false)]) {
        const english = render(documentsKnowledgeBase(), { newAsset: true, settings });
        expect(english).toContain("Files you add: TXT and Markdown.");
        expect(english).not.toMatch(/PDF|DOCX/u);
        const german = render(documentsKnowledgeBase(), { newAsset: true, locale: "de", settings });
        expect(german).toContain("Dateien, die du hinzufügst: TXT und Markdown.");
        expect(german).not.toMatch(/PDF|DOCX/u);
      }
      const settings = instanceSettings(true);
      expect(render(documentsKnowledgeBase(), { newAsset: true, settings })).toContain(
        "Files you add: TXT, Markdown, PDF, and DOCX."
      );
      expect(
        render(documentsKnowledgeBase(), { newAsset: true, locale: "de", settings })
      ).toContain("Dateien, die du hinzufügst: TXT, Markdown, PDF und DOCX.");
    } finally {
      clearBuildStartRequest();
    }
  });

  it("writes a new one without a backend, searching by words", () => {
    const form = startedKnowledgeBaseForm({ name: "contracts-kb", title: "Contracts" });

    expect(knowledgeBaseFormToConfig({ ...form, description: "Signed contracts." })).toEqual({
      name: "contracts-kb",
      title: "Contracts",
      description: "Signed contracts.",
      methods: ["keyword"]
    });
  });

  it("writes a new one that searches by meaning and by words where the instance offers it", () => {
    const form = startedKnowledgeBaseForm({ name: "contracts-kb", title: "Contracts" }, true);

    expect(knowledgeBaseFormToConfig({ ...form, description: "Signed contracts." })).toEqual({
      name: "contracts-kb",
      title: "Contracts",
      description: "Signed contracts.",
      methods: ["semantic", "keyword"]
    });
  });

  it("keeps a definition as it was: methods it names, none where it names none, and tables", () => {
    const documents = documentsKnowledgeBase().config;
    expect(knowledgeBaseFormToConfig(knowledgeBaseConfigToForm(documents))).toEqual(documents);

    const { methods: _methods, ...withoutMethods } = documents;
    expect(knowledgeBaseFormToConfig(knowledgeBaseConfigToForm(withoutMethods))).toEqual(
      withoutMethods
    );

    const tables = knowledgeBase({ revision: 1 }).config;
    expect(knowledgeBaseFormToConfig(knowledgeBaseConfigToForm(tables))).toEqual(tables);
  });
});

describe("the agent form", () => {
  it("keeps the Knowledge Bases an agent lists through a save, and writes none where it lists none", () => {
    const config = {
      name: "analyst",
      displayName: "Analyst",
      instructions: "Answer.",
      toolNames: [],
      skillNames: [],
      knowledgeBases: ["findings-kb"],
      initialPrompts: []
    };

    expect(agentFormToConfig(agentConfigToForm(config))).toMatchObject({
      knowledgeBases: ["findings-kb"]
    });
    expect(
      agentFormToConfig(agentConfigToForm({ ...config, knowledgeBases: [] }))
    ).not.toHaveProperty("knowledgeBases");
  });
});
