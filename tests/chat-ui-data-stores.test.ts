// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient, type LocaleCode } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  audienceLine,
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  dataStoreKindOn,
  dataStoreStateSettling,
  dataStoreStateView,
  DataStoreValueDialog,
  draftTablesOf,
  resolveBuildRights,
  useDataStoreSource,
  type BuildAsset,
  type BuildAssetRow,
  type BuildLocation,
  type BuildSource,
  type DataStoreFlaggedItem,
  groupFlagged,
  reviewValueOf,
  reviewValueText,
  type DataStoreListed,
  type DataStoreRead,
  type DataStoreRowsPage,
  type DataStoreSchema,
  type DataStoreSource,
  type DataStoreState,
  type DataStoreUsedBy,
  type DataStoreValue,
  usingPageRoute
} from "@work-shape/catalyst-chat-ui/build-area";
import { DockAgentWorkContext } from "@work-shape/catalyst-chat-ui/dock-page-chat";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import { platformContext } from "./chat-ui-build-fixtures";
import { mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import {
  mountPage,
  SETTINGS_INSTANCE_URL,
  settingsPageContext,
  settingsUser
} from "./chat-ui-settings-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The Data Store list and page against the answers of the contract (`data_stores.get`,
// `.describe`, `.list`, `.rows`, `.value`, `.used_by`), handed in where the instance's answers
// will stand.

const noop = () => undefined;
const MB = 1024 ** 2;

function storeState(name: string, overrides: Partial<DataStoreState> = {}): DataStoreState {
  return {
    id: `asset_${name}`,
    name,
    status: "ready",
    level: 2,
    publishedLevel: 2,
    size: {
      bytes: 8 * MB,
      measuredAt: "2026-10-12T03:00:00.000Z",
      limitBytes: 500 * MB,
      nearLimit: false
    },
    conditions: [],
    lastMigration: { outcome: "applied", migration: { number: 2, name: "add_referrer" } },
    ...overrides
  };
}

const schema: DataStoreSchema = {
  schemaLevel: 2,
  tables: [
    {
      name: "visits",
      rowEstimate: 1240,
      columns: [
        {
          name: "id",
          type: "integer",
          nativeType: "bigint",
          nullable: false,
          primaryKey: true
        },
        { name: "path", type: "text", nativeType: "text", nullable: false, primaryKey: false }
      ]
    },
    {
      name: "pages",
      rowEstimate: 0,
      columns: [
        { name: "path", type: "text", nativeType: "text", nullable: false, primaryKey: true }
      ]
    }
  ]
};

/** The first thousand characters of a note the instance cut. */
const CUT_NOTE = "A long note. ".repeat(77).slice(0, 1000);

const visitRows: DataStoreRowsPage = {
  table: "visits",
  columns: [
    { name: "id", type: "integer", nativeType: "bigint" },
    { name: "path", type: "text", nativeType: "text" },
    { name: "note", type: "text", nativeType: "text" },
    { name: "body", type: "other", nativeType: "bytea" }
  ],
  order: { by: "key", columns: ["id"] },
  rows: [
    {
      at: "at_1",
      values: { id: 1, path: "/pricing", note: CUT_NOTE, body: "" },
      cut: ["note", "body"]
    },
    { at: "at_2", values: { id: 2, path: "/docs", note: null, body: null } }
  ],
  next: "at_2",
  valueMaxChars: 1000
};

const usedBy: DataStoreUsedBy = {
  apps: [
    {
      id: "asset_visits_board",
      name: "visits-board",
      title: "Visits board",
      reads: true,
      writes: false,
      sources: [],
      audience: { workspace: { title: "Kai Spezis", members: 14 }, holders: [], hiddenHolders: 0 }
    }
  ],
  workflows: [
    {
      id: "asset_nightly",
      name: "nightly-rollup",
      title: "Nightly rollup",
      reads: false,
      writes: true,
      sources: [{ connection: "crm", title: "CRM" }],
      account: { name: "nightly-runner", title: "Nightly runner" }
    }
  ],
  knowledgeBases: [
    {
      id: "asset_visits_knowledge",
      name: "visits-knowledge",
      title: "Visits knowledge",
      audience: { holders: [], hiddenHolders: 0 }
    }
  ],
  readers: { holders: [], hiddenHolders: 2 },
  hidden: { apps: 1, workflows: 2, knowledgeBases: 0, fills: 1, reads: 2 },
  truncated: false
};

const nothingUses: DataStoreUsedBy = {
  apps: [],
  workflows: [],
  knowledgeBases: [],
  readers: { holders: [], hiddenHolders: 0 },
  hidden: { apps: 0, workflows: 0, knowledgeBases: 0, fills: 0, reads: 0 },
  truncated: false
};

function ready<Answer>(data: Answer): DataStoreRead<Answer> {
  return { status: "ready", data };
}

interface StoreAnswers {
  states?: Record<string, DataStoreRead<DataStoreState>>;
  schema?: DataStoreRead<DataStoreSchema>;
  rows?: DataStoreRead<DataStoreRowsPage>;
  listed?: DataStoreRead<DataStoreListed>;
  value?: DataStoreRead<DataStoreValue>;
  usedBy?: DataStoreRead<DataStoreUsedBy>;
  /** The reader is shown the pages of Workflows too, not only of Apps. */
  workflowPages?: boolean;
  review?: DataStoreSource["review"];
  /** The reader runs the database server. */
  seesServerConditions?: boolean;
  testCopy?: DataStoreSource["testCopy"];
}

function storeSource(answers: StoreAnswers = {}): DataStoreSource {
  return {
    seesServerConditions: answers.seesServerConditions ?? true,
    useStoreState: (store) => answers.states?.[store] ?? ready(storeState(store)),
    useSchema: () => answers.schema ?? ready(schema),
    useListed: () => answers.listed ?? ready({ items: [], truncated: false }),
    useRowsPage: () => answers.rows ?? ready(visitRows),
    useValue: () => answers.value ?? { status: "loading" },
    useUsedBy: () => answers.usedBy ?? ready(usedBy),
    // The instance's source decides this by `usingPageRoute`; here only the App has a page.
    useUsingPage: () => (kind, name) =>
      kind === "app"
        ? { href: `/w/ws_1/apps/${name}`, open: noop }
        : answers.workflowPages
          ? { href: `/w/ws_1/workflows/${name}`, open: noop }
          : undefined,
    review: answers.review ?? {
      useFlagged: () => ready({ items: [] }),
      decide: () => Promise.resolve(undefined)
    },
    testCopy: answers.testCopy ?? {
      reset: () => Promise.resolve(undefined),
      remove: () => Promise.resolve(undefined)
    }
  };
}

function storeRow(name: string, overrides: Partial<BuildAssetRow> = {}): BuildAssetRow {
  return {
    id: `asset_${name}`,
    kind: "data_store",
    name,
    title: name,
    scope: { kind: "instance" },
    revision: 1,
    updatedAt: "2026-10-08T10:00:00.000Z",
    ...overrides
  };
}

/** The records rule of a store whose objects are filled from documents (REC-2). */
const objektRule = {
  table: "objekt",
  key: { column: "objekt_nr", fromPath: "/Objekte/{objekt_nr}/" },
  precedence: [],
  review: { always: [] },
  retainWithoutSource: false
};

function storeAsset(name: string, records = false): BuildAsset {
  return {
    id: `asset_${name}`,
    kind: "data_store",
    name,
    scope: { kind: "instance" },
    revision: 2,
    config: {
      name,
      title: "Visit log",
      description: "Every visit of a page of the public site.",
      migrations: [],
      ...(records ? { records: [objektRule] } : {})
    },
    updatedAt: "2026-10-08T10:00:00.000Z"
  };
}

/** A store the agent's first save made: a draft and no published revision (NAV-2). */
function draftAsset(name: string): BuildAsset {
  const stored = storeAsset(name);
  return {
    ...stored,
    revision: 1,
    draftRevision: 1,
    scope: { kind: "workspace", workspaceId: "ws_1" },
    config: {
      ...stored.config,
      migrations: [
        { number: 1, name: "init", sha256: "0".repeat(64), sql: "create table visits ();" }
      ]
    }
  };
}

interface RenderInput extends StoreAnswers {
  list?: BuildAssetRow[];
  /** The page's store as a draft never published, with one migration. */
  draft?: boolean;
  /** The instance has the module on and the reader may read stores. */
  on?: boolean;
  /** The reader may create stores. */
  canCreate?: boolean;
  /** An agent here builds assets: New opens it with this text. */
  buildWithAgent?(prompt: string): void;
  /** Studio lists stores by owner, here the reader's Personal Workspace, behind a picker. */
  scoped?: boolean;
  /** The list has not answered yet. */
  listLoading?: boolean;
  /** What the agent in the dock is working on now. */
  agentWork?: { kind: string; name: string };
  locale?: LocaleCode;
  /** The store has a records rule over `objekt`. */
  records?: boolean;
  publish?: () => void;
}

/** The Build frame at an address, with the Data Store kind on fixed answers. */
function tree(location: BuildLocation, input: RenderInput = {}) {
  const context = platformContext();
  const source: BuildSource = {
    kinds: [
      { kind: "agent", canCreate: false, canDelete: false },
      ...(input.on === false
        ? []
        : [{ kind: "data_store", canCreate: input.canCreate ?? true, canDelete: true }])
    ],
    rights: {
      ...resolveBuildRights({ permissions: ["config_assets.write"] }, context),
      // ws_1 is the reader's Personal Workspace.
      workspaces: [{ id: "ws_1", name: "Mine", member: true, personal: true }]
    },
    loading: false,
    error: undefined,
    reload: async () => undefined,
    useList: (kind) => ({
      rows: kind !== "data_store" ? [] : input.listLoading ? undefined : (input.list ?? []),
      error: undefined,
      hasMore: false,
      loadingMore: false,
      loadMore: noop,
      retry: noop
    }),
    useAsset: (_kind, name) => ({
      status: "ready",
      asset: input.draft ? draftAsset(name) : storeAsset(name, input.records),
      loadedAt: 1,
      reload: async () => "loaded"
    }),
    ...(input.buildWithAgent ? { buildWithAgent: input.buildWithAgent } : {}),
    ...(input.scoped
      ? {
          scopeOf: () => ({ kind: "workspace" as const, workspaceId: "ws_1" }),
          chooseScope: noop
        }
      : {}),
    exists: async () => true,
    checkName: async () => ({ available: true }),
    writes: {
      put: async () => ({ revision: 1 }),
      readFiles: async () => [],
      delete: async () => undefined,
      publish: async () => {
        input.publish?.();
        return { draftRevision: 1, publishedRevision: 1 };
      },
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    }
  };
  const planted = dataStoreKindOn(() => storeSource(input));
  const kinds = buildAssetKinds.map((kind) => (kind.kind === "data_store" ? planted : kind));
  return createElement(
    DockAgentWorkContext.Provider,
    { value: input.agentWork },
    createElement(
      TranslationProvider,
      { children: null, locale: input.locale ?? "en" },
      createElement(
        BuildAssetKindsProvider,
        { value: kinds },
        createElement(
          BuildNavigationProvider,
          {
            value: {
              location,
              open: noop,
              href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
            }
          },
          createElement(BuildFrame, { source })
        )
      )
    )
  );
}

function render(location: BuildLocation, input: RenderInput = {}): string {
  return renderToStaticMarkup(tree(location, input));
}

const unmounts: (() => void)[] = [];

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) unmount();
  await unmountBuildPages();
  vi.unstubAllGlobals();
});

