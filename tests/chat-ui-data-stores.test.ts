import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { LocaleCode } from "@work-shape/catalyst-api-client";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  appDataLines,
  audienceLine,
  fillerLine,
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  dataStoreKindOn,
  dataStoreStateSettling,
  dataStoreStateView,
  DataStoreValueDialog,
  formatDataStoreSize,
  resolveBuildRights,
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
  type AppDataSources,
  type DataStoreUsedBy,
  type DataStoreValue,
  usingPageRoute
} from "@work-shape/catalyst-chat-ui/build-area";
import { DockAgentWorkContext } from "@work-shape/catalyst-chat-ui/dock-page-chat";
import { required } from "./support/assertions";
import { platformContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The Data Store list and page against the answers of the contract (`data_stores.get`,
// `.describe`, `.list`, `.rows`, `.value`, `.used_by`), handed in where the instance's answers
// will stand. Every test
// here fails without the kind: before it, the address of Data Stores showed Agents.

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
      comment: "One row per visit of a page.",
      rowEstimate: 1240,
      columns: [
        {
          name: "id",
          type: "integer",
          nativeType: "bigint",
          nullable: false,
          default: "nextval('visits_id_seq'::regclass)",
          primaryKey: true
        },
        { name: "path", type: "text", nativeType: "text", nullable: false, primaryKey: false },
        {
          name: "referrer",
          type: "text",
          nativeType: "text",
          nullable: true,
          primaryKey: false,
          comment: "Where the visitor came from."
        },
        {
          name: "visited_at",
          type: "timestamp",
          nativeType: "timestamp with time zone",
          nullable: false,
          default: "now()",
          primaryKey: false
        }
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

const LONG_REFERRER = `https://example.test/search?q=${"catalyst+".repeat(12)}`;

/** The first thousand characters of a note the instance cut. */
const CUT_NOTE = "A long note. ".repeat(77).slice(0, 1000);

const visitRows: DataStoreRowsPage = {
  table: "visits",
  columns: [
    { name: "id", type: "integer", nativeType: "bigint" },
    { name: "path", type: "text", nativeType: "text" },
    { name: "referrer", type: "text", nativeType: "text" },
    { name: "tags", type: "other", nativeType: "jsonb" },
    { name: "note", type: "text", nativeType: "text" },
    { name: "body", type: "other", nativeType: "bytea" }
  ],
  order: { by: "key", columns: ["id"] },
  rows: [
    {
      at: "at_1",
      values: {
        id: 1,
        path: "/pricing",
        referrer: LONG_REFERRER,
        tags: { campaign: "autumn" },
        note: CUT_NOTE,
        body: ""
      },
      cut: ["note", "body"]
    },
    {
      at: "at_2",
      values: { id: 2, path: "/docs", referrer: null, tags: null, note: null, body: null }
    }
  ],
  next: "at_2",
  valueMaxChars: 1000
};

const admins = { holders: [], hiddenHolders: 0 };

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
      sources: [
        { connection: "exampledata", title: "Exampledata" },
        { connection: "crm", title: "CRM" }
      ],
      account: { name: "nightly-runner", title: "Nightly runner" }
    },
    {
      id: "asset_weekly",
      name: "weekly-report",
      title: "Weekly report",
      reads: true,
      writes: false,
      sources: []
    }
  ],
  knowledgeBases: [
    {
      id: "asset_visits_knowledge",
      name: "visits-knowledge",
      title: "Visits knowledge",
      audience: {
        holders: [{ kind: "user", name: "usr_kai", title: "Kai" }],
        hiddenHolders: 0
      }
    }
  ],
  readers: {
    holders: [{ kind: "service_principal", name: "sp_report", title: "Reporting" }],
    hiddenHolders: 2
  },
  hidden: { apps: 1, workflows: 2, knowledgeBases: 0, fills: 1, reads: 2 },
  truncated: false
};

const nothingUses: DataStoreUsedBy = {
  apps: [],
  workflows: [],
  knowledgeBases: [],
  readers: admins,
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
}

function storeSource(answers: StoreAnswers = {}): DataStoreSource {
  return {
    seesServerConditions: true,
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
}

/** The Build frame at an address, with the Data Store kind on fixed answers. */
function render(location: BuildLocation, input: RenderInput = {}): string {
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
      publish: async () => ({ draftRevision: 1, publishedRevision: 1 }),
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    }
  };
  const planted = dataStoreKindOn(() => storeSource(input));
  const kinds = buildAssetKinds.map((kind) => (kind.kind === "data_store" ? planted : kind));
  return renderToStaticMarkup(
    createElement(
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
    )
  );
}

