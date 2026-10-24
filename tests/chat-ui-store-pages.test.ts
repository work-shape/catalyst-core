// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { editWithBuildingAgent } from "@work-shape/catalyst-chat-ui/agents";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  dataStoreKindOn,
  knowledgeBaseKindOn,
  resolveBuildRights,
  useBuildSource,
  type BuildAsset,
  type BuildSource,
  type DataStoreListed,
  type DataStoreSource,
  type DataStoreState,
  type DataStoreUsedBy,
  type KnowledgeBaseSource,
  type KnowledgeBaseState,
  type KnowledgeDocumentSummary,
  type KnowledgeHoldersRead,
  type KnowledgeRead
} from "@work-shape/catalyst-chat-ui/build-area";
import {
  DockPageChatProvider,
  type DockPageChat
} from "@work-shape/catalyst-chat-ui/dock-page-chat";
import { SettingsPageProvider } from "@work-shape/catalyst-chat-ui/settings-page-context";
import { assetPageRoute } from "@work-shape/catalyst-chat-ui/subject-run";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { platformContext } from "./chat-ui-build-fixtures";
import { buildPageSettings, listedKind } from "./chat-ui-build-page-harness";
import { TranslationProvider } from "./chat-ui-render-harness";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import { workspaceQueryKeys } from "./support/chat-ui";

// STORE-PAGES: the pages of a Data Store and of a Knowledge Base in Build. A published store
// with a later draft publishes it with its SQL shown, Delete sits in the head's menu behind a
// question that names the store, "Edit with the agent" opens a conversation with the agent
// that builds, and the pages and lists say who uses each store.

const noop = () => undefined;

function ready<Answer>(data: Answer): { status: "ready"; data: Answer } {
  return { status: "ready", data };
}

const migrations = [
  { number: 1, name: "init", sha256: "0".repeat(64), sql: "create table leads (id int);" },
  { number: 2, name: "add_email", sha256: "1".repeat(64), sql: "alter table leads add email text;" }
];

/** A store never published, its two migrations in its draft. */
const draft: BuildAsset = {
  id: "asset_leads",
  kind: "data_store",
  name: "leads",
  scope: { kind: "workspace", workspaceId: "ws_1" },
  revision: 1,
  draftRevision: 1,
  config: { name: "leads", title: "Leads", migrations },
  updatedAt: "2026-10-18T10:00:00.000Z"
};

/** Published at level 1, with a later draft that adds migration 2. */
const ahead: BuildAsset = { ...draft, revision: 3, draftRevision: 3, publishedRevision: 2 };

/** Published, with no draft ahead. */
const published: BuildAsset = { ...draft, revision: 2, draftRevision: 2, publishedRevision: 2 };

const state: DataStoreState = {
  id: "asset_leads",
  name: "leads",
  status: "ready",
  level: 1,
  publishedLevel: 1,
  size: { limitBytes: 500 * 1024 ** 2, nearLimit: false },
  conditions: [],
  lastMigration: { outcome: "applied", migration: { number: 1, name: "init" } }
};

const usedBy: DataStoreUsedBy = {
  agents: [
    {
      id: "asset_scout",
      name: "scout",
      title: "Lead scout",
      reads: true,
      writes: true,
      sources: []
    }
  ],
  apps: [],
  workflows: [],
  knowledgeBases: [],
  readers: { holders: [], hiddenHolders: 0 },
  hidden: { agents: 2, apps: 0, workflows: 0, knowledgeBases: 0, fills: 0, reads: 0 },
  truncated: false
};

function storeSource(answers: { listed?: DataStoreListed; usedBy?: DataStoreUsedBy } = {}) {
  const source: DataStoreSource = {
    seesServerConditions: false,
    useStoreState: () => ready(state),
    useSchema: () => ({ status: "loading" }),
    useListed: () => (answers.listed === undefined ? { status: "loading" } : ready(answers.listed)),
    useRowsPage: () => ({ status: "loading" }),
    useValue: () => ({ status: "loading" }),
    useUsedBy: () => (answers.usedBy === undefined ? { status: "loading" } : ready(answers.usedBy)),
    useUsingPage: () => () => undefined
  };
  return source;
}

