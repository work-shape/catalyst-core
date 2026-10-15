import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  agentConfigToForm,
  agentFormToConfig,
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  knowledgeBaseKindOn,
  resolveBuildRights,
  type BuildAsset,
  type BuildSource,
  type KnowledgeBaseSource,
  type KnowledgeBaseState,
  type KnowledgeRead
} from "@vivd-catalyst/chat-ui/build-area";
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

const source: KnowledgeBaseSource = {
  useState: () => ready(needsAttention),
  check: async () => ({ ok: true, data: needsAttention }),
  query: async () => ({ ok: false, refused: false, message: undefined }),
  useDataStores: () => ready([{ name: "findings", title: "Findings store" }]),
  useStoreTables: () => ready(["findings", "runs"]),
  useKnowledgeBases: () => ready([])
};

function render(asset: BuildAsset): string {
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
      delete: async () => undefined,
      publish: async () => ({ draftRevision: 1, publishedRevision: 1 }),
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    }
  };
  const planted = knowledgeBaseKindOn(() => source);
  const kinds = buildAssetKinds.map((kind) => (kind.kind === "knowledge_base" ? planted : kind));
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" },
      createElement(
        BuildAssetKindsProvider,
        { value: kinds },
        createElement(
          BuildNavigationProvider,
          {
            value: {
              location: { kindPath: "knowledge-bases", name: asset.name },
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
  });

  it("asks for a publish before it shows a check or a test query", () => {
    const page = render(knowledgeBase({ revision: 1 }));

    expect(page).toContain(">Not published<");
    expect(page).not.toContain("data-knowledge-state");
    expect(page).toContain("Publish the knowledge base to see whether it can read its tables");
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