describe("Data Stores in Build", () => {
  it("lists every store with its description, whom it belongs to, its state and its size, and a link to its page", () => {
    const list = render(
      { kindPath: "data-stores" },
      {
        list: [
          storeRow("visit-log", {
            title: "Visit log",
            description: "Every visit of a page of the public site."
          }),
          storeRow("orders", { title: "Orders", scope: { kind: "workspace", workspaceId: "ws_1" } })
        ],
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
            // Never measured: the row says neither tables nor rows.
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
              level: 1,
              size: { limitBytes: 500 * MB, nearLimit: false },
              conditions: [
                { code: "sessions_open", message: "advice" },
                { code: "temp_files_unbounded", message: "advice" }
              ],
              lastMigration: { outcome: "pending", migration: { number: 2, name: "add_total" } }
            })
          )
        }
      }
    );

    expect(list).toContain('<option value="data-stores" selected="">Data stores</option>');
    expect(list).toContain(">Visit log<");
    expect(list).toContain("Every visit of a page of the public site.");
    expect(list).toContain('href="/build/data-stores/visit-log"');
    // One chip says whose a row is: "Personal" alone for the reader's own store.
    expect(list).toContain(">Personal<");
    expect(list).not.toContain(">Workspace<");
    expect(list).not.toContain(">Instance<");
    expect(list).not.toContain(">visit-log<");
    for (const said of [
      'data-data-store-row-state="ready"',
      "Ready",
      "8 MB",
      'data-data-store-row-state="migrations_pending"',
      "Migrations pending",
      "2 to do on the server",
      'data-data-store-row-measured="visit-log"',
      ">2 tables<",
      ">about 1,240 rows<"
    ]) {
      expect(list, said).toContain(said);
    }
    const orders = list.slice(list.indexOf('data-data-store-row-measured="orders"'));
    expect(orders).not.toContain("tables<");
    expect(orders).not.toContain("about ");
    // Nothing is started here: a store is made by an agent or through the API.
    expect(list).not.toContain(">New ");
    expect(list).not.toContain("More actions");
    expect(list).toContain(
      "Where apps, workflows and agents in conversations keep their records. This page shows what each store holds."
    );
  });

  it("offers whoever New opens the agent for the agent with two examples on the empty list, and tells everybody else what a store is", () => {
    const builder = render({ kindPath: "data-stores" }, { buildWithAgent: noop });
    expect(builder).toContain("Describe one to the agent, and its first save creates it.");
    expect(builder).toContain(">Build one with the agent</button>");
    expect(builder).toContain('aria-label="Examples to start with"');
    expect(builder).toContain("Client list");
    expect(builder).toContain("Hours per project");
    expect(render({ kindPath: "data-stores" }, { buildWithAgent: noop, locale: "de" })).toContain(
      ">Einen mit dem Agenten bauen</button>"
    );

    // Without the agent, and without the right to create, the list says what a store is: no
    // way that is not there, and no word of who else could add one.
    for (const reader of [
      render({ kindPath: "data-stores" }),
      render({ kindPath: "data-stores" }, { canCreate: false, buildWithAgent: noop })
    ]) {
      expect(reader).toContain(
        "No data stores yet. A data store keeps records such as a client list or the hours per project, for apps and workflows to use."
      );
      expect(reader).not.toContain("Build one with the agent");
      expect(reader).not.toContain("Client list");
      expect(reader).not.toContain("CLI");
      expect(reader).not.toContain(">New ");
    }

    // The offer is the one button for the call: the head's New stands once there are stores.
    expect(builder).not.toContain("New data store");
    const listed = render(
      { kindPath: "data-stores" },
      { buildWithAgent: noop, list: [storeRow("orders", { title: "Orders" })] }
    );
    expect(listed).toContain("New data store");
    expect(listed).not.toContain("Build one with the agent");
    // While the list loads, New stands: making one never waits for the answer.
    expect(
      render({ kindPath: "data-stores" }, { buildWithAgent: noop, listLoading: true })
    ).toContain("New data store");

    // Where a picker chooses the owner, an empty one offers the agent under the picker.
    const scoped = render({ kindPath: "data-stores" }, { scoped: true, buildWithAgent: noop });
    expect(scoped).toContain('aria-label="Scope: Personal"');
    expect(scoped).toContain(">Build one with the agent</button>");
    expect(scoped).toContain("Hours per project");
    expect(scoped).not.toContain("New data store");

    const off = render({ kindPath: "data-stores" }, { on: false });
    expect(off).not.toContain("Data stores");

    expect(render({ kindPath: "data-stores" }, { locale: "de" })).toContain(
      "Noch keine Datenspeicher."
    );
  });

  it("shows a store's state, its tables with columns, types and row estimates, and the first page of a table with long values cut", () => {
    const page = render({ kindPath: "data-stores", name: "visit-log" });

    expect(page).toContain(">Visit log</h1>");
    // The head says what the store does after its name; its id is behind "Copy ID".
    expect(page).toMatch(/data-slot="page-header-description"[^>]*>Every visit of a page/u);
    expect(page).not.toContain(">visit-log<");
    expect(page).toContain('aria-label="More actions"');
    expect(page).toContain('data-data-store-state="ready"');
    expect(page).toContain("8 MB of 500 MB");
    expect(page).toContain("0002_add_referrer");
    expect(page).toContain("Every visit of a page of the public site.");
    // A ready store without anything open on the server has no such section.
    expect(page).not.toContain("Open on the server");

    for (const said of [
      'data-data-store-table="visits"',
      "One row per visit of a page.",
      "about 1,240 rows",
      'data-data-store-column="visited_at"',
      "timestamp with time zone",
      "Where the visitor came from.",
      'data-data-store-table="pages"',
      "1 column"
    ]) {
      expect(page, said).toContain(said);
    }
    // The planner has no estimate for a table it never counted: the row names none.
    expect(page).not.toContain("about 0");

    expect(page).toContain('data-data-store-rows="visits"');
    expect(page).toContain("/pricing");
    // The whole value stays in the cell, which cuts it at forty characters.
    expect(page).toContain(LONG_REFERRER.replaceAll("&", "&amp;"));
    expect(page).toContain("max-width:40ch");
    expect(page).toContain("{&quot;campaign&quot;:&quot;autumn&quot;}");
    expect(page).toContain(">null<");
    expect(page).toContain("Rows 1 to 2. The table holds more. Ordered by the key (id).");
    // The page reads and changes nothing.
    expect(page).not.toContain(">Save<");
    expect(page).not.toContain("History");
  });

  it("names a store that is not ready and what the server leaves open, and reads no table of it", () => {
    const failure = { code: "provisioning_failed", message: "The server refused CREATE DATABASE." };
    const page = render(
      { kindPath: "data-stores", name: "visit-log" },
      {
        states: {
          "visit-log": ready(
            storeState("visit-log", {
              status: "provisioning",
              level: 0,
              conditions: [
                { code: "sessions_open", message: "The platform's role is no superuser." }
              ],
              lastMigration: { outcome: "failed", failure }
            })
          )
        },
        schema: { status: "failed", message: "must not be read", retry: noop }
      }
    );

    expect(page).toContain('data-data-store-state="provisioning_failed"');
    expect(page).toContain("Setup failed");
    expect(page).toContain("The server refused CREATE DATABASE.");
    expect(page).toContain('data-data-store-condition="sessions_open"');
    expect(page).toContain("Hide the server&#x27;s sessions from this store");
    expect(page).toContain("The tables show once the store is ready.");
    expect(page).not.toContain("must not be read");

    const german = render({ kindPath: "data-stores", name: "visit-log" }, { locale: "de" });
    expect(german).toContain("Bereit");
    expect(german).toContain("8 MB von 500 MB");
    expect(german).toContain("etwa 1.240 Zeilen");
  });
});