const knowledgeState: KnowledgeBaseState = {
  id: "asset_handbook",
  name: "handbook-kb",
  status: "ok",
  revision: 2,
  checkedAt: "2026-10-13T09:00:00.000Z",
  tables: [],
  documentFormats: ["txt", "markdown"],
  agents: [{ name: "helpdesk", title: "Helpdesk" }],
  agentsTruncated: true
};

/** A Knowledge Base that keeps documents, published. */
const handbook: BuildAsset = {
  id: "asset_handbook",
  kind: "knowledge_base",
  name: "handbook-kb",
  scope: { kind: "instance" },
  revision: 2,
  publishedRevision: 2,
  draftRevision: 2,
  config: { name: "handbook-kb", title: "Handbook", methods: ["keyword"] },
  updatedAt: "2026-10-17T10:00:00.000Z"
};

function knowledgeSource(
  answers: {
    state?: KnowledgeBaseState;
    summary?: KnowledgeRead<KnowledgeDocumentSummary | null>;
    holders?: KnowledgeHoldersRead;
    summaryReads?: string[];
  } = {}
): KnowledgeBaseSource {
  return {
    useState: () => ready(answers.state ?? knowledgeState),
    check: async () => ({ ok: true, data: knowledgeState }),
    query: async () => ({ ok: false, refused: false, message: undefined }),
    search: async () => ({ ok: false, refused: false, message: undefined }),
    useDataStores: () => ready({ items: [] }),
    useStoreTables: () => ready([]),
    useKnowledgeBases: () => ready({ items: [] }),
    useDocuments: () => ready({ documents: [] }),
    retry: async () => ({ ok: true, data: {} }),
    remove: async () => ({ ok: true, data: {} }),
    addFiles: async () => ({ ok: true, data: { count: 1 } }),
    uploadFile: async () => ({ ok: true, data: { count: 1 } }),
    useOpenableFiles: () => ready({ items: [] }),
    useHolders: () => answers.holders ?? { status: "hidden" },
    useDocumentSummary: (knowledgeBase, enabled) => {
      if (enabled) answers.summaryReads?.push(knowledgeBase);
      return enabled
        ? (answers.summary ?? ready({ count: 3, state: "indexed" }))
        : { status: "loading" };
    }
  };
}

interface MountInput {
  /** The kind's page or its list. */
  list?: true;
  locale?: "en" | "de";
  /** What the reader may do to the asset, as the instance sends it: all of it unless given. */
  allowed?: NonNullable<BuildAsset["allowed"]>;
  canDelete?: boolean;
  editWithAgent?: BuildSource["editWithAgent"];
  /** The workspaces whose assets the reader holds a right on: the reader's own unless given. */
  workspaces?: BuildSource["rights"]["workspaces"];
  publish?: (input: { revision: number }) => void;
  remove?: (input: { expectedRevision?: number }) => void;
  stores?: DataStoreSource;
  knowledge?: KnowledgeBaseSource;
  opened?: unknown[];
}

const unmounts: (() => void)[] = [];

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) unmount();
  vi.unstubAllGlobals();
});

