import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  DATA_STORE_MANIFEST_FILE,
  KNOWLEDGE_BASE_ASSET_KIND,
  type JsonObject
} from "@vivd-catalyst/core";
import { required } from "./support/assertions";
import {
  clientInstanceId,
  useDataStoreInstance,
  type DataStoreInstance
} from "./support/data-store-instance";
import { fileTestDatabaseUrl } from "./support/test-database";

// What a Knowledge Base on a Data Store may read: exactly the tables its published revision
// describes. Its query connects as a role of its own, so neither the statement nor the person
// who sends it reaches the store's other tables, through the catalog, a view, a function, or
// a change of role. Narrowing the description takes the access away; deleting the Knowledge
// Base drops the role.

const KB = "findings-kb";
const SALARY = "salary-4711";

/** A store with the described table, a table nobody describes, and two ways around it. */
const storeFiles = [
  { path: DATA_STORE_MANIFEST_FILE, text: "id: findings\nname: Findings\n" },
  {
    path: "migrations/0001_init.sql",
    text: `create table findings (client_id text not null, rule_id text not null);
      create table payroll (person text not null, salary text not null);
      create view payroll_view as select * from payroll;
      create function payroll_total() returns text language sql security definer
        as $$ select string_agg(salary, ',') from payroll $$;`
  }
];

const definition = (tables: string[]): JsonObject => ({
  name: KB,
  title: "Findings",
  description: "What the monthly check of bookings found.",
  backend: { dataStore: "findings" },
  tables: tables.map((name) => ({ name, description: `One row of ${name}.` }))
});