describe("A Data Store never published", () => {
  it("shows its draft with the migrations a publish applies, and Publish, and reads no state of it", () => {
    const states = {
      "visit-log": {
        status: "failed" as const,
        message: "Data Store is not available",
        retry: noop
      }
    };
    for (const locale of ["en", "de"] as const) {
      const markup = render(
        { kindPath: "data-stores", name: "visit-log" },
        { draft: true, states, locale }
      );
      expect(markup).toContain("data-data-store-draft");
      expect(markup).toContain("0001_init.sql");
      expect(markup).toContain("data-data-store-publish");
      // Nothing of a database that does not exist yet is shown or said.
      expect(markup).not.toContain("Data Store is not available");
      expect(markup).not.toContain("data-data-store-state");
    }
    expect(
      render({ kindPath: "data-stores", name: "visit-log" }, { draft: true, locale: "de" })
    ).toContain("Entwurf · nicht veröffentlicht");
  });

  it("holds Publish back while the agent in the dock is still working on the store", () => {
    const address = { kindPath: "data-stores", name: "visit-log" };
    const working = render(address, {
      draft: true,
      agentWork: { kind: "data_store", name: "visit-log" }
    });
    expect(working).not.toContain("data-data-store-publish");
    expect(working).toContain("data-data-store-agent-working");
    expect(working).toContain("The agent is still working on this Data Store.");
    // An agent at work on something else holds nothing back here.
    const elsewhere = render(address, {
      draft: true,
      agentWork: { kind: "data_store", name: "orders" }
    });
    expect(elsewhere).toContain("data-data-store-publish");
    expect(elsewhere).not.toContain("data-data-store-agent-working");
  });
});