async function mount(asset: BuildAsset, input: MountInput = {}): Promise<HTMLElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const shown: BuildAsset = {
    ...asset,
    allowed: input.allowed ?? ["write", "publish", "delete"]
  };
  const source: BuildSource = {
    kinds: [{ kind: asset.kind, canCreate: true, canDelete: input.canDelete ?? true }],
    rights: {
      ...resolveBuildRights({ permissions: ["config_assets.write"] }, platformContext()),
      workspaces: input.workspaces ?? [{ id: "ws_1", name: "Mine", member: true, personal: true }]
    },
    loading: false,
    error: undefined,
    reload: async () => undefined,
    useList: () => ({
      rows: [{ ...shown, title: asset.kind === "data_store" ? "Leads" : "Handbook" }],
      error: undefined,
      hasMore: false,
      loadingMore: false,
      loadMore: noop,
      retry: noop
    }),
    useAsset: () => ({ status: "ready", asset: shown, loadedAt: 1, reload: async () => "loaded" }),
    exists: async () => true,
    checkName: async () => ({ available: true }),
    writes: {
      put: async () => ({ revision: 1 }),
      readFiles: async () => [],
      delete: async (call) => {
        input.remove?.(call);
      },
      publish: async (call) => {
        input.publish?.(call);
        return { draftRevision: call.revision, publishedRevision: call.revision };
      },
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    },
    ...(input.editWithAgent === undefined ? {} : { editWithAgent: input.editWithAgent })
  };
  const stores = dataStoreKindOn(() => input.stores ?? storeSource());
  const knowledge = knowledgeBaseKindOn(() => input.knowledge ?? knowledgeSource());
  const kinds = buildAssetKinds.map((kind) =>
    kind.kind === "data_store" ? stores : kind.kind === "knowledge_base" ? knowledge : kind
  );
  const kindPath = asset.kind === "data_store" ? "data-stores" : "knowledge-bases";
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { locale: input.locale ?? "en", children: null },
          createElement(
            BuildAssetKindsProvider,
            { value: kinds },
            createElement(
              BuildNavigationProvider,
              {
                value: {
                  location: input.list ? { kindPath } : { kindPath, name: asset.name },
                  open: (place) => input.opened?.push(place),
                  href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
                }
              },
              createElement(
                DockPageChatProvider,
                { value: (chat) => pageChats.set(container, chat) },
                createElement(BuildFrame, { source })
              )
            )
          )
        )
      )
    );
  });
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
    pageChats.delete(container);
  });
  return container;
}

/** Opens the head's "…" menu and answers its items. */
async function openMenu(container: ParentNode): Promise<HTMLElement[]> {
  const trigger = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${uiLabelsEn.moreActions}"]`
  );
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  let items: HTMLElement[] = [];
  await vi.waitFor(
    () => {
      const menu = document.getElementById(trigger?.getAttribute("aria-controls") ?? "");
      items = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      expect(items.length).toBeGreaterThan(0);
    },
    { timeout: CONDITION_WAIT_MS }
  );
  return items;
}

/** The confirm button of the open dialog. */
function confirmOfDialog(label: string): HTMLButtonElement | undefined {
  return [...(document.querySelector("dialog[open]")?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent?.trim() === label
  );
}

/** What each mounted page offers the page head's "Chat": its conversation with the agent. */
const pageChats = new Map<HTMLElement, DockPageChat | undefined>();

/**
 * The page head's "Chat" as the page offers it, once the page shows its asset: pressing it
 * starts the page's conversation. Nothing where the page offers none.
 */
async function editWithAgentControl(
  container: HTMLElement
): Promise<{ click(): Promise<boolean | void> } | undefined> {
  await vi.waitFor(() => expect(container.querySelector("h1")).not.toBeNull(), {
    timeout: CONDITION_WAIT_MS
  });
  await act(async () => undefined);
  const chat = pageChats.get(container);
  return chat && { click: () => chat.start({ fresh: false }) };
}

describe("publishing a Data Store's later draft", () => {
  it("lists only the migrations past the published level, with their SQL, and publishes on the confirm", async () => {
    const publish = vi.fn();
    const page = await mount(ahead, { publish });

    const pending = page.querySelector("[data-data-store-pending]");
    expect(pending).not.toBeNull();
    const numbers = [...(pending?.querySelectorAll("[data-data-store-migration]") ?? [])].map(
      (row) => row.getAttribute("data-data-store-migration")
    );
    expect(numbers).toEqual(["2"]);
    expect(pending?.querySelector("[data-data-store-migration-sql]")?.textContent).toContain(
      "alter table leads add email text;"
    );
    expect(pending?.textContent).not.toContain("create table leads");

    await act(async () =>
      page.querySelector<HTMLButtonElement>("[data-data-store-publish]")?.click()
    );
    expect(publish).not.toHaveBeenCalled();
    expect(document.querySelector("[data-data-store-publish-confirm]")?.textContent).toContain(
      "1 new migration"
    );
    await act(async () => confirmOfDialog("Publish")?.click());
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ revision: 3 }));
  });

  it("offers no publish where the draft is the published revision", async () => {
    const page = await mount(published);
    expect(page.querySelector("[data-data-store-pending]")).toBeNull();
    expect(page.querySelector("[data-data-store-publish]")).toBeNull();
  });

  it("shows the SQL of every migration on the page of a store never published", async () => {
    const page = await mount(draft);
    const sql = [...page.querySelectorAll("[data-data-store-migration-sql]")].map(
      (block) => block.textContent ?? ""
    );
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain("create table leads (id int);");
    expect(sql[1]).toContain("alter table leads add email text;");
    // The file names stand on their own, as the first-save spec reads them.
    expect(
      [...page.querySelectorAll("[data-data-store-draft-migration]")].map(
        (name) => name.textContent
      )
    ).toEqual(["0001_init.sql", "0002_add_email.sql"]);
  });

  it("says in German what the publish applies", async () => {
    const page = await mount(ahead, { locale: "de" });
    expect(page.querySelector("[data-data-store-pending]")?.textContent).toContain("Migration");
    await act(async () =>
      page.querySelector<HTMLButtonElement>("[data-data-store-publish]")?.click()
    );
    expect(document.querySelector("[data-data-store-publish-confirm]")?.textContent).not.toBe("");
    expect(confirmOfDialog("Veröffentlichen")).toBeDefined();
  });
});