/** The same frame in the document, for what is clicked. */
async function mount(location: BuildLocation, input: RenderInput = {}): Promise<HTMLElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, tree(location, input))
    );
  });
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

const storePage = { kindPath: "data-stores", name: "visit-log" };
const storeList = { kindPath: "data-stores" };

describe("Data Stores in Build", () => {
  it("lists every store with a link to its page and its state, and its size only where measured", () => {
    const list = render(storeList, {
      list: [storeRow("visit-log"), storeRow("orders")],
      listed: ready({
        items: [
          {
            id: "asset_visit-log",
            name: "visit-log",
            title: "Visit log",
            status: "ready",
            level: 2,
            sizeBytes: 8 * MB,
            sizeLimitBytes: 500 * MB,
            tableCount: 2,
            rowEstimate: 1240,
            measuredAt: "2026-10-12T03:00:00.000Z"
          },
          {
            id: "asset_orders",
            name: "orders",
            title: "Orders",
            status: "ready",
            level: 1,
            sizeLimitBytes: 500 * MB
          }
        ],
        truncated: false
      }),
      states: {
        orders: ready(
          storeState("orders", {
            lastMigration: { outcome: "pending", migration: { number: 2, name: "add_total" } }
          })
        )
      }
    });
    expect(list).toContain('href="/build/data-stores/visit-log"');
    expect(list).toContain('data-data-store-row-state="ready"');
    expect(list).toContain('data-data-store-row-state="migrations_pending"');
    expect(list).toContain(">2 tables<");
    const orders = list.slice(list.indexOf('data-data-store-row-measured="orders"'));
    expect(orders).not.toContain("tables<");
    // Nothing is started here without an agent: a store is made by an agent or through the API.
    expect(list).not.toContain(">New ");
  });

  it("marks a row whose draft waits to be published, and drops the mark once published (T21)", () => {
    const rows = {
      waiting: storeRow("waiting", { revision: 3, draftRevision: 3, publishedRevision: 2 }),
      published: storeRow("published", { revision: 3, draftRevision: 3, publishedRevision: 3 }),
      // Never published: its own badge says so, not the draft-ahead one.
      fresh: storeRow("fresh", { revision: 1, draftRevision: 1 })
    };
    const list = render(storeList, { list: Object.values(rows) });
    const marked = (name: keyof typeof rows): boolean => {
      const row = list.slice(list.indexOf(`href="/build/data-stores/${name}"`));
      const next = row.indexOf('href="/build/data-stores/', 10);
      return (next < 0 ? row : row.slice(0, next)).includes("data-build-draft-state");
    };
    expect(marked("waiting")).toBe(true);
    expect(marked("published")).toBe(false);
    expect(marked("fresh")).toBe(false);
  });

  it("offers the agent on an empty list only to who may create, and New once there are stores", () => {
    const offer = ">Build one with the agent</button>";
    expect(render(storeList, { buildWithAgent: noop })).toContain(offer);
    for (const reader of [
      render(storeList),
      render(storeList, { canCreate: false, buildWithAgent: noop })
    ]) {
      expect(reader).not.toContain(offer);
      expect(reader).not.toContain(">New ");
    }
    const listed = render(storeList, { buildWithAgent: noop, list: [storeRow("orders")] });
    expect(listed).toContain("New data store");
    expect(listed).not.toContain(offer);
    // While the list loads, New stands: making one never waits for the answer.
    expect(render(storeList, { buildWithAgent: noop, listLoading: true })).toContain(
      "New data store"
    );
    expect(render(storeList, { scoped: true, buildWithAgent: noop })).toContain(offer);
    expect(render(storeList, { on: false })).not.toContain('value="data-stores"');
  });

  it("names what uses it, with a link only where the reader has a page", () => {
    const page = render(storePage);
    const line = page.slice(page.indexOf("data-data-store-used-by-line"));
    // A Knowledge Base stands as text: its reader may use it without being able to open it.
    expect(line).toContain(">Visits knowledge<");
    expect(line).not.toContain('href="/build/knowledge-bases/visits-knowledge"');
    expect(line).toMatch(/href="\/w\/ws_1\/apps\/visits-board"[^>]*>Visits board</u);
    expect(render(storePage, { usedBy: ready(nothingUses) })).not.toContain(
      "data-data-store-used-by-line"
    );
    // The page reads and changes nothing.
    expect(page).not.toContain(">Save<");
  });

  it("names a store that is not ready and what the server leaves open, and reads no table of it", () => {
    const failure = { code: "provisioning_failed", message: "The server refused CREATE DATABASE." };
    const page = render(storePage, {
      states: {
        "visit-log": ready(
          storeState("visit-log", {
            status: "provisioning",
            level: 0,
            conditions: [{ code: "sessions_open", message: "advice" }],
            lastMigration: { outcome: "failed", failure }
          })
        )
      },
      schema: { status: "failed", message: "must not be read", retry: noop }
    });
    expect(page).toContain('data-data-store-state="provisioning_failed"');
    expect(page).not.toContain("data-data-store-rows");
    expect(page).toContain("The server refused CREATE DATABASE.");
    expect(page).toContain('data-data-store-condition="sessions_open"');
    expect(page).not.toContain("must not be read");
  });
});

