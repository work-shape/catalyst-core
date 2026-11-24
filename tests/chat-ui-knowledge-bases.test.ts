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
  ReindexStatement,
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
import { createTranslationContext } from "./support/chat-ui/shared";
import { rightSentenceKeys } from "./support/chat-ui";

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
    documents,
    askInChat
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
    /** The page has a chat beside it that takes a question. */
    askInChat?: KnowledgeBaseSource["askInChat"];
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
    ...(askInChat === undefined ? {} : { askInChat }),
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
  const ok: KnowledgeBaseState = {
    ...needsAttention,
    status: "ok",
    tables: needsAttention.tables.map((table) => ({ ...table, readable: true }))
  };

  it("offers to publish a saved draft that is ahead of what is published, and only then", () => {
    const ahead = render(knowledgeBase({ revision: 3, publishedRevision: 2 }));
    expect(ahead).toMatch(/data-asset-status="draft"[^>]*data-draft-revision="3"/u);
    expect(ahead).toContain("data-build-publish");
    const live = render(knowledgeBase({ revision: 2, publishedRevision: 2 }));
    expect(live).toContain('data-asset-status="live"');
    expect(live).not.toContain("data-build-publish");
  });

  it("lists the store's tables, keeps a described table the store lacks, and flags one that cannot be read", () => {
    const page = render(knowledgeBase({ revision: 2, publishedRevision: 2 }));
    expect(page).toContain('data-knowledge-table="findings"');
    expect(page).toContain('data-knowledge-table="runs"');
    expect(page).toContain('data-knowledge-table="invoices"');
    // fix: a box left clear is no error; a required box stopped the browser from sending the form.
    expect(page).not.toMatch(/role="checkbox"[^>]*aria-required="true"/u);
    expect(page).toContain('data-knowledge-state="needs_attention"');
    expect(page).toContain("data-knowledge-attention");
    // fix: a published one never checked says so at the top too.
    expect(
      render(knowledgeBase({ revision: 2, publishedRevision: 2 }), {
        state: { ...ok, status: "unchecked" }
      })
    ).toContain("data-knowledge-attention");
    expect(
      render(knowledgeBase({ revision: 2, publishedRevision: 2 }), { state: ok })
    ).not.toContain("data-knowledge-attention");
  });

  it("offers the question only where the page has a chat", () => {
    const asset = knowledgeBase({ revision: 2, publishedRevision: 2 });
    expect(render(asset, { state: ok })).not.toContain("data-knowledge-ask");
    expect(render(asset, { state: ok, askInChat: noop })).toContain("data-knowledge-ask");
  });

  it("opens Settings by itself while no data store is chosen", () => {
    const asset = knowledgeBase({ revision: 1 });
    const page = render({
      ...asset,
      config: { ...asset.config, backend: { dataStore: "" }, tables: [] }
    });
    expect(page).toMatch(/<button[^>]*aria-expanded="true"[^>]*data-asset-settings-trigger/u);
  });

  it("shows where agents can use it only to a reader the instance answers it to", () => {
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
    expect(available).toContain("Sales");
    expect(section(render(knowledgeBase({ revision: 2, publishedRevision: 2 })))).toBe("");
  });

  it("asks for a publish before it shows a check or a test query", () => {
    const page = render(knowledgeBase({ revision: 1 }));
    expect(page).toContain("data-knowledge-not-published");
    expect(page).not.toContain("data-knowledge-state");
    expect(page).not.toContain("data-knowledge-ask");
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

  it("links the Workflows that fill and process it where the reader may open Workflows, and counts hidden ones without naming them", () => {
    const state = withFlows({
      fills: [{ id: "asset_import", name: "findings-import", title: "Findings import" }],
      processes: [{ id: "asset_extract", name: "findings-extract", title: "Extract findings" }],
      hidden: { fills: 2, processes: 0 },
      truncated: false
    });
    const page = render(knowledgeBase({ revision: 2, publishedRevision: 2 }), { state, workflows });
    const filled = required(section(page, "filled-by"));
    expect(filled).toContain('href="/w/ws_1/workflows/findings-import"');
    expect(filled).toContain("2 more");
    expect(required(section(page, "processed-by"))).toContain(
      'href="/w/ws_1/workflows/findings-extract"'
    );
    // Where the Workflows area is closed to the reader, the names stand without a link.
    const closed = render(knowledgeBase({ revision: 2, publishedRevision: 2 }), { state });
    expect(closed).toContain(">Findings import<");
    expect(closed).not.toContain("/workflows/findings-import");

    const hiddenOnly = render(knowledgeBase({ revision: 2, publishedRevision: 2 }), {
      state: withFlows({
        fills: [],
        processes: [],
        hidden: { fills: 3, processes: 0 },
        truncated: false
      }),
      workflows
    });
    expect(required(section(hiddenOnly, "filled-by"))).not.toContain("data-data-flow=");
    expect(section(hiddenOnly, "processed-by")).toBeUndefined();
    const none = render(knowledgeBase({ revision: 2, publishedRevision: 2 }));
    expect(section(none, "filled-by")).toBeUndefined();
  });
});

