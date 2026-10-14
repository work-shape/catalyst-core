import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { LocaleCode } from "@vivd-catalyst/api-client";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  dataStoreKindOn,
  dataStoreStateView,
  DataStoreValueDialog,
  formatDataStoreSize,
  resolveBuildRights,
  type BuildAsset,
  type BuildAssetRow,
  type BuildLocation,
  type BuildSource,
  type DataStoreListed,
  type DataStoreRead,
  type DataStoreRowsPage,
  type DataStoreSchema,
  type DataStoreSource,
  type DataStoreState,
  type DataStoreUsedBy,
  type DataStoreValue,
  usingPageRoute
} from "@vivd-catalyst/chat-ui/build-area";
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

const usedBy: DataStoreUsedBy = {
  apps: [{ id: "asset_visits_board", name: "visits-board", title: "Visits board" }],
  workflows: [{ id: "asset_nightly", name: "nightly-rollup", title: "Nightly rollup" }],
  hidden: { apps: 1, workflows: 2 },
  truncated: false
};

const nothingUses: DataStoreUsedBy = {
  apps: [],
  workflows: [],
  hidden: { apps: 0, workflows: 0 },
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
}

function storeSource(answers: StoreAnswers = {}): DataStoreSource {
  return {
    useStoreState: (store) => answers.states?.[store] ?? ready(storeState(store)),
    useSchema: () => answers.schema ?? ready(schema),
    useListed: () => answers.listed ?? ready({ items: [], truncated: false }),
    useRowsPage: () => answers.rows ?? ready(visitRows),
    useValue: () => answers.value ?? { status: "loading" },
    useUsedBy: () => answers.usedBy ?? ready(usedBy),
    // The instance's source decides this by `usingPageRoute`; here only the App has a page.
    useUsingPage: () => (kind, name) =>
      kind === "app" ? { href: `/w/ws_1/apps/${name}`, open: noop } : undefined
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

function storeAsset(name: string): BuildAsset {
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
      migrations: []
    },
    updatedAt: "2026-10-08T10:00:00.000Z"
  };
}

interface RenderInput extends StoreAnswers {
  list?: BuildAssetRow[];
  /** The instance has the module on and the reader may read stores. */
  on?: boolean;
  locale?: LocaleCode;
}

/** The Build frame at an address, with the Data Store kind on fixed answers. */
function render(location: BuildLocation, input: RenderInput = {}): string {
  const context = platformContext();
  const source: BuildSource = {
    kinds: [
      { kind: "agent", canCreate: false, canDelete: false },
      ...(input.on === false ? [] : [{ kind: "data_store", canCreate: true, canDelete: true }])
    ],
    rights: resolveBuildRights({ permissions: ["config_assets.write"] }, context),
    loading: false,
    error: undefined,
    reload: async () => undefined,
    useList: (kind) => ({
      rows: kind === "data_store" ? (input.list ?? []) : [],
      error: undefined,
      hasMore: false,
      loadingMore: false,
      loadMore: noop,
      retry: noop
    }),
    useAsset: (_kind, name) => ({
      status: "ready",
      asset: storeAsset(name),
      loadedAt: 1,
      reload: async () => "loaded"
    }),
    exists: async () => true,
    writes: {
      put: async () => ({ revision: 1 }),
      delete: async () => undefined,
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    }
  };
  const planted = dataStoreKindOn(() => storeSource(input));
  const kinds = buildAssetKinds.map((kind) => (kind.kind === "data_store" ? planted : kind));
  return renderToStaticMarkup(
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
    for (const said of [
      ">Instance<",
      ">Workspace<",
      'data-data-store-row-state="ready"',
      "Ready",
      "8 MB",
      'data-data-store-row-state="migrations_pending"',
      "Migrations pending",
      "2 open on the server",
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
      "Data stores are created with their migrations through the CLI or the API and cannot be changed here."
    );
  });

  it("says in the empty list what a store is and how one comes to exist, and has no item where the instance lists none", () => {
    const empty = render({ kindPath: "data-stores" });
    expect(empty).toContain("A data store is a database the platform hosts");
    expect(empty).toContain(
      "A person with the right to create data stores adds one through the CLI or the API."
    );
    expect(empty).not.toContain(">New ");

    const off = render({ kindPath: "data-stores" }, { on: false });
    expect(off).not.toContain("Data stores");

    expect(render({ kindPath: "data-stores" }, { locale: "de" })).toContain(
      "Noch keine Datenspeicher."
    );
  });

  it("shows a store's state, its tables with columns, types and row estimates, and the first page of a table with long values cut", () => {
    const page = render({ kindPath: "data-stores", name: "visit-log" });

    expect(page).toContain(">Visit log</h1>");
    // The id stands in the first section with a copy button, and not in the one-row head.
    expect(page.indexOf("data-asset-identifier")).toBeGreaterThan(page.indexOf("</header>"));
    expect(page).toMatch(/data-asset-identifier[^]*?>visit-log<\/code>/u);
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
    expect(page).toContain("Sessions of the server can be seen");
    expect(page).toContain("The tables show once the store is ready.");
    expect(page).not.toContain("must not be read");

    const german = render({ kindPath: "data-stores", name: "visit-log" }, { locale: "de" });
    expect(german).toContain("Bereit");
    expect(german).toContain("8 MB von 500 MB");
    expect(german).toContain("etwa 1.240 Zeilen");
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

  it("lists the Apps and Workflows that use a store, links the ones that have a page and counts the ones the reader cannot see", () => {
    const page = render(address);
    expect(page).toContain(">Used by</h2>");
    expect(page).toContain('data-data-store-used-by="app"');
    expect(page).toContain(">Visits board<");
    expect(page).toContain('href="/w/ws_1/apps/visits-board"');
    expect(page).toContain('data-data-store-used-by="workflow"');
    expect(page).toContain(">Nightly rollup<");
    expect(page).not.toContain('nightly-rollup"');
    expect(page).toContain("and 3 more you cannot see");

    expect(render(address, { locale: "de" })).toContain("und 3 weitere, die du nicht sehen kannst");
  });

  it("says in one sentence that nothing uses a store, that only hidden ones do, and that the reader may not see it", () => {
    expect(render(address, { usedBy: ready(nothingUses) })).toContain(
      "No published app or workflow uses this store."
    );
    expect(
      render(address, { usedBy: ready({ ...nothingUses, hidden: { apps: 1, workflows: 0 } }) })
    ).toContain("1 app or workflow you cannot see uses this store.");
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
});
