import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  NoopAuditRecorder,
  asClientInstanceId,
  asUserId,
  createPlatformId,
  type AssetScope,
  type AuthenticatedUser,
  type JsonObject,
  type PermissionGrant
} from "@work-shape/catalyst-core";
import { accessOf } from "./support/access";
import { eventually, required } from "./support/assertions";
import {
  finding,
  init,
  manifest,
  refusal,
  useDataStoreWorld,
  type StoreFile
} from "./support/data-store-world";

// The reads the page of a store needs, against real Postgres: the rows of a table a page at a
// time, what the last measurement found of a store on the list, and what uses a store.

const notes: StoreFile = {
  path: "migrations/0002_notes.sql",
  text: `create table notes (body text);
    create table pairs (b integer not null, a text not null, note text, primary key (b, a));`
};

const pageSchema = z.object({
  order: z.unknown(),
  rows: z.array(
    z.object({
      at: z.string(),
      values: z.record(z.string(), z.unknown()),
      cut: z.array(z.string()).optional()
    })
  ),
  next: z.string().optional(),
  valueMaxChars: z.number()
});

const person = (id: string, roles: AuthenticatedUser["roles"]): AuthenticatedUser => ({
  id,
  externalUserId: id,
  displayLabel: id,
  roles,
  permissionRefs: [],
  clientInstanceId: asClientInstanceId("data-store-test"),
  authSource: "test"
});
const admin = person("usr_page_admin", ["admin"]);