describe("Knowledge Bases of documents", () => {
  it("lists the documents of a published one with a test search, and offers no SQL query", () => {
    const page = render(documentsKnowledgeBase());
    expect(page).toContain('data-knowledge-document-state="indexed"');
    expect(page).toContain("data-knowledge-add");
    expect(page).toContain("data-knowledge-test-search");
    expect(page).not.toContain("Choose a data store");
    expect(page).not.toContain("Test query");
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
    const page = render(documentsKnowledgeBase(), { state: preparing });
    expect(page).toContain("data-knowledge-preparing");
    expect(page).not.toContain("data-knowledge-attention");
    expect(page).toContain('data-knowledge-state="preparing"');
    // What is no fault is shown as no error.
    expect(page).not.toContain(required(preparing.problem));
  });

  // fix (KB-8 leftovers): Studio offers to embed one with no index.
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
    expect(render(asset, { state: unembedded, reindex })).toContain("data-knowledge-reindex");
    // With no searchable document there is nothing to embed, and nothing is offered.
    expect(render(asset, { state: unembedded, reindex, documents: [] })).not.toContain(
      "data-knowledge-reindex"
    );
  });

  it("names on the create page exactly the formats the instance reads (ACCEPT-FIX-8, C13)", () => {
    try {
      requestBuildStart("knowledge-bases", { name: "contracts-kb", title: "Contracts" });
      for (const settings of [undefined, instanceSettings(false)]) {
        expect(render(documentsKnowledgeBase(), { newAsset: true, settings })).not.toMatch(
          /PDF|DOCX/u
        );
      }
      expect(
        render(documentsKnowledgeBase(), { newAsset: true, settings: instanceSettings(true) })
      ).toContain("PDF, DOCX");
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

  it("writes the keyword languages chosen in Advanced beside the embedding binding it keeps (KB-12)", () => {
    const documents = {
      ...documentsKnowledgeBase().config,
      indexing: { embedding: { binding: "embedding-large" } }
    };
    const form = knowledgeBaseConfigToForm(documents);
    // Listing none, it writes none: German and English stay the instance's default.
    expect(form.languages).toEqual([]);
    expect(knowledgeBaseFormToConfig(form)).toEqual(documents);
    expect(knowledgeBaseFormToConfig({ ...form, languages: ["de", "fr"] })).toEqual({
      ...documents,
      indexing: { embedding: { binding: "embedding-large" }, languages: ["de", "fr"] }
    });
    const listed = { ...documents, indexing: { languages: ["fr"] } };
    expect(knowledgeBaseConfigToForm(listed).languages).toEqual(["fr"]);
    expect(knowledgeBaseFormToConfig(knowledgeBaseConfigToForm(listed))).toEqual(listed);
  });

  it("checks German and English among the keyword languages where none is listed", () => {
    const boxOf = (html: string, language: string) =>
      html.split(`data-knowledge-keyword-language="${language}"`)[1]?.split("</li>")[0] ?? "";
    const page = render(documentsKnowledgeBase());
    expect(boxOf(page, "de")).toContain('data-state="checked"');
    expect(boxOf(page, "en")).toContain('data-state="checked"');
    expect(boxOf(page, "fr")).toContain('data-state="unchecked"');
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

describe("the room a first index or a re-index needs (KB-8)", () => {
  const statement = {
    bindingId: "embed-eu",
    model: "text-embedding-3-large",
    chunks: 1_200,
    tokens: 480_000,
    room: false,
    storeBytes: 900_000_000,
    addedBytes: 200_000_000,
    limitBytes: 1_000_000_000,
    confirmation: "a".repeat(64)
  };
  const shown = (first: boolean) =>
    renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "en",
        children: createElement(ReindexStatement, { statement, locale: "en", first })
      })
    );

  // fix (KB-8 leftovers): the first index's no-room line names one index.
  it("names both indexes only for a re-index beside the active one", () => {
    expect(shown(true)).not.toContain("both indexes");
    expect(shown(false)).toContain("both indexes");
  });
});

// ACCEPT-FIX-10 C3: the help under "Verwenden" on a Knowledge Base spoke of "Zeilen" and the
// "Datenspeicher" behind it, also for a Knowledge Base of documents.
describe("the help under the use right of a Knowledge Base", () => {
  it.each([
    { locale: "en" as const, never: [/\brows?\b/iu, /data store/iu] },
    { locale: "de" as const, never: [/Zeile/iu, /Datenspeicher/iu] }
  ])("speaks of documents and not of rows or a data store ($locale)", ({ locale, never }) => {
    const help = createTranslationContext(locale).t(
      required(rightSentenceKeys["knowledge_base.use"])
    );
    for (const word of never) expect(help).not.toMatch(word);
  });
});