describe("deleting a Data Store", () => {
  it("asks with the store's name and deletes through the frame with the revision read", async () => {
    const remove = vi.fn();
    const opened: unknown[] = [];
    const page = await mount(published, { remove, opened });

    const item = (await openMenu(page)).find((entry) => entry.textContent?.trim() === "Delete");
    expect(item).toBeDefined();
    await act(async () => item?.click());
    expect(remove).not.toHaveBeenCalled();
    expect(document.querySelector("dialog")?.textContent).toContain("Leads");
    expect(document.querySelector("[data-data-store-delete-confirm]")?.textContent).not.toBe("");

    await act(async () => confirmOfDialog("Delete")?.click());
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "data_store", name: "leads", expectedRevision: 2 })
    );
    // The list of stores opens in place of the page.
    expect(opened).toContainEqual({ kindPath: "data-stores" });
  });

  it("is offered on the page of a store never published too", async () => {
    const page = await mount(draft);
    expect((await openMenu(page)).some((entry) => entry.textContent?.trim() === "Delete")).toBe(
      true
    );
  });

  it("is not offered without the delete right on the store, or where the kind deletes nothing", async () => {
    const refused = await mount(published, { allowed: ["write", "publish"] });
    expect((await openMenu(refused)).some((entry) => entry.textContent?.trim() === "Delete")).toBe(
      false
    );
    for (const unmount of unmounts.splice(0)) unmount();

    const kindless = await mount(published, { canDelete: false });
    expect((await openMenu(kindless)).some((entry) => entry.textContent?.trim() === "Delete")).toBe(
      false
    );
  });
});

