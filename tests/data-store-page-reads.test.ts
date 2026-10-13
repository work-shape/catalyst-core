import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  NoopAuditRecorder,
  asClientInstanceId,
  asUserId,
  createPlatformId,
  type AuthenticatedUser,
  type JsonObject,
  type PermissionGrant
} from "@vivd-catalyst/core";
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
  const { db, published, call, connect, recordOf } = useDataStoreWorld("data_store_page_reads");

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

  it("answers the published Apps and Workflows that use a store, and of those the caller may not be shown a count alone", async () => {
    const world = await published("used");
    const { clientInstanceId } = world;
    /** Writes an asset and publishes it, as its kind's own workflow would. */
    const publishAsset = async (kind: string, name: string, config: JsonObject) => {
      const key = `${kind}:${name}`;
      const written = await db.store.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { [key]: null },
        mutations: [{ type: "upsert", kind, name, config, draft: true }]
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
    };
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
    await publishAsset("workflow", "yearly", workflow("yearly", "data_store.findings.query"));
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

    expect(await read(world, "used_by", {})).toEqual({
      apps: [
        { id: board, name: "board", title: "App on findings" },
        { id: report, name: "report", title: "App on findings" }
      ],
      workflows: [
        { id: monthly, name: "monthly", title: "Workflow monthly" },
        { id: expect.any(String), name: "yearly", title: "Workflow yearly" }
      ],
      hidden: { apps: 0, workflows: 0 },
      truncated: false
    });

    // A member who is shown one App and one Workflow: the others are counted and not named.
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
      accessOf(member, { grants: [grant("app.read", board), grant("workflow.use", monthly)] })
    );
    expect(answer).toEqual({
      apps: [{ id: board, name: "board", title: "App on findings" }],
      workflows: [{ id: monthly, name: "monthly", title: "Workflow monthly" }],
      hidden: { apps: 1, workflows: 1 },
      truncated: false
    });
    expect(JSON.stringify(answer)).not.toContain("report");
    expect(JSON.stringify(answer)).not.toContain("yearly");
    expect(
      await world.dataStores.operationSource.resolve("data_store.findings.used_by")
    ).toMatchObject({ effect: "reading", action: "data_store.read", scope: "config_assets:read" });
  });
});
