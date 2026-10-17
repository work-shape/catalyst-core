import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { afterEach, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import { PostgresFixtures } from "./support/postgres-fixtures";

const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));
const migrationsDirectory = resolve("packages/postgres-store/migrations");
const createdDatabases: string[] = [];
const journalSchema = z.object({
  entries: z.array(z.object({ idx: z.number(), tag: z.string() }))
});

// Found by their names, so their numbers may change when another migration lands first.
const KEY_MIGRATION = "workflow_run_keys";
const INDEX_MIGRATION = "workflow_run_key_indexes";

describe("Workflow run key migrations (EW-13k)", () => {
  afterEach(async () => {
    while (createdDatabases.length > 0) {
      const url = createdDatabases.pop();
      if (url) await fixtures.drop(url);
    }
  });

  it("keeps the runs and step runs that are there, and holds a key once per Workflow and mode among open and done runs", async () => {
    const url = await fixtures.database(`run_keys_${globalThis.crypto.randomUUID()}`, false);
    createdDatabases.push(url);
    const sql = postgres(url, { max: 1, onnotice() {} });
    try {
      await applyMigrationsBefore(sql, KEY_MIGRATION);
      await seedRun(sql, "wfr_done", "done");
      await seedRun(sql, "wfr_failed", "failed");
      await seedRun(sql, "wfr_open", "running");
      await sql`
        insert into workflow_step_runs (id, client_instance_id, run_id, step_id, step_type, key, status, created_at)
        values ('wsr_1', 'instance', 'wfr_done', 'child', 'workflow', 'child', 'done', now())`;

      await applyMigration(sql, (await entryNamed(KEY_MIGRATION)).tag);
      await applyMigration(sql, (await entryNamed(INDEX_MIGRATION)).tag);

      const runs = await sql<{ id: string; status: string; run_key: string | null }[]>`
        select id, status, run_key from workflow_runs order by id`;
      expect(runs).toEqual([
        { id: "wfr_done", status: "done", run_key: null },
        { id: "wfr_failed", status: "failed", run_key: null },
        { id: "wfr_open", status: "running", run_key: null }
      ]);
      const [step] = await sql<{ linked_run_id: string | null }[]>`
        select linked_run_id from workflow_step_runs where id = 'wsr_1'`;
      expect(step).toEqual({ linked_run_id: null });
      const indexes = await sql<{ name: string; valid: boolean }[]>`
        select c.relname as name, i.indisvalid as valid
        from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname in ('workflow_runs_run_key_idx', 'workflow_step_runs_linked_run_idx')
        order by c.relname`;
      expect(indexes).toEqual([
        { name: "workflow_runs_run_key_idx", valid: true },
        { name: "workflow_step_runs_linked_run_idx", valid: true }
      ]);

      // A failed run gives its key up; a done or open run holds it.
      await sql`update workflow_runs set run_key = '2026-09/1' where id in ('wfr_done', 'wfr_failed')`;
      await expect(
        sql`update workflow_runs set run_key = '2026-09/1' where id = 'wfr_open'`
      ).rejects.toMatchObject({ code: "23505" });
      // Another mode, or a key that differs, is another key.
      await seedRun(sql, "wfr_test", "running", "test");
      await sql`update workflow_runs set run_key = '2026-09/1' where id = 'wfr_test'`;
      await sql`update workflow_runs set run_key = '2026-09/2' where id = 'wfr_open'`;
      // A run that ends failed leaves the index, and a new run then takes the key.
      await sql`update workflow_runs set status = 'failed' where id = 'wfr_done'`;
      await sql`update workflow_runs set run_key = '2026-09/1' where id = 'wfr_open'`;
    } finally {
      await sql.end();
    }
  });
});

async function journalEntries() {
  return journalSchema.parse(
    JSON.parse(await readFile(resolve(migrationsDirectory, "meta/_journal.json"), "utf8"))
  ).entries;
}

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

async function applyMigration(sql: Sql, tag: string): Promise<void> {
  const source = await readFile(resolve(migrationsDirectory, `${tag}.sql`), "utf8");
  // Statement by statement: a concurrent index build runs outside a transaction.
  for (const statement of source
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await sql.unsafe(statement);
  }
}

async function seedRun(sql: Sql, id: string, status: string, mode = "live"): Promise<void> {
  await sql`
    insert into workflow_runs (
      id, client_instance_id, workflow, definition_revision_id, mode, trigger, status,
      definition, input, principal_id, principal_name, principal_label, started_by,
      root_run_id, deadline_at, correlation_id, created_at
    ) values (
      ${id}, 'instance', 'monthly', 'rev_1', ${mode}, 'manual', ${status},
      '{}'::jsonb, '{}'::jsonb, 'spn_1', 'runner', 'Runner',
      '{"kind":"user","id":"usr_1","label":"Ada"}'::jsonb,
      ${id}, now() + interval '1 hour', 'corr', now()
    )`;
}