describe("Chat on a store's page", () => {
  it("starts a conversation about the Data Store with the reader who may change it", async () => {
    const editWithAgent = vi.fn(async () => undefined);
    const page = await mount(published, { editWithAgent });
    const control = await editWithAgentControl(page);
    expect(control).toBeDefined();
    await act(async () => control?.click());
    expect(editWithAgent).toHaveBeenCalledWith({ kind: "data_store", name: "leads" }, "ws_1", {
      fresh: false
    });
  });

  it("starts it in the workspace that owns the store, whichever workspace is open", async () => {
    const editWithAgent = vi.fn(async () => undefined);
    const team: BuildAsset = { ...published, scope: { kind: "workspace", workspaceId: "ws_team" } };
    const page = await mount(team, {
      editWithAgent,
      workspaces: [
        { id: "ws_1", name: "Mine", member: true, personal: true },
        { id: "ws_team", name: "Team", member: true }
      ]
    });
    await act(async () => (await editWithAgentControl(page))?.click());
    expect(editWithAgent).toHaveBeenCalledWith({ kind: "data_store", name: "leads" }, "ws_team", {
      fresh: false
    });
  });

  it("is absent where the reader is no member of the workspace that owns the store", async () => {
    const editWithAgent = vi.fn(async () => undefined);
    const team: BuildAsset = { ...published, scope: { kind: "workspace", workspaceId: "ws_team" } };
    const page = await mount(team, {
      editWithAgent,
      workspaces: [{ id: "ws_team", name: "Team", member: false }]
    });
    expect(await editWithAgentControl(page)).toBeUndefined();
  });

  it("starts one about the Knowledge Base", async () => {
    const editWithAgent = vi.fn(async () => undefined);
    const page = await mount(handbook, { editWithAgent });
    const control = await editWithAgentControl(page);
    expect(control).toBeDefined();
    await act(async () => control?.click());
    // The instance owns it: the conversation belongs to the open workspace.
    expect(editWithAgent).toHaveBeenCalledWith(
      { kind: "knowledge_base", name: "handbook-kb" },
      undefined,
      { fresh: false }
    );
  });

  it("starts the Knowledge Base's in the workspace that owns it", async () => {
    const editWithAgent = vi.fn(async () => undefined);
    const team: BuildAsset = { ...handbook, scope: { kind: "workspace", workspaceId: "ws_team" } };
    const page = await mount(team, {
      editWithAgent,
      workspaces: [{ id: "ws_team", name: "Team", member: true }]
    });
    await act(async () => (await editWithAgentControl(page))?.click());
    expect(editWithAgent).toHaveBeenCalledWith(
      { kind: "knowledge_base", name: "handbook-kb" },
      "ws_team",
      { fresh: false }
    );
  });

  it("is absent without an agent that builds, and for a reader who may not change the asset", async () => {
    expect(await editWithAgentControl(await mount(published))).toBeUndefined();
    expect(await editWithAgentControl(await mount(handbook))).toBeUndefined();
    const editWithAgent = vi.fn(async () => undefined);
    expect(
      await editWithAgentControl(await mount(published, { editWithAgent, allowed: [] }))
    ).toBeUndefined();
  });

  it("says a refusal in a dialog", async () => {
    const editWithAgent = vi.fn(async () => {
      throw new ApiError(404, "gone", { error: { code: "NOT_FOUND", message: "gone" } });
    });
    const page = await mount(published, { editWithAgent });
    await act(async () => (await editWithAgentControl(page))?.click());
    await vi.waitFor(
      () =>
        expect(
          document.querySelector("dialog[open] [data-build-edit-with-agent-refused]")
        ).not.toBeNull(),
      { timeout: CONDITION_WAIT_MS }
    );
  });
});

describe("who uses a Data Store", () => {
  it("names the agents that carry its row tools, each a link, and counts those not shown", async () => {
    const page = await mount(published, { stores: storeSource({ usedBy }) });
    const agent = page.querySelector('[data-data-store-agent="scout"]');
    expect(agent?.textContent).toContain("Lead scout");
    expect(agent?.querySelector("a")?.getAttribute("href")).toBe("/build/agents/scout");
    expect(page.textContent).toContain("2");
  });

  it("names on the list the Apps that use each store, from the list's own read", async () => {
    const listed: DataStoreListed = {
      items: [
        {
          id: "asset_leads",
          name: "leads",
          title: "Leads",
          status: "ready",
          level: 1,
          sizeLimitBytes: 500 * 1024 ** 2,
          apps: [{ name: "board", title: "Lead board" }]
        }
      ],
      truncated: false
    };
    const page = await mount(published, { list: true, stores: storeSource({ listed }) });
    expect(page.querySelector("[data-data-store-row-apps]")?.textContent).toContain("Lead board");
  });

  it("names no App on the list where the list sends none, whatever another read says", async () => {
    const listed: DataStoreListed = {
      items: [
        {
          id: "asset_leads",
          name: "leads",
          title: "Leads",
          status: "ready",
          level: 1,
          sizeLimitBytes: 500 * 1024 ** 2
        }
      ],
      truncated: false
    };
    const apps: DataStoreUsedBy = {
      ...usedBy,
      apps: [
        {
          id: "asset_board",
          name: "board",
          title: "Lead board",
          reads: true,
          writes: false,
          sources: [],
          audience: { holders: [], hiddenHolders: 0 }
        }
      ]
    };
    const page = await mount(published, {
      list: true,
      stores: storeSource({ listed, usedBy: apps })
    });
    expect(page.querySelector("[data-data-store-row-apps]")).toBeNull();
  });
});