describe("A Data Store never published", () => {
  it("shows its draft with the migrations a publish applies, and Publish, and reads no state of it", () => {
    const markup = render(storePage, {
      draft: true,
      states: {
        "visit-log": { status: "failed", message: "Data Store is not available", retry: noop }
      }
    });
    expect(markup).toContain("data-data-store-draft");
    expect(markup).toContain("0001_init.sql");
    expect(markup).toContain("data-data-store-publish");
    expect(markup).not.toContain("Data Store is not available");
    expect(markup).not.toContain("data-data-store-state");
  });

  it("holds Publish back while the agent in the dock is still working on the store", () => {
    const working = render(storePage, {
      draft: true,
      agentWork: { kind: "data_store", name: "visit-log" }
    });
    expect(working).not.toContain("data-data-store-publish");
    expect(working).toContain("data-data-store-agent-working");
    const elsewhere = render(storePage, {
      draft: true,
      agentWork: { kind: "data_store", name: "orders" }
    });
    expect(elsewhere).toContain("data-data-store-publish");
  });

  it("reads each field of its draft tables from the migrations, as later ones change them", () => {
    const migration = (number: number, sql: string) => ({ number, name: `m${number}`, sql });
    const [results] = draftTablesOf([
      migration(
        1,
        `CREATE TABLE results (
          client_no text NOT NULL,
          status text NOT NULL CHECK (status IN ('checked','failed')),
          reason text,
          amount numeric(12, 2),
          PRIMARY KEY (client_no)
        );
        comment on column results.reason is 'Why a check failed';`
      )
    ]);
    const field = (name: string) => results?.fields.find((each) => each.name === name);
    expect(field("client_no")).toMatchObject({ primaryKey: true, nullable: false });
    expect(field("status")?.allowed).toEqual(["checked", "failed"]);
    expect(field("reason")).toMatchObject({ nullable: true, comment: "Why a check failed" });
    expect(field("amount")).toMatchObject({ type: "number", nativeType: "numeric(12, 2)" });

    const tables = draftTablesOf([
      migration(1, 'create table if not exists public."Leads" (id bigint primary key, name text);'),
      migration(2, 'alter table "Leads" add column email varchar(200) not null, drop column name;'),
      migration(
        3,
        'alter table "Leads" rename column email to mail; create table tmp (x int); drop table tmp;'
      )
    ]);
    expect(tables.map((table) => table.name)).toEqual(["Leads"]);
    expect(tables[0]?.fields.map((each) => each.name)).toEqual(["id", "mail"]);
    expect(draftTablesOf([migration(1, "create index on leads (name);")])).toEqual([]);
  });
});

