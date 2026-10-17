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
  type BuildAsset,
  type BuildSource,
  type KnowledgeBaseSource,
  type KnowledgeBaseState,
  type KnowledgeDocument,
  type KnowledgeRead
} from "@work-shape/catalyst-chat-ui/build-area";
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
  useDataStores: () => ready([{ name: "findings", title: "Findings store" }]),
  useStoreTables: () => ready(["findings", "runs"]),
  useKnowledgeBases: () => ready([]),
  useDocuments: () => ready({ documents: [handbookDocument] }),
  retry: async () => ({ ok: true, data: {} }),
  remove: async () => ({ ok: true, data: {} }),
  addFiles: async () => ({ ok: true, data: { count: 1 } }),
  useOpenableFiles: () => ready([])
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
    locale = "en"
  }: { newAsset?: boolean; state?: KnowledgeBaseState; locale?: "en" | "de" } = {}
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
  const planted = knowledgeBaseKindOn(() => ({ ...source, useState: () => ready(state) }));
  const kinds = buildAssetKinds.map((kind) => (kind.kind === "knowledge_base" ? planted : kind));
  return renderToStaticMarkup(
    createElement(
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
          createElement(BuildFrame, { source: frame })
        )
      )
    )
  );
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

  it("asks for a publish before it shows a check or a test query", () => {
    const page = render(knowledgeBase({ revision: 1 }));

    expect(page).toContain(">Not published<");
    expect(page).not.toContain("data-knowledge-state");
    expect(page).toContain("Publish the knowledge base to see whether it can read its tables");
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

  it("starts a new Knowledge Base with the choice of documents or tables, documents chosen", () => {
    try {
      requestBuildStart("knowledge-bases", { name: "contracts-kb", title: "Contracts" });
      const page = render(documentsKnowledgeBase(), { newAsset: true });

      expect(page).toContain('role="radiogroup"');
      const checked = /<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*>/u.exec(page)?.[0];
      const label = checked ? /aria-labelledby="([^"]+)"/u.exec(checked)?.[1] : undefined;
      expect(label).toBeDefined();
      expect(page).toContain(`id="${label}" class="text-label">Documents<`);
      expect(page).toContain("Tables of a data store");
      expect(page).not.toContain("Choose a data store");
      expect(page).toContain("Publish the knowledge base to see its status and to add documents.");
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