describe("who uses a Knowledge Base", () => {
  it("names the agents of its state read, each a link, and says the list is partial", async () => {
    const page = await mount(handbook);
    const agent = page.querySelector('[data-knowledge-agent="helpdesk"]');
    expect(agent?.textContent).toContain("Helpdesk");
    expect(agent?.querySelector("a")?.getAttribute("href")).toBe("/build/agents/helpdesk");
    expect(page.querySelector("[data-knowledge-agents-truncated]")).not.toBeNull();
  });

  it("names those given knowledge_base.use, and has no such section for a reader not shown them", async () => {
    const holders: KnowledgeHoldersRead = {
      status: "ready",
      holders: [
        {
          kind: "person",
          grantId: "g_1",
          id: "u_mara",
          name: "Mara Klein",
          detail: "mara@example.com",
          disabled: false
        }
      ]
    };
    const page = await mount(handbook, { knowledge: knowledgeSource({ holders }) });
    expect(page.querySelector('[data-holder-kind="person"]')?.textContent).toContain("Mara Klein");
    for (const unmount of unmounts.splice(0)) unmount();

    const hidden = await mount(handbook);
    expect(hidden.querySelector("[data-holder-kind]")).toBeNull();
    expect(hidden.textContent).not.toContain("Additional use rights");
  });
});

describe("a Knowledge Base on the list", () => {
  it("says how many documents it holds and when the last was ingested", async () => {
    const summaryReads: string[] = [];
    const page = await mount(handbook, {
      list: true,
      knowledge: knowledgeSource({
        summaryReads,
        summary: ready({ count: 12, state: "indexed", lastIngestedAt: "2026-10-17T09:00:00.000Z" })
      })
    });
    const facts = page.querySelector('[data-knowledge-row-documents="handbook-kb"]');
    expect(facts?.textContent).toContain("12 documents");
    expect(facts?.textContent).toContain("Last ingested");
    // A list moment has no seconds.
    expect(facts?.textContent).not.toMatch(/\d:\d\d:\d\d/u);
    expect(facts?.textContent).not.toContain("—");
    expect(summaryReads).toContain("handbook-kb");
    expect(page.querySelector("[data-knowledge-row-state]")).toBeNull();
  });

  it("shows a dash where the summary is refused or not sent, and the ingestion's state", async () => {
    const refused = await mount(handbook, {
      list: true,
      knowledge: knowledgeSource({ summary: { status: "failed", message: undefined, retry: noop } })
    });
    expect(refused.querySelector("[data-knowledge-row-documents]")?.textContent).toContain(
      "— documents"
    );
    for (const unmount of unmounts.splice(0)) unmount();

    const failing = await mount(handbook, {
      list: true,
      knowledge: knowledgeSource({ summary: ready({ count: 2, state: "failed" }) })
    });
    expect(
      failing.querySelector("[data-knowledge-row-state]")?.getAttribute("data-knowledge-row-state")
    ).toBe("ingestion-failed");
  });

  it("reads no documents of one that answers from tables", async () => {
    const summaryReads: string[] = [];
    const structured: KnowledgeBaseState = {
      id: "asset_handbook",
      name: "handbook-kb",
      status: "ok",
      revision: 2,
      checkedAt: "2026-10-13T09:00:00.000Z",
      tables: []
    };
    const page = await mount(handbook, {
      list: true,
      knowledge: knowledgeSource({ state: structured, summaryReads })
    });
    expect(page.querySelector("[data-knowledge-row-documents]")).toBeNull();
    expect(summaryReads).toEqual([]);
  });
});

