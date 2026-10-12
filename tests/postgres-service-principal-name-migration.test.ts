import { PostgresFixtures } from "./support/postgres-fixtures";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { z } from "zod";
import { SERVICE_PRINCIPAL_NAME_PATTERN } from "@vivd-catalyst/core";

const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));
const migrationsDirectory = resolve("packages/postgres-store/migrations");
const createdDatabases: string[] = [];
const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number(), tag: z.string() }))
});

// Fails without migrations 0057 and 0058: the table has no column `name` and no index on it.
describe("Service principal name migrations 0057 and 0058", () => {
  afterEach(async () => {
    while (createdDatabases.length > 0) {
      const url = createdDatabases.pop();
      if (url) await fixtures.drop(url);
    }
  });

  it("names every existing principal after its label, once per instance", async () => {
    const sql = await freshDatabase();
    try {
      await applyMigrationsThrough(sql, 56);
      await seedPrincipal(sql, "spn_a", "one", "Booking check", "2026-01-01");
      await seedPrincipal(sql, "spn_b", "one", "booking  CHECK!", "2026-01-02");
      await seedPrincipal(sql, "spn_c", "two", "Booking check", "2026-01-03");
      await seedPrincipal(sql, "spn_d", "one", "§§§", "2026-01-04");
      await seedPrincipal(sql, "spn_e", "one", `--${"x".repeat(80)}`, "2026-01-05");

      await applyMigration(sql, "0057_service_principal_name");
      await applyMigration(sql, "0058_service_principal_name_index");

      const rows = await sql<{ id: string; name: string }[]>`
        select id, name from service_principals order by id
      `;
      const names = new Map(rows.map((row) => [row.id, row.name]));
      // The oldest of two with one slug keeps it, the other gets a suffix from its id.
      expect(names.get("spn_a")).toBe("booking-check");
      expect(names.get("spn_b")).toMatch(/^booking-check-[0-9a-f]{6}$/u);
      // Another instance has its own names.
      expect(names.get("spn_c")).toBe("booking-check");
      expect(names.get("spn_d")).toBe("principal");
      expect(names.get("spn_e")).toBe("x".repeat(48));
      for (const row of rows) {
        expect(row.name, row.id).toMatch(SERVICE_PRINCIPAL_NAME_PATTERN);
      }
    } finally {
      await sql.end();
    }
  });

  it("lets a release that does not know the column create a principal, and keeps names unique", async () => {
    const sql = await freshDatabase();
    try {
      await applyMigrationsThrough(sql, 58);
      // The insert of the previous release names no `name`.
      await seedPrincipal(sql, "spn_old_1", "one", "Same label", "2026-01-01");
      await seedPrincipal(sql, "spn_old_2", "one", "Same label", "2026-01-02");

      const rows = await sql<{ name: string }[]>`select name from service_principals`;
      expect(new Set(rows.map((row) => row.name)).size).toBe(2);
      for (const row of rows) {
        expect(row.name).toMatch(/^principal-[0-9a-f]{12}$/u);
        expect(row.name).toMatch(SERVICE_PRINCIPAL_NAME_PATTERN);
      }
      await expect(
        sql`update service_principals set name = 'taken' where client_instance_id = 'one'`
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        sql`update service_principals set name = null where id = 'spn_old_1'`
      ).rejects.toMatchObject({ code: "23502" });
    } finally {
      await sql.end();
    }
  });
});

async function freshDatabase(): Promise<Sql> {
  // The migration itself is under test, so it needs a database without it.
  const url = await fixtures.database(`history_${globalThis.crypto.randomUUID()}`, false);
  createdDatabases.push(url);
  return postgres(url, { max: 1 });
}

async function applyMigrationsThrough(sql: Sql, finalIndex: number): Promise<void> {
  const journal = journalSchema.parse(
    JSON.parse(await readFile(resolve(migrationsDirectory, "meta/_journal.json"), "utf8"))
  );
  for (const entry of journal.entries.filter((candidate) => candidate.idx <= finalIndex)) {
    await applyMigration(sql, entry.tag);
  }
}

async function applyMigration(sql: Sql, tag: string): Promise<void> {
  const source = await readFile(resolve(migrationsDirectory, `${tag}.sql`), "utf8");
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  // Statement by statement: an earlier migration builds an index outside a transaction.
  for (const statement of statements) {
    await sql.unsafe(statement);
  }
}

async function seedPrincipal(
  sql: Sql,
  id: string,
  clientInstanceId: string,
  displayLabel: string,
  createdAt: string
): Promise<void> {
  await sql`
    insert into service_principals (
      id, client_instance_id, display_label, status, permission_refs, permissions,
      created_at, updated_at
    ) values (
      ${id}, ${clientInstanceId}, ${displayLabel}, 'active', '[]'::jsonb, '[]'::jsonb,
      ${createdAt}::timestamptz, now()
    )
  `;
}
