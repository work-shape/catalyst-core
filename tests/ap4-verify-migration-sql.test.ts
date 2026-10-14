import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterEach, describe, expect, inject, it } from "vitest";
import { migrateDatabase } from "@vivd-catalyst/postgres-store";
import { migrationsUntil } from "./support/migrations-until";
import { PostgresFixtures } from "./support/postgres-fixtures";

// AP-4 verifier: migration 0072 on its own, on odd inputs and run a second time by hand.

const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});
const instance = "ap4-sql";
const migrationSql = readFileSync(
  "packages/postgres-store/migrations/0072_legacy_permission_grants.sql",
  "utf8"
);

async function databaseBeforeAp4() {
  const databaseUrl = await fixtures.database(`ap4-sql:${crypto.randomUUID()}`, false);
  const before = migrationsUntil({ name: "legacy_permission_grants", including: false });
  const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
  cleanups.push(() => fixtures.drop(databaseUrl));
  cleanups.push(() => sql.end());
  cleanups.push(() => before.remove());
  await migrateDatabase({ databaseUrl, migrationsDirectory: before.directory });
  return { databaseUrl, sql };
}

describe("AP-4 verifier: migration 0072 SQL", () => {
  it("runs on an empty instance and writes nothing", async () => {
    const { databaseUrl, sql } = await databaseBeforeAp4();
    await migrateDatabase({ databaseUrl });
    const [row] = await sql<{ count: string }[]>`select count(*) from permission_grants`;
    expect(row?.count).toBe("0");
  });

  it("gives no right for a list entry that is not a string key", async () => {
    const { databaseUrl, sql } = await databaseBeforeAp4();
    const lists: Record<string, string> = {
      usr_nested: '[["users.manage"]]',
      usr_object: '{"users.manage": true}',
      usr_string: '"users.manage"',
      usr_object_in_list: '[{"users.manage": true}]'
    };
    for (const [id, permissions] of Object.entries(lists)) {
      await sql`
        insert into product_users (id, client_instance_id, display_label, roles, permission_refs,
          permissions, status, created_at, updated_at)
        values (${id}, ${instance}, ${id}, '["user"]'::jsonb, '[]'::jsonb,
          ${permissions}::text::jsonb, 'active', now(), now())`;
    }
    await migrateDatabase({ databaseUrl });
    const rows = await sql<{ holder_id: string; action: string }[]>`
      select holder_id, action from permission_grants order by holder_id`;
    expect(rows).toEqual([]);
  });

  it("run a second time by hand, it keeps a key without a list at every scope", async () => {
    const { databaseUrl, sql } = await databaseBeforeAp4();
    await sql`
      insert into service_principals (id, client_instance_id, name, display_label, status,
        permission_refs, permissions, created_at, updated_at)
      values ('sp_a', ${instance}, 'sp_a', 'sp_a', 'active', '[]'::jsonb,
        '["config_assets.read"]'::jsonb, now(), now())`;
    await sql`
      insert into api_credentials (id, client_instance_id, service_principal_id, name,
        key_prefix, secret_hash, scopes, created_at)
      values ('cred_a', ${instance}, 'sp_a', 'cred_a', 'p', 'h', null, now())`;
    await migrateDatabase({ databaseUrl });
    const grantsAfterFirst = await sql`select action, effect from permission_grants order by action`;
    await sql.unsafe(migrationSql.replaceAll("--> statement-breakpoint", ""));
    const grantsAfterSecond = await sql`select action, effect from permission_grants order by action`;
    expect(grantsAfterSecond).toEqual(grantsAfterFirst);
    const [credential] = await sql<{ scopes: unknown }[]>`select scopes from api_credentials`;
    expect(credential?.scopes).toEqual(["*"]);
  });
});