describe("the agent that edits an asset", () => {
  it("is the agent that builds, chosen before the conversation about the asset starts", async () => {
    const calls: string[] = [];
    const start = editWithBuildingAgent(
      "builder",
      (name) => calls.push(`select ${name}`),
      async (subject, workspaceId) => {
        calls.push(`start ${subject.kind}/${subject.name} in ${workspaceId ?? "the open one"}`);
      }
    );
    await start?.({ kind: "data_store", name: "leads" }, "ws_team");
    expect(calls).toEqual(["select builder", "start data_store/leads in ws_team"]);
  });

  it("is absent where no agent builds assets: the Build Agent's Module is off", () => {
    expect(editWithBuildingAgent(undefined, noop, async () => undefined)).toBeUndefined();
  });

  it("opens the dock beside the Knowledge Base's page", () => {
    expect(assetPageRoute({ kind: "knowledge_base", name: "handbook-kb" }, "w1")).toEqual({
      kind: "build-asset",
      assetKind: "knowledge-bases",
      name: "handbook-kb"
    });
  });
});

describe("what a Data Store's publish reads again", () => {
  /** Build's own source against an instance that publishes every revision it is asked to. */
  async function publishThrough(kind: string, queryClient: QueryClient): Promise<void> {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const publishPath = apiOperations["assets.publish"].path
      .replace(":kind", kind)
      .replace(":name", "leads");
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === apiOperations["platform.context.get"].path) {
        return Response.json(platformContext());
      }
      if (request.method === "POST" && url.pathname === publishPath) {
        return Response.json({ draftRevision: 3, publishedRevision: 3 });
      }
      return Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
    };
    let source: BuildSource | undefined;
    function Capture() {
      source = useBuildSource();
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(SettingsPageProvider, {
            value: buildPageSettings(fetchImpl),
            children: createElement(Capture)
          })
        )
      );
    });
    await act(async () => {
      await source?.writes.publish({ kind, name: "leads", revision: 3 });
    });
    await act(async () => root.unmount());
  }

  /** The store's reads, each settled as if read before the publish. */
  function settledStoreReads(apiBaseUrl: string): QueryClient {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const part of ["state", "list", "schema", "rows"]) {
      queryClient.setQueryData([...workspaceQueryKeys.dataStores(apiBaseUrl), part, "leads"], {});
    }
    return queryClient;
  }

  const apiBaseUrl = buildPageSettings(async () => new Response(null)).apiBaseUrl;

  it("reads the store's state, list, schema and rows again after its publish", async () => {
    const queryClient = settledStoreReads(apiBaseUrl);
    await publishThrough("data_store", queryClient);
    const stale = queryClient
      .getQueryCache()
      .findAll({ queryKey: workspaceQueryKeys.dataStores(apiBaseUrl) })
      .map((query) => query.state.isInvalidated);
    expect(stale).toEqual([true, true, true, true]);
  });

  it("reads none of them again after the publish of another kind", async () => {
    const queryClient = settledStoreReads(apiBaseUrl);
    await publishThrough("skill", queryClient);
    const stale = queryClient
      .getQueryCache()
      .findAll({ queryKey: workspaceQueryKeys.dataStores(apiBaseUrl) })
      .some((query) => query.state.isInvalidated);
    expect(stale).toBe(false);
  });
});