describe("the reads of a Data Store's page", () => {
  const { db, setup, publish, settle, published, call, connect, recordOf } =
    useDataStoreWorld("data_store_page_reads");

  type World = Awaited<ReturnType<typeof published>>;

  /** Executes one operation of the store `findings` by the last part of its name. */
  async function read(world: World, part: string, input: unknown, access = accessOf(admin)) {
    const operation = required(
      await world.dataStores.operationSource.resolve(`data_store.findings.${part}`)
    );
    return operation.execute(operation.inputSchema.parse(input), {
      runId: createPlatformId<"OperationRunId">("opr"),
      actor: admin,
      origin: { kind: "user" },
      correlationId: "data-store-page",
      runtime: {},
      access,
      audit: new NoopAuditRecorder()
    });
  }

  /** Writes an asset and publishes it, as its kind's own workflow would. */
  async function publishAssetOf(
    world: World,
    kind: string,
    name: string,
    config: JsonObject,
    scope?: AssetScope
  ) {
    const { clientInstanceId } = world;
    const key = `${kind}:${name}`;
    const written = await db.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [key]: null },
      mutations: [{ type: "upsert", kind, name, config, draft: true, ...(scope ? { scope } : {}) }]
    });
    const revision = required(written.revisions[key]);
    const stored = required(
      await db.store.configAssets.getConfigAssetRevision({
        clientInstanceId,
        kind,
        name,
        revision
      })
    );
    const assetId = required(written.assetIds[key]);
    await db.store.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      kind,
      name,
      assetId,
      revision,
      revisionId: stored.id
    });
    return assetId;
  }

  const page = async (world: World, input: JsonObject) =>
    pageSchema.parse(await read(world, "rows", input));

  it("pages through a table in the order of its primary key until its last row, with a page size the server bounds", async () => {
    const world = await published("keyset");
    await call(world, "insert", {
      table: "findings",
      rows: Array.from({ length: 120 }, (_, index) => finding(index))
    });

    const seen: unknown[] = [];
    let after: string | undefined;
    const sizes: number[] = [];
    do {
      const answer = await page(world, { table: "findings", ...(after ? { after } : {}) });
      expect(answer.order).toEqual({ by: "key", columns: ["id"] });
      sizes.push(answer.rows.length);
      seen.push(...answer.rows.map(({ values }) => values.client_id));
      after = answer.next;
    } while (after !== undefined);

    expect(sizes).toEqual([50, 50, 20]);
    expect(seen).toEqual(Array.from({ length: 120 }, (_, index) => `client-${index}`));
    // A page is as large as the caller asks, up to the bound.
    expect((await page(world, { table: "findings", limit: 7 })).rows).toHaveLength(7);
    await expect(read(world, "rows", { table: "findings", limit: 51 })).rejects.toThrow();
    // A row added behind a page that was read is on the next page.
    const first = await page(world, { table: "findings", limit: 120 - 70 });
    expect(first.next).toBeDefined();
  });

  it("declares a read of rows: data_store.read, the scope of rows, recorded on every call", async () => {
    const world = await published("declared");
    for (const part of ["rows", "value"]) {
      expect(
        await world.dataStores.operationSource.resolve(`data_store.findings.${part}`)
      ).toMatchObject({
        effect: "reading",
        action: "data_store.read",
        scope: "data_store_rows:read",
        recordsEveryCall: true,
        module: "dataStores"
      });
    }
  });

  it("orders by every column of a key of several, in the order of its index, and by text exactly", async () => {
    const world = await published("pairs", [manifest(), init, notes]);
    const store = connect(world.record.location.database);
    await store`insert into pairs (b, a) select n % 3, 'a' || n from generate_series(1, 9) n`;

    const got: unknown[] = [];
    let after: string | undefined;
    do {
      const answer = await page(world, { table: "pairs", limit: 4, ...(after ? { after } : {}) });
      expect(answer.order).toEqual({ by: "key", columns: ["b", "a"] });
      got.push(...answer.rows.map(({ values }) => `${String(values.b)}:${String(values.a)}`));
      after = answer.next;
    } while (after !== undefined);

    expect(got).toEqual(["0:a3", "0:a6", "0:a9", "1:a1", "1:a4", "1:a7", "2:a2", "2:a5", "2:a8"]);
  });

  it("pages a table without a key in the order its rows lie in, and says so", async () => {
    const world = await published("physical", [manifest(), init, notes]);
    const store = connect(world.record.location.database);
    await store`insert into notes select 'note ' || n from generate_series(1, 5) n`;

    const first = await page(world, { table: "notes", limit: 3 });
    expect(first.order).toEqual({ by: "physical" });
    const second = await page(world, { table: "notes", limit: 3, after: required(first.next) });
    expect([...first.rows, ...second.rows].map(({ values }) => values.body)).toEqual([
      "note 1",
      "note 2",
      "note 3",
      "note 4",
      "note 5"
    ]);
    expect(second.next).toBeUndefined();
  });

  it("answers every row once for every kind of table and every page size, also where no key holds for all its rows", async () => {
    const kinds: StoreFile = {
      path: "migrations/0002_kinds.sql",
      text: `create table plain (n integer not null, label text);
        create table parted (n integer not null, label text) partition by range (n);
        create table parted_low partition of parted for values from (0) to (52);
        create table parted_high partition of parted for values from (52) to (1000);
        create table keyed_parted (n integer primary key, label text) partition by hash (n);
        create table keyed_parted_0 partition of keyed_parted for values with (modulus 2, remainder 0);
        create table keyed_parted_1 partition of keyed_parted for values with (modulus 2, remainder 1);
        create table parent (n integer primary key, label text);
        create table child () inherits (parent);`
    };
    const world = await published("kinds", [manifest(), init, kinds]);
    const store = connect(world.record.location.database);
    // No count is a multiple of a page size above one. The first part of `parted` and of
    // `parent` holds more rows than the largest page, so a page of every size starts behind a
    // row of the first part and goes on in the second. The child repeats keys of its parent.
    for (const table of ["plain", "parted", "keyed_parted"]) {
      await store.unsafe(
        `insert into ${table} select n, 'row ' || n from generate_series(0, 56) n`
      );
    }
    await store`insert into parent select n, 'parent ' || n from generate_series(0, 51) n`;
    await store`insert into child select n, 'child ' || n from generate_series(0, 8) n`;
    const expected: Record<string, [string, number]> = {
      plain: ["physical", 57],
      parted: ["physical", 57],
      keyed_parted: ["key", 57],
      // The key of the parent does not hold for the rows of its child.
      parent: ["physical", 61],
      child: ["physical", 9],
      parted_low: ["physical", 52]
    };

    /** Reads the table a page of `limit` at a time, from its first page to its last. */
    async function walk(table: string, by: string, count: number, limit: number) {
      const labels: unknown[] = [];
      const places = new Set<string>();
      let after: string | undefined;
      do {
        const answer = await page(world, { table, limit, ...(after ? { after } : {}) });
        expect(answer.order, table).toMatchObject({ by });
        expect(answer.rows.length, `${table} by ${limit}`).toBeLessThanOrEqual(limit);
        for (const row of answer.rows) {
          labels.push(row.values.label);
          places.add(row.at);
        }
        // A cursor that answers a row again ends here, and not at the timeout.
        expect(labels.length, `${table} by ${limit}`).toBeLessThanOrEqual(count);
        after = answer.next;
      } while (after !== undefined);
      expect(labels, `${table} by ${limit}`).toHaveLength(count);
      expect(new Set(labels).size, `${table} by ${limit}`).toBe(count);
      expect(places.size, `${table} by ${limit}`).toBe(count);
    }
    // Nothing writes to the store while it is read, so the tables are read side by side. Every
    // read ends before the test does, also where one of them failed.
    const walked = await Promise.allSettled(
      Object.entries(expected).map(async ([table, [by, count]]) => {
        for (const limit of [1, 7, 50]) await walk(table, by, count, limit);
      })
    );
    for (const outcome of walked) if (outcome.status === "rejected") throw outcome.reason;
    // A row of a part of a table is found again by its part and its place in it.
    const firstPage = await page(world, { table: "parted", limit: 50 });
    const [beyond] = (
      await page(world, { table: "parted", limit: 50, after: required(firstPage.next) })
    ).rows.slice(-1);
    expect(
      await read(world, "value", { table: "parted", column: "label", at: required(beyond).at })
    ).toEqual({ value: beyond?.values.label });
  });

  it("never reads a long value for a page: a text by its beginning, another value above the read bound not at all", async () => {
    const world = await published("long", [manifest(), init, notes]);
    const store = connect(world.record.location.database);
    // Text that does not shrink when it is stored, 6 MB a row, and a JSON value of 300 kB.
    await store`insert into notes
      select (select string_agg(md5((n * 1000000 + i)::text), '') from generate_series(1, 190000) i)
      from generate_series(1, 4) n`;
    await store`insert into findings (run_id, client_id, rule_id, revision, severity, details)
      select 'run', 'client', 'rule', 1, 'info',
        jsonb_build_object('text', (select string_agg(md5(i::text), '') from generate_series(1, 9000) i))`;

    const texts = await page(world, { table: "notes" });
    expect(texts.rows).toHaveLength(4);
    for (const row of texts.rows) {
      expect(row.cut).toEqual(["body"]);
      expect(row.values.body).toHaveLength(1_000);
    }
    // The JSON value is named as cut and answered empty: it was not read. One read has it whole.
    const [finding] = (await page(world, { table: "findings" })).rows;
    expect(finding?.cut).toEqual(["details"]);
    expect(finding?.values.details).toBe("");
    const whole = z.object({ value: z.object({ text: z.string() }) }).parse(
      await read(world, "value", {
        table: "findings",
        column: "details",
        at: required(finding).at
      })
    );
    expect(whole.value.text).toHaveLength(9_000 * 32);
  });

  it("cuts a long value at a thousand characters, names the column, and reads the value whole by one more read", async () => {
    const world = await published("cut", [manifest(), init, notes]);
    const long = "x".repeat(5_000);
    await call(world, "insert", {
      table: "findings",
      rows: [finding(1, { details: { text: long } }), finding(2)]
    });
    const store = connect(world.record.location.database);
    await store`insert into notes values (${long})`;

    const answer = await page(world, { table: "findings" });
    expect(answer.valueMaxChars).toBe(1_000);
    const [cut, whole] = answer.rows;
    expect(cut?.cut).toEqual(["details"]);
    expect(cut?.values.details).toHaveLength(1_000);
    expect(whole?.cut).toBeUndefined();
    expect(whole?.values.details).toEqual({ booking: 2 });
    expect(
      await read(world, "value", { table: "findings", column: "details", at: required(cut).at })
    ).toEqual({ value: { text: long } });

    // A row of a table without a key is found again by where it lies.
    const [note] = (await page(world, { table: "notes" })).rows;
    expect(note?.cut).toEqual(["body"]);
    expect(
      await read(world, "value", { table: "notes", column: "body", at: required(note).at })
    ).toEqual({ value: long });
  });

  it("refuses a cursor that names no row of the table, an unknown table and column, and a row that is gone", async () => {
    const world = await published("refusals", [manifest(), init, notes]);
    await call(world, "insert", { table: "findings", rows: [finding(1)] });
    const [row] = (await page(world, { table: "findings" })).rows;
    const at = required(row).at;

    expect(
      await refusal(read(world, "rows", { table: "findings", after: "nonsense" }))
    ).toMatchObject({
      details: { reason: "cursor_invalid" }
    });
    // A cursor of a table with a key on a table without one.
    expect(await refusal(read(world, "rows", { table: "notes", after: at }))).toMatchObject({
      details: { reason: "cursor_invalid" }
    });
    expect(await refusal(read(world, "rows", { table: "nowhere" }))).toMatchObject({
      details: { reason: "table_unknown" }
    });
    expect(
      await refusal(read(world, "value", { table: "findings", column: "colour", at }))
    ).toMatchObject({ details: { reason: "column_unknown" } });
    await connect(world.record.location.database)`delete from findings`;
    expect(
      await refusal(read(world, "value", { table: "findings", column: "details", at }))
    ).toMatchObject({ code: "NOT_FOUND", details: { reason: "row_gone" } });
  });

  it("lists a store with the number of its tables and the estimate of their rows once it is measured, and without them before", async () => {
    const world = await published("listed", [manifest(), init, notes]);
    const listed = async () => (await world.dataStores.list(accessOf(admin))).items;

    // Measured when its migrations were applied: three tables, no row yet.
    expect(await listed()).toEqual([
      {
        id: world.id,
        name: "findings",
        title: "Findings",
        description: "What the monthly check of bookings found.",
        status: "ready",
        level: 2,
        sizeBytes: expect.any(Number),
        sizeLimitBytes: 5 * 1024 ** 3,
        tableCount: 3,
        rowEstimate: 0,
        measuredAt: expect.any(String)
      }
    ]);
    // The daily measurement reads them again, from the catalog and from no row.
    await call(world, "insert", {
      table: "findings",
      rows: Array.from({ length: 300 }, (_, index) => finding(index))
    });
    await connect(world.record.location.database)`analyze`;
    const measure = required(
      world.dataStores.jobHandlers.find(({ kind }) => kind.kind === "data_store.measure_size")
    );
    await db.store.jobs.enqueue(measure.kind, {}, { clientInstanceId: world.clientInstanceId });
    await eventually(async () => {
      await world.worker.runDue();
      expect(await listed()).toMatchObject([{ tableCount: 3, rowEstimate: 300 }]);
    });

    // A store that was never measured names neither, and a caller without the right no store.
    await db.sql`update data_stores set table_count = null, row_estimate = null, size_bytes = null, size_measured_at = null where id = ${world.id}`;
    const [bare] = await listed();
    expect(bare).not.toHaveProperty("tableCount");
    expect(bare).not.toHaveProperty("rowEstimate");
    expect(bare).not.toHaveProperty("measuredAt");
    expect((await world.dataStores.list(accessOf(person("usr_nobody", ["user"])))).items).toEqual(
      []
    );
    expect(await recordOf(world, world.id)).toMatchObject({ status: "ready" });
  });

  it("neither lists nor opens a store of another Namespace to a holder of the read in one Namespace", async () => {
    const world = await setup("namespaces");
    const storeOf = (name: string): StoreFile[] => [
      { ...manifest(), text: `id: ${name}\nname: ${name}\n` },
      init
    ];
    const sales = await publish(world, storeOf("sales-ledger"), "sales-ledger");
    const hr = await publish(world, storeOf("hr-ledger"), "hr-ledger");
    await settle(world, sales, 1);
    await settle(world, hr, 1);
    const member = person("usr_page_sales", ["user"]);
    const access = accessOf(member, {
      grants: [
        {
          id: "grant_sales",
          clientInstanceId: member.clientInstanceId,
          holderKind: "user",
          holderId: member.id,
          action: "data_store.read",
          effect: "allow",
          scopeKind: "namespace",
          namespace: "sales-",
          grantedBy: asUserId(admin.id),
          createdAt: new Date().toISOString()
        }
      ]
    });

    expect((await world.dataStores.list(access)).items.map(({ name }) => name)).toEqual([
      "sales-ledger"
    ]);
    expect((await world.dataStores.list(accessOf(admin))).items.map(({ name }) => name)).toEqual([
      "hr-ledger",
      "sales-ledger"
    ]);
    // Every read of a store asks the right on that store, as the call path asks it.
    for (const part of ["rows", "value", "used_by", "state", "preview_rows"]) {
      const allowed = async (store: string) => {
        const operation = required(
          await world.dataStores.operationSource.resolve(`data_store.${store}.${part}`)
        );
        expect(operation.action, part).toBe("data_store.read");
        return access.authorize("data_store.read", operation.resource({})).allowed;
      };
      expect(await allowed("sales-ledger"), part).toBe(true);
      expect(await allowed("hr-ledger"), part).toBe(false);
    }
  });

  it("answers the published Apps and Workflows that use a store, and of those the caller may not be shown a count alone", async () => {
    const world = await published("used");
    const { clientInstanceId } = world;
    const publishAsset = (kind: string, name: string, config: JsonObject) =>
      publishAssetOf(world, kind, name, config);
    const app = (store: string): JsonObject => ({
      title: `App on ${store}`,
      manifest: {
        actions: [
          { name: "load", kind: "connection", connection: "crm", operation: "echo" },
          { name: "list", kind: "sql", dataStore: store, effect: "reading" }
        ]
      }
    });
    const workflow = (name: string, operation: string, nested = false) => {
      const step = { id: "call", name: "Call", type: "operation", operation, input: {} };
      return {
        manifest: {
          id: name,
          name: `Workflow ${name}`,
          steps: nested ? [{ id: "each", name: "Each", type: "loop", steps: [step] }] : [step]
        }
      };
    };
    const board = await publishAsset("app", "board", app("findings"));
    const report = await publishAsset("app", "report", app("findings"));
    await publishAsset("app", "other", app("ledger"));
    const monthly = await publishAsset(
      "workflow",
      "monthly",
      workflow("monthly", "data_store.findings.insert", true)
    );
    const yearly = await publishAsset(
      "workflow",
      "yearly",
      workflow("yearly", "data_store.findings.query")
    );
    // A store whose name begins the same, a Connection, and a draft that was never published.
    await publishAsset("workflow", "near", workflow("near", "data_store.findings2.query"));
    await publishAsset("workflow", "crm", workflow("crm", "connection.crm.echo"));
    await db.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "app:draft": null },
      mutations: [
        { type: "upsert", kind: "app", name: "draft", config: app("findings"), draft: true }
      ]
    });

    const nobody = { holders: [], hiddenHolders: 0 };
    const reading = { reads: true, writes: false, sources: [] };
    expect(await read(world, "used_by", {})).toEqual({
      apps: [
        { id: board, name: "board", title: "App on findings", ...reading, audience: nobody },
        { id: report, name: "report", title: "App on findings", ...reading, audience: nobody }
      ],
      workflows: [
        {
          id: monthly,
          name: "monthly",
          title: "Workflow monthly",
          reads: false,
          writes: true,
          sources: []
        },
        { id: yearly, name: "yearly", title: "Workflow yearly", ...reading }
      ],
      knowledgeBases: [],
      readers: nobody,
      hidden: { apps: 0, workflows: 0, knowledgeBases: 0, fills: 0, reads: 0 },
      truncated: false
    });

    // A member who is shown one App and the Workflow that reads: the others are counted and not
    // named, each where it stands, so the Workflow that fills the store counts as one that fills.
    const member = person("usr_page_member", ["user"]);
    const grant = (action: string, scopeId: string): PermissionGrant => ({
      id: `grant_${action}_${scopeId}`,
      clientInstanceId: member.clientInstanceId,
      holderKind: "user",
      holderId: member.id,
      action,
      effect: "allow",
      scopeKind: "asset",
      scopeId,
      grantedBy: asUserId(admin.id),
      createdAt: new Date().toISOString()
    });
    const answer = await read(
      world,
      "used_by",
      {},
      accessOf(member, { grants: [grant("app.read", board), grant("workflow.use", yearly)] })
    );
    expect(answer).toEqual({
      apps: [{ id: board, name: "board", title: "App on findings", ...reading, audience: nobody }],
      workflows: [{ id: yearly, name: "yearly", title: "Workflow yearly", ...reading }],
      knowledgeBases: [],
      readers: nobody,
      hidden: { apps: 1, workflows: 1, knowledgeBases: 0, fills: 1, reads: 1 },
      truncated: false
    });
    expect(JSON.stringify(answer)).not.toContain("report");
    expect(JSON.stringify(answer)).not.toContain("monthly");
    // The blocks a later engine runs, and an agent step that may call the store as a tool.
    const inBlock = (name: string, block: JsonObject, tools?: string[]): JsonObject => ({
      manifest: {
        id: name,
        name: `Workflow ${name}`,
        ...(tools ? { tools } : {}),
        steps: [block]
      }
    });
    const calling = (operation: string): JsonObject => ({
      id: "call",
      name: "Call",
      type: "operation",
      operation,
      input: {}
    });
    const other = calling("connection.crm.echo");
    const blocks: [string, JsonObject, string[]?][] = [
      [
        "in-then",
        {
          id: "if",
          name: "If",
          type: "condition",
          when: {},
          then: [calling("data_store.findings.query")],
          else: [other]
        }
      ],
      [
        "in-else",
        {
          id: "if",
          name: "If",
          type: "condition",
          when: {},
          then: [other],
          else: [
            {
              id: "each",
              name: "Each",
              type: "loop",
              steps: [calling("data_store.findings.insert")]
            }
          ]
        }
      ],
      [
        "in-branch",
        {
          id: "both",
          name: "Both",
          type: "parallel",
          branches: [
            { id: "a", name: "A", steps: [other] },
            { id: "b", name: "B", steps: [calling("data_store.findings.load")] }
          ]
        }
      ],
      ["as-tool", other, ["connection.crm.echo", "data_store.findings.query"]],
      ["not-in-blocks", { id: "if", name: "If", type: "condition", when: {}, then: [other] }]
    ];
    for (const [name, block, tools] of blocks) {
      await publishAsset("workflow", name, inBlock(name, block, tools));
    }
    const everyBlock = z
      .object({ workflows: z.array(z.object({ name: z.string() })) })
      .parse(await read(world, "used_by", {}));
    expect(everyBlock.workflows.map(({ name }) => name)).toEqual([
      "as-tool",
      "in-branch",
      "in-else",
      "in-then",
      "monthly",
      "yearly"
    ]);

    expect(
      await world.dataStores.operationSource.resolve("data_store.findings.used_by")
    ).toMatchObject({ effect: "reading", action: "data_store.read", scope: "config_assets:read" });
  });

  it("names where a store's rows come from and who reads them: check 68, the screens half", async () => {
    const world = await published("sources");
    const { clientInstanceId } = world;
    const stores = db.store;
    const storeId = required(
      await stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "data_store",
        name: "findings"
      })
    ).id;
    // Kai Spezis: a workspace of three, whose App on the store its members open.
    const people = await Promise.all(
      ["Kai", "Lena", "Tobias"].map((displayLabel) =>
        stores.users.createUser({ clientInstanceId, displayLabel, roles: ["user"] })
      )
    );
    const [kai, ...others] = people.map(({ id }) => id);
    const workspace = await stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Kai Spezis",
      creatorUserId: required(kai)
    });
    for (const userId of others) {
      await stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspace.id,
        userId,
        role: "member"
      });
    }
    await stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      name: "nachtimport-konto",
      displayLabel: "Nachtimport account"
    });
    const reader = await stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      name: "auswertung",
      displayLabel: "Reporting account"
    });
    const barred = await stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      name: "gesperrt",
      displayLabel: "Barred account"
    });
    const grant = (
      holder: Pick<PermissionGrant, "holderKind" | "holderId">,
      action: string,
      scope: Pick<PermissionGrant, "scopeKind" | "scopeId">,
      effect: PermissionGrant["effect"] = "allow"
    ) =>
      stores.access.createGrant({
        clientInstanceId,
        ...holder,
        action,
        effect,
        ...scope,
        grantedBy: asUserId(admin.id)
      });
    const onStore = { scopeKind: "asset", scopeId: storeId } as const;
    await grant(
      { holderKind: "service_principal", holderId: reader.id },
      "data_store.read",
      onStore
    );
    // A holder whose allow on the instance a deny on the store overrides reads nothing of it.
    await grant({ holderKind: "service_principal", holderId: barred.id }, "data_store.read", {
      scopeKind: "instance"
    });
    await grant(
      { holderKind: "service_principal", holderId: barred.id },
      "data_store.read",
      onStore,
      "deny"
    );

    // A Connection has no draft and is never published: its current revision is what it is.
    await db.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: world.clientInstanceId,
      baseRevisions: { "connection:exampledata": null },
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "exampledata",
          config: { displayName: "Exampledata" }
        }
      ]
    });
    const nachtimport = await publishAssetOf(world, "workflow", "nachtimport", {
      manifest: {
        id: "nachtimport",
        name: "Nachtimport",
        runAs: "nachtimport-konto",
        steps: [
          {
            id: "read",
            name: "Read",
            type: "operation",
            operation: "connection.exampledata.clients"
          },
          { id: "store", name: "Store", type: "operation", operation: "data_store.findings.insert" }
        ]
      }
    });
    const app = await publishAssetOf(
      world,
      "app",
      "kunden",
      {
        title: "Kunden",
        manifest: {
          actions: [
            { name: "open", kind: "connection", connection: "crm", operation: "echo" },
            { name: "list", kind: "sql", dataStore: "findings", effect: "reading" }
          ]
        }
      },
      { kind: "workspace", workspaceId: workspace.id }
    );
    // A second workspace, of one, with an App of its own on the store.
    const lenaTeam = await stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Lena Team",
      creatorUserId: required(others[0])
    });
    const termine = await publishAssetOf(
      world,
      "app",
      "termine",
      {
        title: "Termine",
        manifest: {
          actions: [{ name: "list", kind: "sql", dataStore: "findings", effect: "reading" }]
        }
      },
      { kind: "workspace", workspaceId: lenaTeam.id }
    );
    // The workspace owns the Knowledge Base too, and its members do not ask it by being members:
    // only the one who holds its use does.
    const knowledgeBase = await publishAssetOf(
      world,
      "knowledge_base",
      "kunden-wissen",
      { title: "Kunden knowledge", backend: { dataStore: "findings" } },
      { kind: "workspace", workspaceId: workspace.id }
    );
    await grant({ holderKind: "user", holderId: required(kai) }, "knowledge_base.use", {
      scopeKind: "asset",
      scopeId: knowledgeBase
    });

    const kunden = {
      id: app,
      name: "kunden",
      title: "Kunden",
      reads: true,
      writes: false,
      // The App calls a Connection and adds no row: that Connection is no source of the store.
      sources: []
    };
    const filler = {
      id: nachtimport,
      name: "nachtimport",
      title: "Nachtimport",
      reads: false,
      writes: true,
      account: { name: "nachtimport-konto", title: "Nachtimport account" }
    };
    const counted = vi.spyOn(stores.workspaces, "countMembersOfWorkspaces");
    const listed = vi.spyOn(stores.workspaces, "listMemberships");
    expect(await read(world, "used_by", {})).toEqual({
      apps: [
        {
          ...kunden,
          audience: {
            workspace: { title: "Kai Spezis", members: 3 },
            holders: [],
            hiddenHolders: 0
          }
        },
        {
          id: termine,
          name: "termine",
          title: "Termine",
          reads: true,
          writes: false,
          sources: [],
          audience: { workspace: { title: "Lena Team", members: 1 }, holders: [], hiddenHolders: 0 }
        }
      ],
      workflows: [{ ...filler, sources: [{ connection: "exampledata", title: "Exampledata" }] }],
      knowledgeBases: [
        {
          id: knowledgeBase,
          name: "kunden-wissen",
          title: "Kunden knowledge",
          audience: {
            holders: [{ kind: "user", name: kai, title: "Kai" }],
            hiddenHolders: 0
          }
        }
      ],
      readers: {
        holders: [{ kind: "service_principal", name: reader.id, title: "Reporting account" }],
        hiddenHolders: 0
      },
      hidden: { apps: 0, workflows: 0, knowledgeBases: 0, fills: 0, reads: 0 },
      truncated: false
    });
    // The two workspaces are read at once, not one read of members for each App.
    expect(counted).toHaveBeenCalledTimes(1);
    expect(listed).not.toHaveBeenCalled();
    counted.mockRestore();
    listed.mockRestore();

    // A member who reads the App and the Workflow and administers nobody: the Connection by its
    // id, the holders as a number, and of the Knowledge Base nothing but that it exists.
    const member = person("usr_sources_member", ["user"]);
    const shown = (action: string, scopeId: string): PermissionGrant => ({
      id: `grant_${action}_${scopeId}`,
      clientInstanceId: member.clientInstanceId,
      holderKind: "user",
      holderId: member.id,
      action,
      effect: "allow",
      scopeKind: "asset",
      scopeId,
      grantedBy: asUserId(admin.id),
      createdAt: new Date().toISOString()
    });
    const answer = await read(
      world,
      "used_by",
      {},
      accessOf(member, { grants: [shown("app.read", app), shown("workflow.read", nachtimport)] })
    );
    expect(answer).toEqual({
      apps: [
        {
          ...kunden,
          audience: {
            workspace: { title: "Kai Spezis", members: 3 },
            holders: [],
            hiddenHolders: 0
          }
        }
      ],
      // As whom the Workflow runs is named only to who administers users: a member learns it
      // runs as an account and not which.
      workflows: [
        { ...filler, account: {}, sources: [{ connection: "exampledata", title: "exampledata" }] }
      ],
      knowledgeBases: [],
      readers: { holders: [], hiddenHolders: 1 },
      hidden: { apps: 1, workflows: 0, knowledgeBases: 1, fills: 0, reads: 2 },
      truncated: false
    });
    expect(JSON.stringify(answer)).not.toContain("Reporting");
    expect(JSON.stringify(answer)).not.toContain("kunden-wissen");
    expect(JSON.stringify(answer)).not.toContain("Nachtimport account");
    expect(JSON.stringify(answer)).not.toContain("nachtimport-konto");
    // Who only uses the App reads where its data comes from, as the App declares it: the
    // store, the Workflow and the Connection by their names, and never the account.
    const user = person("usr_sources_user", ["user"]);
    const sources = await world.dataStores.appSources(
      accessOf(user, { grants: [{ ...shown("app.use", app), holderId: user.id }] }),
      "kunden"
    );
    expect(sources).toEqual({
      stores: [
        {
          name: "findings",
          title: "Findings",
          fillers: [
            {
              kind: "workflow",
              name: "nachtimport",
              title: "Nachtimport",
              connections: ["Exampledata"]
            }
          ]
        }
      ],
      truncated: false
    });
    expect(JSON.stringify(sources)).not.toMatch(/konto|account/iu);
    // Who may neither use nor read the App learns nothing of it.
    await expect(
      world.dataStores.appSources(accessOf(person("usr_sources_none", ["user"])), "kunden")
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The suite removes the workspace after the test, and an asset it owns cannot outlive it.
    await db.sql`delete from config_assets where scope_id in (${workspace.id}, ${lenaTeam.id})`;
  });
});