describe("The rows of a Data Store", () => {
  it("pages a table with Next and Back to start, and has no Next on the last page", () => {
    const first = render(storePage);
    expect(first).toMatch(/<button[^>]*disabled=""[^>]*>Back to start<\/button>/u);
    expect(first).toMatch(/<button(?![^>]*disabled="")[^>]*>Next<\/button>/u);
    const last = render(storePage, { rows: ready({ ...visitRows, next: undefined }) });
    expect(last).toMatch(/<button[^>]*disabled=""[^>]*>Next<\/button>/u);
  });

  it("writes dates and column types the way the reader's language does, never as ISO text (ACCEPT-2e)", () => {
    const german = render(storePage, {
      locale: "de",
      rows: ready({
        ...visitRows,
        columns: [{ name: "frist", type: "date", nativeType: "date" }],
        rows: [{ at: "at_1", values: { frist: "2026-12-15" } }]
      }),
      schema: ready({
        ...schema,
        tables: [
          {
            name: "fristen",
            rowEstimate: 3,
            columns: [
              { name: "frist", type: "date", nativeType: "date", nullable: true, primaryKey: false }
            ]
          }
        ]
      })
    });
    expect(german).toContain(">15.12.2026<");
    expect(german).not.toContain("2026-12-15");
    const typeOf = german.slice(german.indexOf('data-data-store-column="frist"')).split("</tr>")[0];
    expect(typeOf).toContain(">Datum");
    expect(typeOf).not.toContain(">date<");
  });

  it("shows a cut value by its first characters and an unread one as not read, each with a way to read it whole", () => {
    const page = render(storePage);
    expect(page).toContain('data-data-store-cut="text"');
    expect(page).toContain(CUT_NOTE);
    expect(page).toContain('aria-label="Show the whole value of note"');
    expect(page).toContain('data-data-store-cut="unread"');
    expect(page).toContain('aria-label="Show the whole value of body"');
  });

  it("shows no rows the reader may not read, and offers a retry where they could not be read", () => {
    const refused = render(storePage, { rows: { status: "refused" } });
    expect(refused).toContain('data-data-store-refused=""');
    expect(refused).not.toContain("/pricing");
    expect(
      render(storePage, { rows: { status: "failed", message: undefined, retry: noop } })
    ).toContain(">Try again<");
  });

  it("opens a value whole, and says where the instance answers that it is too large or its row is gone", () => {
    const dialog = (value: DataStoreRead<DataStoreValue>) =>
      renderToStaticMarkup(
        createElement(
          TranslationProvider,
          { children: null, locale: "en" },
          createElement(DataStoreValueDialog, {
            store: "visit-log",
            place: { table: "visits", column: "note", at: "at_1" },
            source: storeSource({ value }),
            onClose: noop
          })
        )
      );
    const whole = "A long note. ".repeat(400);
    const shown = dialog(ready({ value: whole }));
    expect(shown).toContain('data-data-store-value="whole"');
    expect(shown).toContain(whole);
    const tooLarge = dialog({
      status: "failed",
      message: "x",
      reason: "value_too_large",
      retry: noop
    });
    expect(tooLarge).toContain('data-data-store-value="too_large"');
    expect(tooLarge).not.toContain("Try again");
    expect(dialog({ status: "failed", message: "x", reason: "row_gone", retry: noop })).toContain(
      'data-data-store-value="gone"'
    );
  });
});

