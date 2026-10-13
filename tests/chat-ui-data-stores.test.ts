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
  formatDataStoreSize,
  resolveBuildRights,
  type BuildAsset,
  type BuildAssetRow,
  type BuildLocation,
  type BuildSource,
  type DataStoreRead,
  type DataStoreRows,
  type DataStoreSchema,
  type DataStoreSource,
  type DataStoreState
} from "@vivd-catalyst/chat-ui/build-area";
import { platformContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The Data Store list and page against the answers of the contract (`data_stores.get`,
// `.describe`, `.preview_rows`), handed in where the instance's answers will stand. Every test
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

const visitRows: DataStoreRows = {
  columns: [
    { name: "id", type: "integer", nativeType: "bigint" },
    { name: "path", type: "text", nativeType: "text" },
    { name: "referrer", type: "text", nativeType: "text" },
    { name: "tags", type: "other", nativeType: "jsonb" }
  ],
  rows: [
    { id: 1, path: "/pricing", referrer: LONG_REFERRER, tags: { campaign: "autumn" } },
    { id: 2, path: "/docs", referrer: null, tags: null }
  ],
  truncated: true
};

function ready<Answer>(data: Answer): DataStoreRead<Answer> {
  return { status: "ready", data };
}

interface StoreAnswers {
  states?: Record<string, DataStoreRead<DataStoreState>>;
  schema?: DataStoreRead<DataStoreSchema>;
  rows?: DataStoreRead<DataStoreRows>;
}

function storeSource(answers: StoreAnswers = {}): DataStoreSource {
  return {
    useStoreState: (store) => answers.states?.[store] ?? ready(storeState(store)),
    useSchema: () => answers.schema ?? ready(schema),
    useRows: () => answers.rows ?? ready(visitRows)
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
  rows?: DataStoreRead<DataStoreRows>;
  list?: BuildAssetRow[];
  /** The instance has the module on and the reader may read stores. */
  listed?: boolean;
  locale?: LocaleCode;
}

/** The Build frame at an address, with the Data Store kind on fixed answers. */
function render(location: BuildLocation, input: RenderInput = {}): string {
  const context = platformContext();
  const source: BuildSource = {
    kinds: [
      { kind: "agent", canCreate: false, canDelete: false },
      ...(input.listed === false ? [] : [{ kind: "data_store", canCreate: true, canDelete: true }])
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
      "2 open on the server"
    ]) {
      expect(list, said).toContain(said);
    }
    // Nothing is started here: a store is made by an agent or through the API.
    expect(list).not.toContain(">New ");
    expect(list).not.toContain("More actions");
    expect(list).toContain(
      "Data stores are created by an agent or through the API and cannot be changed here."
    );
  });

  it("says in the empty list what a store is and how one comes to exist, and has no item where the instance lists none", () => {
    const empty = render({ kindPath: "data-stores" });
    expect(empty).toContain("A data store is a database the platform hosts");
    expect(empty).toContain("An agent or the API creates one.");
    expect(empty).not.toContain(">New ");

    const off = render({ kindPath: "data-stores" }, { listed: false });
    expect(off).not.toContain("Data stores");

    expect(render({ kindPath: "data-stores" }, { locale: "de" })).toContain(
      "Noch keine Datenspeicher."
    );
  });

  it("shows a store's state, its tables with columns, types and row estimates, and the first rows of a table with long values cut", () => {
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
    expect(page).toContain("The first 2 rows. The table holds more.");
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