describe("the role a Knowledge Base on a Data Store reads as", () => {
  const { start, put, publish, settle } = useDataStoreInstance();

  /** The store with one finding and one salary, and the Knowledge Base on it published. */
  async function world(tables = ["findings"]) {
    const instance = await start(true, undefined, undefined, true);
    expect((await put(instance, storeFiles)).statusCode).toBe(200);
    expect((await publish(instance, 1)).statusCode).toBe(200);
    const record = await settle(instance, 1);
    for (const [table, row] of [
      ["findings", { client_id: "client-7", rule_id: "vat-rate" }],
      ["payroll", { person: "Ada", salary: SALARY }]
    ] as const) {
      const inserted = await instance.api.call("data_stores.insert", {
        params: { store: "findings" },
        payload: { table, rows: [row] }
      });
      expect(inserted.statusCode, inserted.body).toBe(200);
    }
    await writeKnowledgeBase(instance, tables, null);
    return { instance, database: record.location.database };
  }

  async function writeKnowledgeBase(
    { api }: DataStoreInstance,
    tables: string[],
    expectedRevision: number | null
  ) {
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB };
    const written = await api.call("assets.put", {
      params,
      payload: { config: definition(tables), expectedRevision }
    });
    expect(written.statusCode, written.body).toBe(200);
    const { revision } = written.json<{ revision: number }>();
    const published = await api.call("assets.publish", { params, payload: { revision } });
    expect(published.statusCode, published.body).toBe(200);
    return revision;
  }

  const query = ({ api }: DataStoreInstance, sql: string) =>
    api.call("knowledge_bases.query", { params: { knowledgeBase: KB }, payload: { sql } });

  /** The Knowledge Base's roles on the cluster, found by the database they may connect to. */
  async function readerRoles(database: string) {
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice: () => undefined });
    try {
      return await sql<{ name: string; superuser: boolean; memberOf: number }[]>`
        select r.rolname as name, r.rolsuper as superuser,
          (select count(*)::int from pg_auth_members m where m.member = r.oid) as "memberOf"
        from pg_roles r
        where r.rolname like 'catalyst_kb_%' and has_database_privilege(r.oid, ${database}, 'CONNECT')`;
    } finally {
      await sql.end();
    }
  }

  it("reads the described table and nothing else of the store, however the statement asks", async () => {
    const { instance, database } = await world();

    const described = await query(instance, "select rule_id from findings");
    expect(described.statusCode, described.body).toBe(200);
    expect(described.json()).toMatchObject({ rows: [{ rule_id: "vat-rate" }] });

    const roles = await readerRoles(database);
    expect(roles).toEqual([
      { name: expect.stringMatching(/^catalyst_kb_/u), superuser: false, memberOf: 0 }
    ]);
    const app = required(
      await instance.stores.dataStores.findDataStoreByName({ clientInstanceId, name: "findings" })
    ).roles.app;

    for (const probe of [
      "select * from payroll",
      "select * from public.payroll",
      "select * from payroll_view",
      "select payroll_total()",
      "select query_to_xml('select * from payroll', true, false, '')",
      `select set_config('role', '${app}', true), (select count(*) from payroll)`,
      "select set_config('role', 'none', true), query_to_xml('select * from payroll', true, false, '')",
      `select set_config('session_authorization', '${app}', true)`,
      "select * from pg_catalog.pg_statistic",
      "select pg_catalog.pg_read_file('postgresql.conf')",
      "set role none",
      "reset role",
      `set session authorization "${app}"`
    ]) {
      const answer = await query(instance, probe);
      expect(answer.statusCode, probe).toBeGreaterThanOrEqual(400);
      expect(answer.statusCode, probe).toBeLessThan(500);
      expect(answer.body, probe).not.toContain(SALARY);
    }
    // The role reaches no other table through the catalog either: it sees names, never rows.
    const catalog = await query(
      instance,
      "select count(*)::int as readable from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'v') and pg_catalog.has_table_privilege(c.oid, 'select')"
    );
    expect(catalog.json()).toMatchObject({ rows: [{ readable: 1 }] });
  });

  it("follows the published description: a wider revision opens the table, a narrower one closes it", async () => {
    const { instance } = await world(["findings", "payroll"]);
    const payroll = () => query(instance, "select salary from payroll");

    expect((await payroll()).json()).toMatchObject({ rows: [{ salary: SALARY }] });

    await writeKnowledgeBase(instance, ["findings"], 1);

    const narrowed = await payroll();
    expect(narrowed.statusCode).toBeGreaterThanOrEqual(400);
    expect(narrowed.body).not.toContain(SALARY);
    expect((await query(instance, "select rule_id from findings")).statusCode).toBe(200);
  });

  it("keeps a function a later migration makes closed to it, and open to the store's app role", async () => {
    const { instance } = await world();
    const later = {
      path: "migrations/0002_later.sql",
      text: `create function payroll_later() returns text language sql security definer
        as $$ select string_agg(salary, ',') from payroll $$;`
    };
    expect((await put(instance, [...storeFiles, later], 1)).statusCode).toBe(200);
    expect((await publish(instance, 2)).statusCode).toBe(200);
    await settle(instance, 2);

    const refused = await query(instance, "select payroll_later()");
    const own = await instance.api.call("data_stores.query", {
      params: { store: "findings" },
      payload: { sql: "select payroll_later() as total" }
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).not.toContain(SALARY);
    expect(own.json()).toMatchObject({ rows: [{ total: SALARY }] });
  });

  it("takes a grant a migration added by hand away again at the next check", async () => {
    const { instance, database } = await world();
    const [reader] = await readerRoles(database);
    const owner = new URL(await fileTestDatabaseUrl());
    owner.pathname = `/${database}`;
    const sql = postgres(owner.toString(), { max: 1, onnotice: () => undefined });
    try {
      await sql.unsafe(`grant select on payroll to "${required(reader).name}"`);
    } finally {
      await sql.end();
    }
    expect((await query(instance, "select salary from payroll")).body).toContain(SALARY);

    const checked = await instance.api.call("knowledge_bases.check", {
      params: { knowledgeBase: KB },
      headers: { "idempotency-key": "check-after-grant" }
    });

    expect(checked.statusCode, checked.body).toBe(200);
    expect((await query(instance, "select salary from payroll")).body).not.toContain(SALARY);
  });

  it("drops its role when the Knowledge Base is deleted, and the store keeps its rows", async () => {
    const { instance, database } = await world();
    const reader = required((await readerRoles(database))[0]).name;
    const asset = required(
      await instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        name: KB
      })
    );

    const deleted = await instance.api.call("assets.delete", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { expectedRevision: asset.revision }
    });

    expect(deleted.statusCode, deleted.body).toBe(200);
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice: () => undefined });
    try {
      expect(await sql`select 1 from pg_roles where rolname = ${reader}`).toEqual([]);
    } finally {
      await sql.end();
    }
    const rows = await instance.api.call("data_stores.query", {
      params: { store: "findings" },
      payload: { sql: "select count(*)::int as count from payroll" }
    });
    expect(rows.json()).toMatchObject({ rows: [{ count: 1 }] });
  });
});