describe("What uses a Data Store", () => {
  const section = (page: string, id: string) =>
    page.indexOf(`id="${id}"`) === -1
      ? undefined
      : (page.slice(page.indexOf(`id="${id}"`)).split("</section>")[0] ?? "");

  it("leads to the page of an App and of a Workflow only where the reader is shown such pages", () => {
    const shown = { collaborationWorkspaceId: "ws_1", apps: true, workflows: true };
    expect(usingPageRoute("app", "visits-board", shown)).toEqual({
      kind: "app",
      collaborationWorkspaceId: "ws_1",
      app: "visits-board"
    });
    expect(usingPageRoute("app", "visits-board", { ...shown, apps: false })).toBeUndefined();
    expect(
      usingPageRoute("workflow", "nightly-visits", { ...shown, workflows: false })
    ).toBeUndefined();
    expect(
      usingPageRoute("workflow", "nightly-visits", {
        ...shown,
        collaborationWorkspaceId: undefined
      })
    ).toBeUndefined();
  });

  it("puts what writes under Filled by and what reads under Read by, and counts what the reader may not see", () => {
    const page = render(storePage);
    const filled = required(section(page, "filled-by"));
    expect(filled).toContain(">Nightly rollup<");
    expect(filled).not.toContain("Visits board");
    expect(filled).toContain("and 1 more you can&#x27;t see");
    const read = required(section(page, "read-by"));
    expect(read).toContain('href="/w/ws_1/apps/visits-board"');
    expect(read).toContain('data-data-store-used-by="knowledge_base"');
    expect(read).not.toContain("Nightly rollup");
    expect(read).toContain("and 2 more you can&#x27;t see");
  });

  it("never says nothing fills a store that only hidden ones fill, and shows nothing to a reader refused", () => {
    const nothing = "No published workflow or app adds rows to this store.";
    expect(render(storePage, { usedBy: ready(nothingUses) })).toContain(nothing);
    const filledUnseen = render(storePage, {
      usedBy: ready({
        ...nothingUses,
        hidden: { apps: 1, workflows: 0, knowledgeBases: 0, fills: 1, reads: 0 }
      })
    });
    expect(filledUnseen).not.toContain(nothing);
    const refused = render(storePage, { usedBy: { status: "refused" } });
    expect(refused).not.toContain("Visits board");
  });

  it("counts agents in conversations as writers by numbers only, and never claims at least none (C-3)", () => {
    const written = (conversationWriters: DataStoreUsedBy["conversationWriters"]) =>
      ready<DataStoreUsedBy>({ ...nothingUses, conversationWriters });
    const filled = required(
      section(
        render(storePage, { usedBy: written({ agents: 1, conversations: 3, truncated: false }) }),
        "filled-by"
      )
    );
    expect(filled).toContain('data-data-store-conversation-writers=""');
    expect(filled).toContain(">1 agent in 3 conversations<");
    expect(
      render(storePage, { usedBy: written({ agents: 0, conversations: 0, truncated: false }) })
    ).not.toContain("data-data-store-conversation-writers");
    const cut = render(storePage, {
      usedBy: written({ agents: 0, conversations: 0, truncated: true })
    });
    expect(cut).toContain('data-data-store-conversation-writers=""');
    expect(cut).not.toContain("At least 0");
  });

  it("adds the data Workflows that fill it once each and those that process it, without double counting the hidden (WF-KIND)", () => {
    const flows = (dataFlows: DataStoreUsedBy["dataFlows"]) =>
      ready<DataStoreUsedBy>({ ...usedBy, dataFlows });
    const page = render(storePage, {
      workflowPages: true,
      usedBy: flows({
        fills: [
          { id: "asset_nightly", name: "nightly-rollup", title: "Nightly rollup" },
          { id: "asset_import", name: "visit-import", title: "Visit import" }
        ],
        processes: [{ id: "asset_extract", name: "visit-extract", title: "Visit extract" }],
        hidden: { fills: 3, processes: 2 },
        truncated: false
      })
    });
    const filled = required(section(page, "filled-by"));
    expect(filled.split(">Nightly rollup<").length - 1).toBe(1);
    expect(filled).toContain('href="/w/ws_1/workflows/visit-import"');
    // The store's own count already holds every hidden filler, data flows among them.
    expect(filled).toContain("and 1 more you can&#x27;t see");
    const processed = required(section(page, "processed-by"));
    expect(processed).toContain('href="/w/ws_1/workflows/visit-extract"');
    expect(processed).toContain("and 2 more you can&#x27;t see");
    const none = render(storePage, {
      usedBy: flows({
        fills: [],
        processes: [],
        hidden: { fills: 0, processes: 0 },
        truncated: false
      })
    });
    expect(section(none, "processed-by")).toBeUndefined();
  });

  it("names an App's audience as its publish named it, not by the workspace that owns it (E-2)", () => {
    const { t } = createTranslationContext("en");
    const personal = { title: "Personal workspace", members: 1 };
    expect(
      audienceLine(
        {
          app: { audience: "instance", people: 12 },
          workspace: personal,
          holders: [],
          hiddenHolders: 0
        },
        t,
        "en"
      )
    ).toBe("Everyone (12 people)");
    expect(
      audienceLine(
        {
          app: { audience: "self", people: 1 },
          workspace: personal,
          holders: [],
          hiddenHolders: 0
        },
        t,
        "en"
      )
    ).toBe("One selected person");
  });
});

