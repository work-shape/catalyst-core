import { PostgresFixtures } from "./support/postgres-fixtures";
import { createHash } from "node:crypto";
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

// Fails without the two migrations: the table has no column `name` and no index on it. They
// are found by their names, so their numbers may change when another migration lands first.
const NAME_MIGRATION = "service_principal_name";
const INDEX_MIGRATION = "service_principal_name_index";

describe("Service principal name migrations", () => {
  afterEach(async () => {
    while (createdDatabases.length > 0) {
      const url = createdDatabases.pop();
      if (url) await fixtures.drop(url);
    }
  });

  it("names every existing principal after its label, once per instance", async () => {
    const sql = await freshDatabase();
    try {
      await applyMigrationsBefore(sql, NAME_MIGRATION);
      await seedPrincipal(sql, "spn_a", "one", "Booking check", "2026-01-01");
      await seedPrincipal(sql, "spn_b", "one", "booking  CHECK!", "2026-01-02");
      await seedPrincipal(sql, "spn_c", "two", "Booking check", "2026-01-03");
      await seedPrincipal(sql, "spn_d", "one", "§§§", "2026-01-04");
      await seedPrincipal(sql, "spn_e", "one", `--${"x".repeat(80)}`, "2026-01-05");

      await applyNameMigrations(sql);

      const rows = await sql<{ id: string; name: string }[]>`
        select id, name from service_principals order by id
      `;
      const names = new Map(rows.map((row) => [row.id, row.name]));
      // The oldest of two with one slug keeps it, the other gets a tail from its id.
      expect(names.get("spn_a")).toBe("booking-check");
      expect(names.get("spn_b")).toMatch(/^booking-check-[0-9a-f]{32}-[0-9a-f]{15}$/u);
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

  // Fails with a short suffix from the id: the second `a` was named `a-<six of its hash>`,
  // which is the slug of the third, and the unique index was refused.
  it("gives no principal the slug of another, whatever the labels are", async () => {
    const sql = await freshDatabase();
    try {
      await applyMigrationsBefore(sql, NAME_MIGRATION);
      const short = createHash("md5").update("spn_2").digest("hex").slice(0, 6);
      const tail = `${createHash("md5").update("spn_2").digest("hex")}-${createHash("md5")
        .update("name:spn_2")
        .digest("hex")
        .slice(0, 15)}`;
      await seedPrincipal(sql, "spn_1", "one", "a", "2026-01-01");
      await seedPrincipal(sql, "spn_2", "one", "a", "2026-01-02");
      await seedPrincipal(sql, "spn_3", "one", `a-${short}`, "2026-01-03");
      // The longest slug there is, 48 characters, is shorter than any name with a tail.
      await seedPrincipal(sql, "spn_4", "one", `a-${tail}`, "2026-01-04");

      await applyNameMigrations(sql);

      const rows = await sql<{ id: string; name: string }[]>`
        select id, name from service_principals order by id
      `;
      expect(rows.map((row) => row.name)).toEqual([
        "a",
        `a-${tail}`,
        `a-${short}`,
        `a-${tail}`.slice(0, 48)
      ]);
      expect(new Set(rows.map((row) => row.name)).size).toBe(4);
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
      await applyMigrationsBefore(sql, NAME_MIGRATION);
      await applyNameMigrations(sql);
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

async function journalEntries() {
  return journalSchema.parse(
    JSON.parse(await readFile(resolve(migrationsDirectory, "meta/_journal.json"), "utf8"))
  ).entries;
}

/** The journal entry of a migration by its name, without its number. */
async function entryNamed(name: string) {
  const entry = (await journalEntries()).find((candidate) =>
    /^\d+_/u.test(candidate.tag) ? candidate.tag.replace(/^\d+_/u, "") === name : false
  );
  if (!entry) throw new Error(`No migration is named ${name}`);
  return entry;
}

async function applyMigrationsBefore(sql: Sql, name: string): Promise<void> {
  const { idx } = await entryNamed(name);
  for (const entry of (await journalEntries()).filter((candidate) => candidate.idx < idx)) {
    await applyMigration(sql, entry.tag);
  }
}

async function applyNameMigrations(sql: Sql): Promise<void> {
  await applyMigration(sql, (await entryNamed(NAME_MIGRATION)).tag);
  await applyMigration(sql, (await entryNamed(INDEX_MIGRATION)).tag);
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
