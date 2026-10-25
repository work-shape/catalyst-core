import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERASED_PERSON_COPIES, KEPT_LABEL_COLUMNS } from "@work-shape/catalyst-postgres-store";
import { usePostgresSuite } from "./support/postgres-suite";

const schemaDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/postgres-store/src/schema"
);

/**
 * The jsonb columns whose declared type holds an actor or a decision, read from the schema's
 * source: `<column>: jsonb("<name>").$type<...Actor...>()`.
 */
function actorTypedColumns(source: string): Set<string> {
  const columns = new Set<string>();
  for (const match of source.matchAll(/jsonb\("(\w+)"\)\s*\.\$type<([\s\S]*?)>\(\)/gu)) {
    const [, name, type] = match;
    if (name && type && /Actor|requestedBy|decision/iu.test(type)) columns.add(name);
  }
  return columns;
}

function schemaActorTypedColumns(): Set<string> {
  const columns = new Set<string>();
  for (const file of readdirSync(schemaDirectory)) {
    for (const name of actorTypedColumns(readFileSync(join(schemaDirectory, file), "utf8")))
      columns.add(name);
  }
  return columns;
}

describe("the account deletion's list of stored person copies (ERASE-ACTOR-IDS)", () => {
  const db = usePostgresSuite("erasureschema");

  async function columns() {
    return db.sql<Array<{ table: string; column: string; type: string }>>`
      select table_name as table, column_name as column, data_type as type
      from information_schema.columns c
      where table_schema = 'public'
        and exists (select 1 from information_schema.tables t
          where t.table_schema = 'public' and t.table_name = c.table_name
            and t.table_type = 'BASE TABLE')`;
  }

  /**
   * Every column of the migrated database that copies a person's label or actor and is neither
   * emptied by the account deletion nor kept for a stated reason: a column ending in `_label`, a
   * jsonb column named `actor` or ending in `_by`, or a jsonb column whose declared type holds an
   * actor or a decision.
   */
  async function unlistedPersonColumns(actorTyped: ReadonlySet<string>) {
    const listed = new Set<string>([...ERASED_PERSON_COPIES, ...Object.keys(KEPT_LABEL_COLUMNS)]);
    return (await columns())
      .filter(({ column, type }) => {
        const json = type === "jsonb";
        return (
          column.endsWith("_label") ||
          (json && (column === "actor" || column.endsWith("_by") || actorTyped.has(column)))
        );
      })
      .map(({ table, column }) => `${table}.${column}`)
      .filter((key) => !listed.has(key))
      .sort();
  }

  it("names every column that copies a person's label or actor, and only columns there are", async () => {
    expect(await unlistedPersonColumns(schemaActorTypedColumns())).toEqual([]);
    const existing = new Set((await columns()).map(({ table, column }) => `${table}.${column}`));
    const listed = [...ERASED_PERSON_COPIES, ...Object.keys(KEPT_LABEL_COLUMNS)];
    expect(listed.filter((key) => !existing.has(key))).toEqual([]);
  });

  // The guard itself: a new label column, or an actor in a new column, fails until it is listed.
  it("fails on a new column that copies a person and is not listed", async () => {
    await db.sql`
      create table reviews (id text primary key, reviewed_by_label text, approved_by jsonb,
        reviewer jsonb, notes jsonb)`;
    try {
      const actorTyped = actorTypedColumns(
        `reviewer: jsonb("reviewer").$type<AuditActor>(),\n  notes: jsonb("notes").$type<string[]>()`
      );
      expect([...actorTyped]).toEqual(["reviewer"]);
      expect(await unlistedPersonColumns(actorTyped)).toEqual([
        "reviews.approved_by",
        "reviews.reviewed_by_label",
        "reviews.reviewer"
      ]);
    } finally {
      await db.sql`drop table reviews`;
    }
  });
});