describe("Data Store state", () => {
  it("names a store by one state and follows it only while it settles (E-1)", () => {
    expect(dataStoreStateView(storeState("a"))).toBe("ready");
    expect(dataStoreStateView(storeState("a", { lastMigration: { outcome: "failed" } }))).toBe(
      "migration_failed"
    );
    expect(dataStoreStateSettling(storeState("a", { status: "provisioning" }))).toBe(true);
    expect(dataStoreStateSettling(storeState("a", { lastMigration: { outcome: "pending" } }))).toBe(
      true
    );
    expect(dataStoreStateSettling(storeState("a"))).toBe(false);
    expect(dataStoreStateSettling(storeState("a", { lastMigration: { outcome: "failed" } }))).toBe(
      false
    );
  });
});

describe("Prüfen: the records of a Data Store that wait for a person (REC-2)", () => {
  const objects = { kindPath: "data-stores", name: "objects" };
  const candidate = (
    documentId: string,
    overrides: Partial<DataStoreFlaggedItem> = {}
  ): DataStoreFlaggedItem => ({
    table: "objekt",
    key: 1402,
    name: "kaufpreis",
    value: 485000,
    correctedValue: null,
    page: 3,
    quote: "Kaufpreis 100",
    knowledgeBaseId: "kb_1",
    documentId,
    kind: "kaufvertrag",
    documentDate: "2026-10-17",
    extractedAt: "2026-10-18T10:00:00.000Z",
    evidence: { status: "passed" },
    state: "conflict",
    decidedBy: null,
    decidedAt: null,
    reason: "conflict",
    document: { knowledgeBase: "unterlagen", fileName: `${documentId}.pdf` },
    ...overrides
  });
  const flagged = [
    candidate("a1"),
    candidate("b1", { value: 492500, quote: "Kaufpreis 200", page: 4 }),
    candidate("a1", {
      name: "baujahr",
      value: 1990,
      state: "extracted",
      reason: "not_evidenced",
      evidence: { status: "failed", reason: "quote_not_found" }
    }),
    candidate("e4", {
      key: null,
      name: "adresse",
      value: "Nebenweg 1",
      kind: "expose",
      state: "extracted",
      reason: "key_unresolved",
      document: { knowledgeBase: "unterlagen", fileName: "expose.pdf" }
    })
  ];
  const review = (items: DataStoreFlaggedItem[] = flagged) => ({
    useFlagged: () => ready({ items }),
    decide: () => Promise.resolve(undefined)
  });

  it("groups by object and field, and offers the decisions per field and a document without object apart", () => {
    const page = render(objects, { records: true, review: review() });
    expect(page).toContain('data-review-object="1402"');
    expect(page).toContain('data-review-field="kaufpreis"');
    expect(page.match(/data-review-confirm=""/gu)).toHaveLength(3);
    expect(page.match(/data-review-correct=""/gu)).toHaveLength(3);
    expect(page).toContain('data-review-document="e4"');
    const groups = groupFlagged(flagged);
    expect(groups.fieldCount).toBe(3);
    expect(
      groups.objects.map((object) => object.fields.map((field) => field.candidates.length))
    ).toEqual([[2, 1]]);
    expect(groups.documents.map((document) => document.fileName)).toEqual(["expose.pdf"]);
  });

  it("shows who corrected a value by name, a gone account as deleted, never the account id (REC-KEEP, ERASE-ACTOR-IDS)", () => {
    const corrected = [
      candidate("a1", {
        value: 1250000,
        correctedValue: 1205000,
        state: "corrected",
        decidedBy: "records-admin",
        decidedByName: "Rita Reviewer",
        decidedAt: "2026-10-25T09:30:00.000Z"
      })
    ];
    const named = render(objects, { records: true, review: review(corrected) });
    expect(named).toContain('data-review-corrected=""');
    expect(named).toContain("Rita Reviewer");
    expect(named).not.toContain("records-admin");
    const gone = render(objects, {
      records: true,
      review: review(corrected.map(({ decidedByName: _, ...rest }) => rest))
    });
    expect(gone).toContain("Deleted account");
    expect(gone).not.toContain("records-admin");
  });

  it("has no section without a records rule, nor for a reader who may not decide", () => {
    expect(render(storePage, { review: review() })).not.toContain('id="review"');
    const refused = render(objects, {
      records: true,
      review: {
        useFlagged: () => ({ status: "refused" }),
        decide: () => Promise.resolve(undefined)
      }
    });
    expect(refused).not.toContain('id="review"');
  });

  it("writes and reads a number as the reader's language does", () => {
    expect(reviewValueText(485000, "de")).toBe("485.000");
    expect(reviewValueText(1987, "de")).toBe("1987");
    expect(reviewValueOf("1.234,5", 100, "de")).toEqual({ value: 1234.5 });
    expect(reviewValueOf("492.500", 100, "de")).toEqual({ value: 492500 });
    expect(reviewValueOf("1,234.5", 100, "en")).toEqual({ value: 1234.5 });
    expect(reviewValueOf("teuer", 100)).toEqual({ invalid: "number" });
    expect(reviewValueOf("ja", true)).toEqual({ value: true });
    expect(reviewValueOf("150", "Nebenweg 1")).toEqual({ value: "150" });
    expect(reviewValueOf("  ", "x")).toEqual({ invalid: "empty" });
  });
});

