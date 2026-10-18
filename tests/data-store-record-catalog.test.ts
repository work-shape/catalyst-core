import { describe, expect, it } from "vitest";
import { init, manifest, refusal, sqlState, useDataStoreWorld } from "./support/data-store-world";

const rules = (table: string, column: string) =>
  manifest(`records:\n  - table: ${table}\n    key: { column: ${column}, fromField: ${column} }\n`);

describe("REC-0 records publish and platform-owned SQL", () => {
  const { setup, publish, published, recordOf, connect, takeOver, settle } =
    useDataStoreWorld("record_catalog");

  it("refuses missing tables and non-unique keys without moving the published pointer", async () => {
    const world = await published("keys");
    const before = await recordOf(world, world.id);
    for (const [table, column] of [
      ["absent", "id"],
      ["findings", "missing"],
      ["findings", "run_id"]
    ] as const) {
      const error = await refusal(publish(world, [rules(table, column), init]));
      expect(error).toMatchObject({
        code: "VALIDATION_FAILED",
        message: expect.stringContaining(`records.${table}.key.${column}`),
        details: { reason: "record_key_invalid" }
      });
      expect((await recordOf(world, world.id)).targetRevision).toBe(before.targetRevision);
    }
    const duplicateRules = rules("findings", "id");
    duplicateRules.text += "  - table: findings\n    key: { column: id, fromField: id }\n";
    expect(await refusal(publish(world, [duplicateRules, init]))).toMatchObject({
      code: "VALIDATION_FAILED"
    });
    await publish(world, [rules("findings", "id"), init]);
    expect((await recordOf(world, world.id)).targetRevision).toBeGreaterThan(before.targetRevision);
    // The definition's strict records schema survives the files -> stored revision round trip.
    expect(
      world.dataStores.readFiles([
        { path: "store.yaml", bytes: new TextEncoder().encode(rules("findings", "id").text) }
      ])
    ).toMatchObject({ records: [{ table: "findings", retainWithoutSource: false }] });
  });

  it("checks actual index keys, excluding partial, composite, expression and deferrable indexes", async () => {
    const world = await published("indexes");
    const indexes = {
      path: "migrations/0002_keys.sql",
      text: `
      create table composite (id text, extra text, unique(id, extra));
      create table partial_key (id text); create unique index partial_id on partial_key(id) where id is not null;
      create table expression_key (id text); create unique index expression_id on expression_key(lower(id));
      create table deferred_key (id text unique deferrable);
      create materialized view indexed_view as select 'one'::text as id;
      create unique index view_id on indexed_view(id);
      create table included_key (id text, extra text); create unique index included_id on included_key(id) include(extra);
    `
    };
    await publish(world, [manifest(), init, indexes]);
    await settle(world, world.id, 2);
    for (const table of [
      "composite",
      "partial_key",
      "expression_key",
      "deferred_key",
      "indexed_view"
    ]) {
      expect(await refusal(publish(world, [rules(table, "id"), init, indexes]))).toMatchObject({
        details: { reason: "record_key_invalid" }
      });
    }
    expect(
      await refusal(publish(world, [rules("included_key", "extra"), init, indexes]))
    ).toMatchObject({ details: { reason: "record_key_invalid" } });
    await publish(world, [rules("included_key", "id"), init, indexes]);
  });

  it("allows a one-step publish of schema and rules and validates the migrated schema", async () => {
    const world = await setup("new");
    const id = await publish(world, [rules("findings", "id"), init]);
    expect((await settle(world, id, 1)).failure).toBeUndefined();
  });

  it("keeps provenance unique per composite document and blocks store roles from its customer data", async () => {
    const world = await published("ddl");
    const sql = connect(world.record.location.database);
    const insert = (kb: string, doc: string, key: string | null) => sql`
      insert into catalyst.record_fields(table_name, record_key, field_name, knowledge_base_id, document_id, kind, value, page, quote, document_date, extracted_at, evidence, state)
      values ('findings', ${key}::jsonb, 'amount', ${kb}, ${doc}, 'contract', '12.5'::jsonb, 1, '12.5', '2026-10-17', now(), '{"status":"passed"}'::jsonb, 'extracted')`;
    await insert("kb-1", "doc-1", '"A-1"');
    // A later provisioning pass is additive and leaves existing candidates intact.
    await publish(world, [manifest(), init]);
    await settle(world, world.id, 1);
    expect(await sqlState(insert("kb-1", "doc-1", '"A-1"'))).toBe("23505");
    await insert("kb-2", "doc-1", '"A-1"');
    await insert("kb-1", "doc-2", null);
    expect(await sqlState(insert("kb-1", "doc-2", null))).toBe("23505");
    expect(await sqlState(sql`update catalyst.record_fields set state='unknown'`)).toBe("23514");
    expect(
      await sqlState(
        sql`update catalyst.record_fields set evidence='{"status":"passed","confidence":1}'::jsonb`
      )
    ).toBe("23514");
    for (const role of ["app", "migration"] as const) {
      const restricted = connect(
        world.record.location.database,
        await takeOver(world.record.roles[role])
      );
      expect(await sqlState(restricted`select * from catalyst.record_fields`)).toBe("42501");
      expect(await sqlState(restricted`delete from catalyst.record_fields`)).toBe("42501");
    }
  });
});