// Replaces e2e/store-pages.spec.ts "a Data Store's later draft is published, edited with the
// agent and deleted from its page" (its step "Another selection and back twice keeps the draft
// SQL and the state with their own store"): Build's own sources on one query client, moved
// between two stores' pages and back twice, show each page its own store's SQL alone.
describe("two Data Stores' pages on one query client", () => {
  const contactsMigrations = [
    { number: 1, name: "init", sha256: "2".repeat(64), sql: "create table contacts (id int);" },
    {
      number: 2,
      name: "add_phone",
      sha256: "3".repeat(64),
      sql: "alter table contacts add phone text;"
    }
  ];
  /** Never published: its page shows the SQL of each of its migrations. */
  const contacts: BuildAsset = {
    ...draft,
    id: "asset_contacts",
    name: "contacts",
    config: { name: "contacts", title: "Contacts", migrations: contactsMigrations }
  };
  const stores: Record<string, BuildAsset> = { leads: ahead, contacts };
  const context = {
    ...platformContext([], ["data_store.read", "data_store.write", "data_store.publish"]),
    kinds: [
      {
        kind: "data_store",
        plural: "data_stores",
        lifecycle: "draft_published" as const,
        representation: "files" as const,
        owners: ["instance" as const],
        actions: {
          read: "data_store.read",
          write: "data_store.write",
          publish: "data_store.publish",
          delete: "data_store.delete"
        }
      }
    ]
  };

  it("keeps each store's draft SQL on its own page, there and back twice", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === apiOperations["platform.context.get"].path) {
        return Response.json(context);
      }
      if (listedKind(request, url) === "data_store") {
        return Response.json({ items: Object.values(stores) });
      }
      const read = Object.values(stores).find(
        (store) =>
          url.pathname ===
          apiOperations["assets.get"].buildPath({
            params: { kind: "data_store", name: store.name }
          })
      );
      if (request.method === "GET" && read) return Response.json(read);
      if (
        url.pathname === apiOperations["data_stores.get"].buildPath({ params: { store: "leads" } })
      ) {
        return Response.json(state);
      }
      return Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
    };
    let go: (name: string) => void = noop;
    function Studio() {
      const [name, setName] = useState("leads");
      go = setName;
      return createElement(
        BuildNavigationProvider,
        {
          value: {
            location: { kindPath: "data-stores", name },
            open: noop,
            href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
          }
        },
        createElement(BuildFrame, { source: useBuildSource() })
      );
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    unmounts.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            SettingsPageProvider,
            { value: buildPageSettings(fetchImpl) },
            createElement(
              UiRoot,
              { mode: "light", labels: uiLabelsEn },
              createElement(
                TranslationProvider,
                { locale: "en", children: null },
                createElement(
                  BuildAssetKindsProvider,
                  { value: buildAssetKinds },
                  createElement(Studio)
                )
              )
            )
          )
        )
      );
    });
    /** The SQL the page shows, once it shows the store `title`. */
    const shownSql = async (title: string) => {
      await vi.waitFor(
        () => {
          expect(container.querySelector("h1")?.textContent).toContain(title);
          expect(container.querySelector("[data-data-store-migration-sql]")).not.toBeNull();
        },
        { timeout: CONDITION_WAIT_MS }
      );
      return [...container.querySelectorAll("[data-data-store-migration-sql]")]
        .map((sql) => sql.textContent ?? "")
        .join("\n");
    };

    for (let change = 0; change < 3; change++) {
      if (change > 0) await act(async () => go("leads"));
      const leads = await shownSql("Leads");
      // The publish applies the later migration alone.
      expect(required(container.querySelector("[data-data-store-pending]")).textContent).toContain(
        "alter table leads add email text;"
      );
      expect(leads).not.toContain("create table leads");
      expect(leads).not.toContain("contacts");
      if (change === 2) break;

      await act(async () => go("contacts"));
      const other = await shownSql("Contacts");
      expect(other).toContain("create table contacts (id int);");
      expect(other).toContain("alter table contacts add phone text;");
      expect(other).not.toContain("leads");
      // Never published, its first publish applies both of its own migrations.
      expect(required(container.querySelector("[data-data-store-pending]")).textContent).toContain(
        "create table contacts (id int);"
      );
    }
  });
});