// ACCEPT-1c C10: a Data Store published in one click, and its page showed a customer admin
// what only the one who runs the database server can close. Publish asks first, as every other
// Build publish does; the steps on the server stand only for a superadmin.
describe("Publishing a Data Store", () => {
  it("asks first and publishes only on the confirm", async () => {
    const publish = vi.fn();
    const page = await mount(storePage, { draft: true, publish });
    const offered = page.querySelector<HTMLButtonElement>("[data-data-store-publish]");
    await act(async () => offered?.click());
    expect(publish).not.toHaveBeenCalled();
    expect(document.querySelector("[data-data-store-publish-confirm]")).not.toBeNull();

    const named = (name: string, within: ParentNode = document) =>
      [...within.querySelectorAll("button")].find((button) => button.textContent?.trim() === name);
    await act(async () => named("Cancel")?.click());
    expect(publish).not.toHaveBeenCalled();

    await act(async () => offered?.click());
    await act(async () => named("Publish", required(document.querySelector("dialog")))?.click());
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("What the database server leaves open around a store", () => {
  const open = {
    "visit-log": ready(
      storeState("visit-log", {
        conditions: [{ code: "server_databases_open", message: "Run REVOKE CONNECT as the owner." }]
      })
    )
  };

  it("is shown on the page and counted on the list only for the one who runs the server", () => {
    expect(render(storePage, { states: open, seesServerConditions: false })).not.toContain(
      "data-data-store-condition"
    );
    expect(render(storePage, { states: open })).toContain(
      'data-data-store-condition="server_databases_open"'
    );
    const list = { list: [storeRow("visit-log")], states: open };
    expect(render(storeList, { ...list, seesServerConditions: false })).not.toContain(
      "on the server"
    );
    expect(render(storeList, list)).toContain("1 to do on the server");
  });

  it("is shown by the instance's own answers to a superadmin, and to an admin of the instance not (RIGHTS-1e)", async () => {
    const published: BuildAsset = {
      ...draftAsset("leads"),
      revision: 2,
      draftRevision: 2,
      publishedRevision: 2,
      config: { ...draftAsset("leads").config, title: "Leads" }
    };
    const pageAs = async (roles: string[]) => {
      const statePath = apiOperations["data_stores.get"].path.replace(":store", published.name);
      const context = {
        ...platformContext(),
        instanceActions: roles.includes("superadmin") ? ["system.view"] : []
      };
      const page = await mountBuildPage(
        published,
        "data-stores",
        (request, url) =>
          request.method === "GET" && url.pathname === statePath
            ? Response.json(
                storeState("leads", {
                  conditions: [{ code: "server_databases_open", message: "advice" }]
                })
              )
            : url.pathname === apiOperations["platform.context.get"].path
              ? Response.json(context)
              : undefined,
        [],
        { user: settingsUser({ roles }) }
      );
      await vi.waitFor(() => expect(page.textContent).toContain("Leads"), {
        timeout: CONDITION_WAIT_MS
      });
      return page;
    };
    const operator = await pageAs(["user", "admin", "superadmin"]);
    await vi.waitFor(
      () =>
        expect(
          operator.querySelector('[data-data-store-condition="server_databases_open"]')
        ).not.toBeNull(),
      { timeout: CONDITION_WAIT_MS }
    );
    await unmountBuildPages();

    const admin = await pageAs(["user", "admin"]);
    await vi.waitFor(() => expect(admin.textContent).toContain("Ready"), {
      timeout: CONDITION_WAIT_MS
    });
    expect(admin.querySelector("[data-data-store-condition]")).toBeNull();
  });
});

describe("The test copy section (DT-2)", () => {
  it("resets and deletes the copy, and shows the instance's refusal", async () => {
    const calls: string[] = [];
    const page = await mount(storePage, {
      states: {
        "visit-log": ready(
          storeState("visit-log", {
            testCopy: {
              level: 2,
              seedFiles: 3,
              builtAt: "2026-10-28T09:00:00.000Z",
              bytes: 8 * MB,
              limitBytes: 100 * MB
            }
          })
        )
      },
      testCopy: {
        reset: (store) => {
          calls.push(`reset ${store}`);
          return Promise.resolve(undefined);
        },
        remove: (store) => {
          calls.push(`delete ${store}`);
          return Promise.resolve("The copy is being built. Try again in a moment.");
        }
      }
    });
    await act(async () =>
      page.querySelector<HTMLButtonElement>("[data-data-store-test-copy-reset]")?.click()
    );
    expect(page.querySelector("[data-data-store-test-copy-failed]")).toBeNull();
    await act(async () =>
      page.querySelector<HTMLButtonElement>("[data-data-store-test-copy-delete]")?.click()
    );
    expect(calls).toEqual(["reset visit-log", "delete visit-log"]);
    expect(page.querySelector("[data-data-store-test-copy-failed]")?.textContent).toBe(
      "The copy is being built. Try again in a moment."
    );
    expect(render(storePage)).not.toContain("data-data-store-test-copy-reset");
  });
});

// LOWS-A: a store's page reads its state again every 3 seconds while it is set up or migrated,
// stops once it settled, and stops ten minutes after its first unsettled answer for a store
// that never settles, by the clock, also where every later read fails. Each store the page
// opens gets ten minutes of its own.
describe("the state read of a Data Store", () => {
  const POLL_MS = 3_000;
  const MINUTE_MS = 60_000;
  const MAX_MS = 10 * MINUTE_MS;

  /**
   * The store page's state read against an instance whose migrations the test settles and whose
   * reads it can make fail. `open` shows another store, as the page does when one is picked.
   */
  async function mountStateRead() {
    const instance = {
      reads: { orders: 0, invoices: 0 } as Record<string, number>,
      outcome: "pending" as "pending" | "applied",
      failing: false
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const store = /^\/api\/v1\/data-stores\/([^/]+)$/u.exec(
        new URL(new Request(input, init).url).pathname
      )?.[1];
      if (store === undefined) return new Response(null, { status: 404 });
      instance.reads[store] = (instance.reads[store] ?? 0) + 1;
      if (instance.failing) {
        return Response.json(
          { error: { code: "INTERNAL", message: "down", correlationId: "corr_1" } },
          { status: 500 }
        );
      }
      return Response.json(
        storeState(store, {
          level: 1,
          lastMigration: { outcome: instance.outcome, migration: { number: 2, name: "add_total" } }
        })
      );
    };
    const shown: { open?: (store: string) => void } = {};
    function Probe() {
      const [store, setStore] = useState("orders");
      shown.open = setStore;
      useDataStoreSource().useStoreState(store);
      return null;
    }
    const page = await mountPage(
      settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl })),
      "en",
      createElement(Probe)
    );
    const pass = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    const open = async (store: string) => {
      await act(async () => {
        shown.open?.(store);
      });
      await pass(0);
    };
    await pass(0);
    return { instance, pass, open, unmount: page.unmount };
  }

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads again while the store settles and stops once it settled", async () => {
    const { instance, pass, unmount } = await mountStateRead();
    expect(instance.reads.orders).toBe(1);
    await pass(POLL_MS);
    await pass(POLL_MS);
    expect(instance.reads.orders).toBe(3);
    instance.outcome = "applied";
    await pass(POLL_MS);
    expect(instance.reads.orders).toBe(4);
    await pass(POLL_MS * 10);
    expect(instance.reads.orders).toBe(4);
    await unmount();
  });

  it("stops reading a store that never settles after ten minutes", async () => {
    const { instance, pass, unmount } = await mountStateRead();
    await pass(MAX_MS - POLL_MS);
    expect(instance.reads.orders).toBeGreaterThan(MAX_MS / POLL_MS - 5);
    await pass(POLL_MS * 2);
    const atCeiling = instance.reads.orders;
    await pass(MAX_MS);
    expect(instance.reads.orders).toBe(atCeiling);
    expect(atCeiling).toBeLessThanOrEqual(MAX_MS / POLL_MS + 2);
    await unmount();
  });

  // A failed read changes no answer, so a bound measured between answers never came.
  it("stops after ten minutes where every read after the first unsettled answer fails", async () => {
    const { instance, pass, unmount } = await mountStateRead();
    instance.failing = true;
    await pass(MINUTE_MS);
    // It keeps trying while the reads fail, inside the ten minutes.
    expect(instance.reads.orders).toBeGreaterThan(MINUTE_MS / POLL_MS - 2);
    await pass(MAX_MS);
    const atCeiling = instance.reads.orders;
    expect(atCeiling).toBeLessThanOrEqual(MAX_MS / POLL_MS + 2);
    await pass(MAX_MS * 2);
    expect(instance.reads.orders).toBe(atCeiling);
    await unmount();
  });

  it("gives each unsettled store it opens ten minutes of its own", async () => {
    const { instance, pass, open, unmount } = await mountStateRead();
    await pass(MINUTE_MS);
    await open("invoices");
    await pass(4 * MINUTE_MS);
    expect(instance.reads.invoices).toBeGreaterThan((4 * MINUTE_MS) / POLL_MS - 2);
    // Back to orders within the query cache's five minutes, so its unsettled answer is still
    // held: it gets a window from now, not the one invoices began a minute in.
    await open("orders");
    await pass(7 * MINUTE_MS);
    const ordersAt7 = instance.reads.orders ?? 0;
    await pass(2 * MINUTE_MS);
    expect(instance.reads.orders).toBeGreaterThan(ordersAt7);
    await pass(2 * MINUTE_MS);
    const ordersAtCeiling = instance.reads.orders;
    await pass(MAX_MS);
    expect(instance.reads.orders).toBe(ordersAtCeiling);
    await unmount();
  });
});