describe("The rows of a Data Store", () => {
  const address = { kindPath: "data-stores", name: "visit-log" };

  it("pages a table with Next and Back to start, without page numbers, and says how the rows are ordered", () => {
    const first = render(address);
    expect(first).toContain('data-data-store-rows-order="key"');
    expect(first).toMatch(/<button[^>]*disabled=""[^>]*>Back to start<\/button>/u);
    expect(first).toMatch(/<button(?![^>]*disabled="")[^>]*>Next<\/button>/u);
    expect(first).not.toContain('aria-current="page"');

    // The last page of a table without a key: nothing follows, and the order is the stored one.
    const last = render(address, {
      rows: ready({ ...visitRows, order: { by: "physical" }, next: undefined })
    });
    expect(last).toContain('data-data-store-rows-order="physical"');
    expect(last).toContain("This is the end of the table. In stored order: this table has no key.");
    expect(last).toMatch(/<button[^>]*disabled=""[^>]*>Next<\/button>/u);

    const german = render(address, {
      locale: "de",
      rows: ready({ ...visitRows, order: { by: "physical" }, next: undefined })
    });
    expect(german).toContain("Zeilen 1 bis 2. Das ist das Ende der Tabelle. In gespeicherter");
    expect(german).toContain(">Zum Anfang<");
    expect(german).toContain(">Weiter<");
  });

  it("shows a yes-or-no value in the reader's words, as the confirmation of a row write does", () => {
    const rows = ready({
      ...visitRows,
      columns: [
        { name: "id", type: "integer", nativeType: "bigint" },
        { name: "done", type: "boolean", nativeType: "boolean" }
      ],
      rows: [
        { at: "at_1", values: { id: 1, done: false } },
        { at: "at_2", values: { id: 2, done: true } }
      ]
    });
    const english = render(address, { rows });
    expect(english).toContain(">No<");
    expect(english).toContain(">Yes<");
    expect(english).not.toMatch(/>(?:true|false)</u);

    const german = render(address, { locale: "de", rows });
    expect(german).toContain(">Nein<");
    expect(german).toContain(">Ja<");
    expect(german).not.toMatch(/>(?:true|false)</u);
  });

  it("writes dates the way the reader's language does, never as ISO text (ACCEPT-2e)", () => {
    const rows = ready({
      ...visitRows,
      columns: [
        { name: "mandant", type: "text", nativeType: "text" },
        { name: "frist", type: "date", nativeType: "date" }
      ],
      rows: [{ at: "at_1", values: { mandant: "Bäckerei Sommer", frist: "2026-12-15" } }]
    });

    const german = render(address, { locale: "de", rows });
    expect(german).toContain(">15.12.2026<");
    expect(german).not.toContain("2026-12-15");
    expect(render(address, { rows })).toContain(">Dec 15, 2026<");
  });

  it("names a column's type in the reader's words, and the database's name only where it differs (ACCEPT-2e)", () => {
    const german = render(address, {
      locale: "de",
      schema: ready({
        ...schema,
        tables: [
          {
            name: "fristen",
            rowEstimate: 3,
            columns: [
              {
                name: "id",
                type: "integer",
                nativeType: "bigint",
                nullable: false,
                primaryKey: true
              },
              {
                name: "mandant",
                type: "text",
                nativeType: "text",
                nullable: false,
                primaryKey: false
              },
              {
                name: "erledigt",
                type: "boolean",
                nativeType: "boolean",
                nullable: false,
                primaryKey: false
              },
              { name: "frist", type: "date", nativeType: "date", nullable: true, primaryKey: false }
            ]
          }
        ]
      })
    });
    const typeOf = (column: string) =>
      german.slice(german.indexOf(`data-data-store-column="${column}"`)).split("</tr>")[0] ?? "";

    expect(typeOf("id")).toContain(">Ganzzahl");
    expect(typeOf("id")).toContain(">bigint<");
    expect(typeOf("mandant")).toContain(">Text");
    expect(typeOf("mandant")).not.toContain(">text<");
    expect(typeOf("erledigt")).toContain(">Ja oder nein");
    expect(typeOf("erledigt")).not.toContain("boolean");
    expect(typeOf("frist")).toContain(">Datum");
    expect(typeOf("frist")).not.toContain(">date<");
  });

  it("shows a cut value by its first characters and a value read by no page as not read, each with the button that reads it whole", () => {
    const page = render(address);
    expect(page).toContain('data-data-store-cut="text"');
    expect(page).toContain(CUT_NOTE);
    expect(page).toContain('aria-label="Show the whole value of note"');
    expect(page).toContain('data-data-store-cut="unread"');
    expect(page).toContain(">Not read<");
    expect(page).toContain('aria-label="Show the whole value of body"');
  });

  it("names an empty table, rows the reader may not read and rows that could not be read", () => {
    expect(render(address, { rows: ready({ ...visitRows, rows: [], next: undefined }) })).toContain(
      "This table holds no rows."
    );
    const refused = render(address, { rows: { status: "refused" } });
    expect(refused).toContain('data-data-store-refused=""');
    expect(refused).toContain("You may not read the rows of this store.");
    expect(render(address, { rows: { status: "refused" }, locale: "de" })).toContain(
      "Du darfst die Zeilen dieses Speichers nicht lesen."
    );
    const failed = render(address, {
      rows: { status: "failed", message: undefined, retry: noop }
    });
    expect(failed).toContain("The rows could not be loaded.");
    expect(failed).toContain(">Try again<");
  });

  it("opens a value whole, and says so where the instance answers that it is too large or that its row is gone", () => {
    const dialog = (value: DataStoreRead<DataStoreValue>, locale: LocaleCode = "en") =>
      renderToStaticMarkup(
        createElement(
          TranslationProvider,
          { children: null, locale },
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
    expect(shown).toContain("5,200 characters");
    expect(shown).toContain("The whole value of one row of visits.");
    // A value that is no text shows as the JSON it is.
    expect(dialog(ready({ value: { campaign: "autumn" } }))).toContain("&quot;campaign&quot;: ");

    const tooLarge = dialog({
      status: "failed",
      message: "This value is larger than one read of a store answers.",
      reason: "value_too_large",
      retry: noop
    });
    expect(tooLarge).toContain('data-data-store-value="too_large"');
    expect(tooLarge).toContain("it cannot be shown here. A query reads a part of it.");
    expect(tooLarge).not.toContain("Try again");
    expect(
      dialog({ status: "failed", message: "x", reason: "value_too_large", retry: noop }, "de")
    ).toContain("lässt sich hier nicht anzeigen");

    const gone = dialog({ status: "failed", message: "x", reason: "row_gone", retry: noop });
    expect(gone).toContain('data-data-store-value="gone"');
    expect(dialog({ status: "failed", message: undefined, retry: noop })).toContain(
      "The value could not be loaded."
    );
  });
});

describe("What uses a Data Store", () => {
  const address = { kindPath: "data-stores", name: "visit-log" };

  it("leads to the page of an App and of a Workflow only where the reader is shown such pages", () => {
    const shown = { collaborationWorkspaceId: "ws_1", apps: true, workflows: true };
    expect(usingPageRoute("app", "visits-board", shown)).toEqual({
      kind: "app",
      collaborationWorkspaceId: "ws_1",
      app: "visits-board"
    });
    expect(usingPageRoute("workflow", "nightly-visits", shown)).toEqual({
      kind: "workflow",
      collaborationWorkspaceId: "ws_1",
      workflow: "nightly-visits"
    });
    // The Apps module is off, the Workflows area is closed to the reader, or no workspace is open.
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

  it("says what fills a store, from which Connections and as which account, and who reads it", () => {
    const page = render(address);
    const section = (id: string) =>
      page.slice(page.indexOf(`id="${id}"`)).split("</section>")[0] ?? "";
    const filled = section("filled-by");
    // Both stand right after the status: a phone shows no table of contents to jump by.
    expect(page.indexOf('id="status"')).toBeLessThan(page.indexOf('id="filled-by"'));
    expect(page.indexOf('id="read-by"')).toBeLessThan(page.indexOf('id="tables"'));
    expect(filled).toContain(">Filled by</h2>");
    expect(filled).toContain('data-data-store-used-by="workflow"');
    expect(filled).toContain(">Nightly rollup<");
    expect(filled).toContain("Copies from Exampledata and CRM · Runs as Nightly runner");
    // An App that only reads and a Workflow that only reads fill nothing.
    expect(filled).not.toContain("Visits board");
    expect(filled).not.toContain("Weekly report");

    const read = section("read-by");
    expect(read).toContain(">Read by</h2>");
    expect(read).toContain(">Visits board<");
    expect(read).toContain('href="/w/ws_1/apps/visits-board"');
    expect(read).toContain(">Everyone in Kai Spezis (14 people)<");
    expect(read).toContain('data-data-store-used-by="knowledge_base"');
    expect(read).toContain(">Kai<");
    expect(read).toContain(">Weekly report<");
    expect(read).not.toContain("Nightly rollup");
    expect(read).toContain(">Direct access<");
    expect(read).toContain(">Reporting (technical account) · 2 more with access<");
    // The admins are said once, under the section, and on no line.
    expect(read).toContain(">Instance admins always see everything.<");
    expect(page.split("Instance admins").length - 1).toBe(1);
    // What the reader may not see is counted where it would stand: the hidden Workflow that
    // fills the store under Filled by, the two that read it under Read by.
    expect(filled).toContain("and 1 more you can&#x27;t see");
    expect(read).toContain("and 2 more you can&#x27;t see");
    // The lines are read whole on a phone, not cut after the first words.
    const wraps = (line: string) => new RegExp(`class="[^"]*\\bsm:truncate\\b[^"]*">${line}`, "u");
    expect(filled).toMatch(wraps("Copies from Exampledata"));
    expect(read).toMatch(wraps("Everyone in Kai Spezis"));
    expect(read).toMatch(wraps("Reporting \\(technical account\\)"));

    const german = render(address, { locale: "de" });
    expect(german).toContain(">Gefüllt von</h2>");
    expect(german).toContain("Kopiert aus Exampledata und CRM · Läuft als Nightly runner");
    expect(german).toContain(">Gelesen von</h2>");
    expect(german).toContain(">Alle in Kai Spezis (14 Personen)<");
    expect(german).toContain(">Direkter Zugriff<");
    expect(german).toContain(">Reporting (technisches Konto) · 2 weitere mit Zugriff<");
    expect(german).toContain(">Instanz-Admins sehen immer alles.<");
    expect(german).toContain("und 1 weitere, die du nicht sehen kannst");
    expect(german).toContain("und 2 weitere, die du nicht sehen kannst");
  });

  it("says in one sentence that nothing uses a store, that only hidden ones do, and that the reader may not see it", () => {
    const nothing = render(address, { usedBy: ready(nothingUses) });
    expect(nothing).toContain("No published workflow or app adds rows to this store.");
    // Whoever may read the store is always said, admins at the least.
    expect(nothing).toContain(">Direct access<");
    expect(nothing).toContain(">Only instance admins<");
    const hidden = (fills: number, reads: number) =>
      render(address, {
        usedBy: ready({
          ...nothingUses,
          hidden: { apps: fills, workflows: reads, knowledgeBases: 0, fills, reads }
        })
      });
    // A store that only a hidden Workflow fills is not said to be filled by nothing.
    const filledUnseen = hidden(1, 0);
    expect(filledUnseen).not.toContain("No published workflow or app adds rows to this store.");
    expect(filledUnseen).toContain(
      "One workflow or app you can&#x27;t see adds rows to this store."
    );
    expect(filledUnseen).not.toContain("more you can&#x27;t see");
    expect(hidden(3, 0)).toContain(
      "3 workflows or apps you can&#x27;t see add rows to this store."
    );
    // One that only hidden ones read says so under Read by, and nothing fills it.
    const readUnseen = hidden(0, 1);
    expect(readUnseen).toContain("No published workflow or app adds rows to this store.");
    expect(readUnseen).toContain("and 1 more you can&#x27;t see");
    expect(render(address, { usedBy: { status: "refused" } })).toContain(
      "You may not see what uses this store."
    );
    expect(
      render(address, { usedBy: { status: "failed", message: undefined, retry: noop } })
    ).toContain("What uses this store could not be loaded.");
    // What uses a store is read from the definitions, so a store that is not ready shows it too.
    expect(
      render(address, {
        states: { "visit-log": ready(storeState("visit-log", { status: "provisioning" })) }
      })
    ).toContain(">Visits board<");
  });
});

describe("Rows written from conversations (C-3)", () => {
  const address = { kindPath: "data-stores", name: "visit-log" };
  const section = (page: string, id: string) =>
    page.slice(page.indexOf(`id="${id}"`)).split("</section>")[0] ?? "";
  const written = (conversationWriters: DataStoreUsedBy["conversationWriters"]) =>
    ready<DataStoreUsedBy>({
      ...nothingUses,
      ...(conversationWriters ? { conversationWriters } : {})
    });

  it("names agents in conversations as writers by counts only, and the intro says they keep records", () => {
    const page = render(address, {
      usedBy: written({ agents: 1, conversations: 3, truncated: false })
    });
    const filled = section(page, "filled-by");
    // Rows came only from chat: the store is not said to be filled by nothing.
    expect(filled).not.toContain("No published workflow or app adds rows to this store.");
    expect(filled).toContain('data-data-store-conversation-writers=""');
    expect(filled).toContain(">Agents in conversations<");
    expect(filled).toContain(">1 agent in 3 conversations<");
    expect(page).toContain("Where apps, workflows and agents in conversations keep their records.");

    const german = render(address, {
      locale: "de",
      usedBy: written({ agents: 2, conversations: 1, truncated: true })
    });
    const gefuellt = section(german, "filled-by");
    expect(gefuellt).toContain(">Agenten in Unterhaltungen<");
    expect(gefuellt).toContain(">Mindestens 2 Agenten in 1 Unterhaltung<");
    expect(german).toContain(
      "Hier legen Apps, Workflows und Agenten in Unterhaltungen ihre Einträge ab."
    );
  });

  it("adds no line where no conversation wrote a row", () => {
    for (const usedBy of [
      written(undefined),
      written({ agents: 0, conversations: 0, truncated: false })
    ]) {
      const filled = section(render(address, { usedBy }), "filled-by");
      expect(filled).not.toContain("data-data-store-conversation-writers");
      expect(filled).toContain("No published workflow or app adds rows to this store.");
    }
  });

  // The instance reads only the latest writes. Cut short before it found any from a
  // conversation, it knows of none, not that there were none: never "at least 0".
  it("says older writes may be missing where the count was cut short before finding any", () => {
    const cut = written({ agents: 0, conversations: 0, truncated: true });
    const filled = section(render(address, { usedBy: cut }), "filled-by");
    expect(filled).toContain('data-data-store-conversation-writers=""');
    expect(filled).toContain(">Older conversation writes may be missing<");
    expect(filled).not.toContain("At least 0");
    const gefuellt = section(render(address, { locale: "de", usedBy: cut }), "filled-by");
    expect(gefuellt).toContain(">Ältere Einträge aus Unterhaltungen fehlen hier möglicherweise<");
  });
});

describe("The data Workflows of a Data Store (WF-KIND)", () => {
  const address = { kindPath: "data-stores", name: "visit-log" };
  const flows = (dataFlows: DataStoreUsedBy["dataFlows"]) =>
    ready<DataStoreUsedBy>({ ...usedBy, ...(dataFlows ? { dataFlows } : {}) });
  const section = (page: string, id: string) =>
    page.indexOf(`id="${id}"`) === -1
      ? undefined
      : (page.slice(page.indexOf(`id="${id}"`)).split("</section>")[0] ?? "");

  it("adds the data Workflows that fill it under Filled by once each, and those that process it under Processed by", () => {
    const page = render(address, {
      workflowPages: true,
      usedBy: flows({
        // The rollup already stands as a Workflow that adds rows: it is not listed twice.
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
    expect(filled).toContain(">Visit import<");
    expect(filled).toContain('href="/w/ws_1/workflows/visit-import"');
    // The store's own count already holds every hidden App and Workflow that adds rows, data
    // flows among them: it stands, and the data flows' count is not added to it.
    expect(filled).toContain("and 1 more you can&#x27;t see");
    expect(filled).not.toContain("and 3 more");
    expect(filled).not.toContain("and 4 more");
    // The section says what they do: no row carries a chip of its own for that.
    expect(filled).not.toContain("Data flow<");

    const processed = required(section(page, "processed-by"));
    expect(page.indexOf('id="filled-by"')).toBeLessThan(page.indexOf('id="processed-by"'));
    expect(processed).toContain(">Processed by</h2>");
    expect(processed).toContain(">Visit extract<");
    expect(processed).toContain('href="/w/ws_1/workflows/visit-extract"');
    expect(processed).toContain("and 2 more you can&#x27;t see");
    expect(render(address, { usedBy: flows(undefined), locale: "de" })).not.toContain(
      "Verarbeitet von"
    );
  });

  it("counts the Workflows the reader may not see without naming one, and has no section without any", () => {
    const hiddenOnly = render(address, {
      usedBy: flows({
        fills: [],
        processes: [],
        hidden: { fills: 0, processes: 1 },
        truncated: false
      })
    });
    const processed = required(section(hiddenOnly, "processed-by"));
    expect(processed).toContain("One workflow you can&#x27;t see does this.");
    expect(processed).not.toContain("data-data-flow=");
    expect(
      render(address, {
        locale: "de",
        usedBy: flows({
          fills: [],
          processes: [],
          hidden: { fills: 0, processes: 4 },
          truncated: false
        })
      })
    ).toContain("4 Workflows, die du nicht sehen kannst, tun das.");
    // Nothing processes the store: no section, and Filled by stays as it was.
    const none = render(address, {
      usedBy: flows({
        fills: [],
        processes: [],
        hidden: { fills: 0, processes: 0 },
        truncated: false
      })
    });
    expect(section(none, "processed-by")).toBeUndefined();
    expect(required(section(none, "filled-by"))).toContain("and 1 more you can&#x27;t see");
  });
});

describe("Data Store state", () => {
  it("names a store by one state and a size by its largest whole unit", () => {
    expect(dataStoreStateView(storeState("a"))).toBe("ready");
    expect(dataStoreStateView(storeState("a", { status: "provisioning" }))).toBe("provisioning");
    expect(dataStoreStateView(storeState("a", { lastMigration: { outcome: "failed" } }))).toBe(
      "migration_failed"
    );
    expect(formatDataStoreSize(512, "en")).toBe("512 byte");
    expect(formatDataStoreSize(1536, "en")).toBe("1.5 kB");
    expect(formatDataStoreSize(2 * 1024 ** 3, "de")).toMatch(/^2\sGB$/u);
  });
  it("follows a store while it is set up or a migration waits, and stops once it settled (E-1)", () => {
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

describe("where an App's data comes from", () => {
  const translate = (locale: LocaleCode) => createTranslationContext(locale);

  it("names the store, each Workflow or App that fills it and the Connections it copies from", () => {
    const sources: AppDataSources = {
      stores: [
        {
          name: "kunden",
          title: "Kunden",
          fillers: [
            {
              kind: "workflow",
              name: "nightly-rollup",
              title: "Nightly rollup",
              connections: ["Exampledata", "CRM"]
            },
            { kind: "app", name: "entry", title: "Entry form", connections: [] }
          ]
        },
        { name: "termine", title: "Termine", fillers: [] }
      ],
      truncated: false
    };
    expect(appDataLines(sources, translate("en").t, "en")).toEqual([
      "Shows data from “Kunden”, which the Workflow “Nightly rollup” copies from Exampledata and CRM.",
      "Shows data from “Kunden”, which the App “Entry form” adds.",
      // A store nothing fills is named alone.
      "Shows data from “Termine”."
    ]);
    expect(appDataLines(sources, translate("de").t, "de")).toEqual([
      "Zeigt Daten aus „Kunden“, die der Workflow „Nightly rollup“ aus Exampledata und CRM kopiert.",
      "Zeigt Daten aus „Kunden“, die die App „Entry form“ hinzufügt.",
      "Zeigt Daten aus „Termine“."
    ]);
  });

  it("words an App's audience as its publish named it, not by the workspace that owns it (E-2)", () => {
    const { t } = translate("en");
    const personal = { title: "Personal workspace", members: 1 };
    const shared = (audience: "self" | "instance", people: number) =>
      audienceLine(
        { app: { audience, people }, workspace: personal, holders: [], hiddenHolders: 0 },
        t,
        "en"
      );
    expect(shared("instance", 12)).toBe("Whole instance (12 people)");
    expect(shared("instance", 1)).toBe("Whole instance (1 person)");
    expect(shared("self", 1)).toBe("One selected person");
    expect(
      audienceLine(
        {
          app: { audience: "instance", people: 12 },
          workspace: personal,
          holders: [],
          hiddenHolders: 0
        },
        translate("de").t,
        "de"
      )
    ).toBe("Ganze Instanz (12 Personen)");
    // An App for its workspace is said by that workspace, as before.
    expect(
      audienceLine(
        {
          app: { audience: "workspace", people: 14 },
          workspace: { title: "Kai Spezis", members: 14 },
          holders: [],
          hiddenHolders: 0
        },
        t,
        "en"
      )
    ).toBe("Everyone in Kai Spezis (14 people)");
  });

  it("words an audience by its workspace, its holders and how many more, and the admins only where nobody else reads", () => {
    const { t } = translate("en");
    expect(
      audienceLine(
        {
          workspace: { title: "Kai Spezis", members: 1 },
          holders: [
            { kind: "role", name: "user", title: "user" },
            { kind: "group", name: "grp_sales", title: "grp_sales" }
          ],
          hiddenHolders: 1
        },
        t,
        "en"
      )
    ).toBe(
      "Everyone in Kai Spezis (1 person) · Everyone with the role user · Group grp_sales · 1 more with access"
    );
    expect(audienceLine({ holders: [], hiddenHolders: 0 }, t, "en")).toBe("Only instance admins");
    // A count with nobody named before it is not "more".
    expect(audienceLine({ holders: [], hiddenHolders: 4 }, t, "en")).toBe("4 with access");
    expect(audienceLine({ holders: [], hiddenHolders: 3 }, translate("de").t, "de")).toBe(
      "3 mit Zugriff"
    );
    // As whom a Workflow runs is named to who administers users; anyone else reads the kind.
    const nightly = required(usedBy.workflows[0]);
    expect(fillerLine(nightly, t, "en")).toBe(
      "Copies from Exampledata and CRM · Runs as Nightly runner"
    );
    expect(fillerLine({ ...nightly, account: {} }, translate("de").t, "de")).toBe(
      "Kopiert aus Exampledata und CRM · Läuft als technisches Konto"
    );
  });
});

describe("Prüfen: the records of a Data Store that wait for a person (REC-2)", () => {
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
      quote: "Baujahr 1991",
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
  const review = (items: DataStoreFlaggedItem[] = flagged, nextCursor?: string) => ({
    useFlagged: () => ready({ items, ...(nextCursor ? { nextCursor } : {}) }),
    decide: () => Promise.resolve(undefined)
  });

  it("groups by object and field, stands the candidates side by side with the page each cites, and offers the three decisions", () => {
    const page = render(
      { kindPath: "data-stores", name: "objects" },
      { records: true, review: review() }
    );
    expect(page).toContain('id="review"');
    expect(page).toContain(">Review</");
    expect(page).toContain('data-review-object="1402"');
    expect(page).toContain(">objekt 1402</h3>");
    expect(page).toContain('data-review-field="kaufpreis"');
    // A number is written as the reader's language writes it.
    expect(page).toContain(">485,000<");
    expect(page).toContain(">Conflict</span>");
    expect(page).toContain(">Not evidenced</span>");
    expect(page).toContain(">Quote not found on the page</span>");
    // Each candidate cites its document and page.
    expect(page).toContain("a1.pdf, p. 3");
    expect(page).toContain("b1.pdf, p. 4");
    expect(page).toContain("“Kaufpreis 200”");
    expect(page.match(/data-review-confirm=""/gu)).toHaveLength(3);
    expect(page.match(/data-review-correct=""/gu)).toHaveLength(3);
    // The document without an object waits apart, with "Assign object".
    expect(page).toContain('data-review-document="e4"');
    expect(page).toContain(">Assign object</button>");

    const german = render(
      { kindPath: "data-stores", name: "objects" },
      { records: true, review: review(), locale: "de" }
    );
    for (const said of [
      ">Prüfen</",
      ">Widerspruch</span>",
      ">Nicht belegt</span>",
      ">Bestätigen</button>",
      ">Korrigieren</button>",
      ">Objekt zuordnen</button>",
      "Dokumente ohne Objekt",
      ">485.000<"
    ]) {
      expect(german, said).toContain(said);
    }
  });

  it("shows a corrected candidate's value read beside the person's, with who and when (REC-KEEP)", () => {
    const corrected = [
      candidate("a1", {
        value: 1250000,
        correctedValue: 1205000,
        state: "corrected",
        decidedBy: "records-admin",
        decidedByName: "Rita Reviewer",
        decidedAt: "2026-10-25T09:30:00.000Z"
      }),
      candidate("b1", { value: 1300000, state: "confirmed" }),
      candidate("c1", { value: 1300000 })
    ];
    const english = render(
      { kindPath: "data-stores", name: "objects" },
      { records: true, review: review(corrected) }
    );
    expect(english).toContain('data-review-corrected=""');
    expect(english).toMatch(/<dt[^>]*>Read<\/dt>/u);
    expect(english).toContain("1,250,000");
    expect(english).toMatch(/<dt[^>]*>Corrected<\/dt>/u);
    expect(english).toContain(">1,205,000<");
    expect(english).toContain(
      `By Rita Reviewer on ${new Date("2026-10-25T09:30:00.000Z").toLocaleDateString("en")}`
    );
    expect(english).not.toContain("records-admin");
    // The field's summary names the value each candidate stands for.
    expect(english).toContain("1,205,000 · 1,300,000 · 1,300,000");
    const german = render(
      { kindPath: "data-stores", name: "objects" },
      { records: true, review: review(corrected), locale: "de" }
    );
    expect(german).toMatch(/<dt[^>]*>Gelesen<\/dt>/u);
    expect(german).toContain("1.250.000");
    expect(german).toMatch(/<dt[^>]*>Korrigiert<\/dt>/u);
    expect(german).toContain(">1.205.000<");
    expect(german).toContain(
      `Von Rita Reviewer am ${new Date("2026-10-25T09:30:00.000Z").toLocaleDateString("de")}`
    );
    // Without a name to show, the account is gone: it reads as a deleted account, never as
    // the account id (ERASE-ACTOR-IDS).
    const gone = review(corrected.map(({ decidedByName: _, ...rest }) => rest));
    const unnamed = render(
      { kindPath: "data-stores", name: "objects" },
      { records: true, review: gone, locale: "de" }
    );
    expect(unnamed).toContain(
      `>Von Gelöschtes Konto am ${new Date("2026-10-25T09:30:00.000Z").toLocaleDateString("de")}<`
    );
    expect(unnamed).not.toContain("records-admin");
    const unnamedEnglish = render(
      { kindPath: "data-stores", name: "objects" },
      { records: true, review: gone }
    );
    expect(unnamedEnglish).toContain(
      `>By Deleted account on ${new Date("2026-10-25T09:30:00.000Z").toLocaleDateString("en")}<`
    );
    expect(unnamedEnglish).not.toContain("records-admin");
  });

  it("has no section without a records rule, nor for a reader who may not decide, and says when nothing waits", () => {
    expect(
      render({ kindPath: "data-stores", name: "visit-log" }, { review: review() })
    ).not.toContain('id="review"');
    const refused = render(
      { kindPath: "data-stores", name: "objects" },
      {
        records: true,
        review: {
          useFlagged: () => ({ status: "refused" }),
          decide: () => Promise.resolve(undefined)
        }
      }
    );
    expect(refused).not.toContain('id="review"');
    const empty = render(
      { kindPath: "data-stores", name: "objects" },
      { records: true, review: review([]) }
    );
    expect(empty).toContain("Nothing waits for review.");
    const more = render(
      { kindPath: "data-stores", name: "objects" },
      { records: true, review: review(flagged, "next") }
    );
    expect(more).toContain(">Show more fields</button>");
  });

  it("counts each flagged field once and each field of a document without an object", () => {
    const groups = groupFlagged(flagged);
    expect(groups.fieldCount).toBe(3);
    expect(
      groups.objects.map((object) => object.fields.map((field) => field.candidates.length))
    ).toEqual([[2, 1]]);
    expect(groups.documents.map((document) => document.fileName)).toEqual(["expose.pdf"]);
  });

  it("writes a number as the reader's language does, a year without a separator", () => {
    expect(reviewValueText(485000, "de")).toBe("485.000");
    expect(reviewValueText(485000, "en")).toBe("485,000");
    expect(reviewValueText(1987, "de")).toBe("1987");
    expect(reviewValueText(87.5, "de")).toBe("87,5");
    expect(reviewValueText(492500, "de", { grouping: false })).toBe("492500");
    expect(reviewValueText("Am Hang 3")).toBe("Am Hang 3");
  });

  it("reads a typed value as the kind the candidate holds", () => {
    expect(reviewValueOf("150", 100)).toEqual({ value: 150 });
    expect(reviewValueOf("1.234,5", 100, "de")).toEqual({ value: 1234.5 });
    expect(reviewValueOf("492.500", 100, "de")).toEqual({ value: 492500 });
    expect(reviewValueOf("87,5", 100, "de")).toEqual({ value: 87.5 });
    expect(reviewValueOf("1,234.5", 100, "en")).toEqual({ value: 1234.5 });
    expect(reviewValueOf("87.5", 100, "en")).toEqual({ value: 87.5 });
    expect(reviewValueOf("teuer", 100)).toEqual({ invalid: "number" });
    expect(reviewValueOf("ja", true)).toEqual({ value: true });
    expect(reviewValueOf("150", "Nebenweg 1")).toEqual({ value: "150" });
    expect(reviewValueOf("  ", "x")).toEqual({ invalid: "empty" });
  });
});
