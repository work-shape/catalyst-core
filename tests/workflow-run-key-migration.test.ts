import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres, { type Sql } from "postgres";
import { afterEach, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import { migrateDatabase } from "@work-shape/catalyst-postgres-store";
import { migrationsUntil } from "./support/migrations-until";
import { waitUntil, required } from "./support/assertions";
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

  it("keeps both uniqueness guarantees on 300,000 runs through a cancelled build and its rerun", async () => {
    const url = await fixtures.database(`continuation_keys_${crypto.randomUUID()}`, false);
    createdDatabases.push(url);
    const before = migrationsUntil({ name: "workflow_continue_as_new", including: false });
    const expanded = migrationsUntil({ name: "workflow_continuation_validate", including: true });
    // This proof owns the continuation indexes, not migrations added by later features.
    const indexed = migrationsUntil({ name: "workflow_continuation_indexes", including: true });
    const sql = postgres(url, { max: 1, onnotice() {} });
    const writerSql = postgres(url, { max: 1, onnotice() {} });
    const blocker = postgres(url, { max: 1, onnotice() {} });
    let stop = false;
    let writer: Promise<void> | undefined;
    let migration: Promise<unknown> | undefined;
    let writerError: unknown;
    let acceptedDuplicates = 0;
    let rejectedKeys = 0;
    let rejectedParents = 0;
    let writes = 0;
    async function mustReject(write: () => Promise<unknown>): Promise<boolean> {
      try {
        await write();
        acceptedDuplicates++;
        return false;
      } catch (error) {
        if (!(error instanceof postgres.PostgresError) || error.code !== "23505") throw error;
        return true;
      }
    }
    async function probeUniqueness() {
      // These are starts (INSERTs), not updates of a run admitted before the deploy.
      if (
        await mustReject(() =>
          startRun(writerSql, `key_attempt_${rejectedKeys}`, "running", "live", { key: "held-key" })
        )
      )
        rejectedKeys++;
      if (
        await mustReject(() =>
          startRun(writerSql, `parent_attempt_${rejectedParents}`, "running", "live", {
            parentStep: "parent-step"
          })
        )
      )
        rejectedParents++;
    }
    try {
      await migrateDatabase({ databaseUrl: url, migrationsDirectory: before.directory });
      await startRun(sql, "key_holder", "running", "live", { key: "held-key" });
      await startRun(sql, "parent_holder", "running", "live", { parentStep: "parent-step" });
      await sql`insert into workflow_runs (id, client_instance_id, workflow, definition_revision_id, mode,
        trigger, status, definition, input, principal_id, principal_name, principal_label, started_by,
        root_run_id, deadline_at, correlation_id, created_at, run_key)
        select 'volume_' || n, client_instance_id, workflow, definition_revision_id, mode, trigger, status,
          definition, input, principal_id, principal_name, principal_label, started_by,
          'volume_' || n, deadline_at, correlation_id, created_at, 'volume/' || n
        from workflow_runs cross join generate_series(1, 300000) n where id = 'key_holder'`;
      writer = (async () => {
        while (!stop) {
          await probeUniqueness();
          const id = `writer_${writes}`;
          await startRun(writerSql, id, "running", "live", { key: id });
          writes++;
        }
      })().catch((error) => {
        writerError = error;
        stop = true;
      });
      await waitUntil(
        () => writes > 0 || writerError !== undefined,
        "the concurrent writer starts"
      );
      await migrateDatabase({ databaseUrl: url, migrationsDirectory: expanded.directory });
      const [constraint] = await sql<{ validated: boolean }[]>`
        select convalidated as validated from pg_constraint where conname = 'workflow_runs_status_check'`;
      expect(constraint?.validated).toBe(true);

      // An old worker's open write makes the first concurrent build wait at a known phase.
      // Cancel only that build's PID in this test-owned database, after its invalid index exists.
      await blocker`begin`;
      await blocker`update workflow_runs set principal_label = 'held writer' where id = 'volume_1'`;
      migration = migrateDatabase({
        databaseUrl: url,
        migrationsDirectory: indexed.directory
      }).then(
        (applied) => ({ applied, error: undefined }),
        (error: unknown) => ({ applied: undefined, error })
      );
      let buildPid: number | undefined;
      await waitUntil(async () => {
        const [build] = await sql<{ pid: number }[]>`
          select p.pid from pg_stat_progress_create_index p
          join pg_class c on c.oid = p.index_relid
          where c.relname = 'workflow_runs_active_parent_step_idx'
            and p.phase = 'waiting for writers before build'`;
        buildPid = build?.pid;
        return buildPid !== undefined;
      }, "the replacement index build waits for the held writer");
      const [cancelled] = await sql<
        { cancelled: boolean }[]
      >`select pg_cancel_backend(${required(buildPid)}) as cancelled`;
      expect(cancelled?.cancelled).toBe(true);
      expect(await migration).toMatchObject({
        error: expect.objectContaining({
          message: expect.stringContaining("workflow_continuation_indexes failed:")
        })
      });
      const [invalid] = await sql<{ valid: boolean }[]>`
        select i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname = 'workflow_runs_active_parent_step_idx'`;
      expect(invalid?.valid).toBe(false);
      const oldGuards = await sql<{ name: string; valid: boolean }[]>`
        select c.relname as name, i.indisvalid as valid from pg_index i
        join pg_class c on c.oid = i.indexrelid
        where c.relname in ('workflow_runs_run_key_idx', 'workflow_runs_parent_step_idx')
        order by c.relname`;
      expect(oldGuards).toEqual([
        { name: "workflow_runs_parent_step_idx", valid: true },
        { name: "workflow_runs_run_key_idx", valid: true }
      ]);
      await probeUniqueness();
      const writesBeforeRecovery = writes;
      await blocker`rollback`;
      const expectedIndexMigration = await entryNamed("workflow_continuation_indexes");
      expect(
        await migrateDatabase({ databaseUrl: url, migrationsDirectory: indexed.directory })
      ).toEqual([expectedIndexMigration.tag]);
      await waitUntil(
        () => writes > writesBeforeRecovery || writerError !== undefined,
        "the writer spans recovery"
      );
      stop = true;
      await writer;
      if (writerError !== undefined) throw writerError;
      await probeUniqueness();
      expect(acceptedDuplicates).toBe(0);
      expect(rejectedKeys).toBeGreaterThan(0);
      expect(rejectedParents).toBeGreaterThan(0);
      const indexes = await sql<{ name: string; valid: boolean }[]>`
        select c.relname as name, i.indisvalid as valid from pg_index i
        join pg_class c on c.oid = i.indexrelid
        where c.relname in ('workflow_runs_active_run_key_idx', 'workflow_runs_active_parent_step_idx',
          'workflow_runs_run_key_idx', 'workflow_runs_parent_step_idx') order by c.relname`;
      expect(indexes).toEqual([
        { name: "workflow_runs_active_parent_step_idx", valid: true },
        { name: "workflow_runs_active_run_key_idx", valid: true }
      ]);
      const [duplicates] = await sql<{ count: number }[]>`
        select count(*)::int as count from workflow_runs where status = 'running' and run_key = 'held-key'`;
      expect(duplicates?.count).toBe(1);
      expect(
        await migrateDatabase({ databaseUrl: url, migrationsDirectory: indexed.directory })
      ).toEqual([]);
      console.info(
        `EW-CAN migration proof: 300,000 seeded runs; ${writes} fresh starts; ${rejectedKeys} held-key and ${rejectedParents} parent-step starts rejected; ${acceptedDuplicates} duplicates admitted; cancelled build recovered, both indexes valid.`
      );
    } finally {
      stop = true;
      await blocker`rollback`;
      await migration;
      await writer;
      await Promise.all([writerSql.end(), blocker.end(), sql.end()]);
      before.remove();
      expanded.remove();
      indexed.remove();
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

async function startRun(
  sql: Sql,
  id: string,
  status: string,
  mode = "live",
  input: { key?: string; parentStep?: string } = {}
): Promise<void> {
  await sql`
    insert into workflow_runs (
      id, client_instance_id, workflow, definition_revision_id, mode, trigger, status,
      definition, input, principal_id, principal_name, principal_label, started_by,
      root_run_id, deadline_at, correlation_id, created_at, run_key, parent_run_id, parent_step_run_id, depth
    ) values (
      ${id}, 'instance', 'monthly', 'rev_1', ${mode}, 'manual', ${status},
      '{}'::jsonb, '{}'::jsonb, 'spn_1', 'runner', 'Runner',
      '{"kind":"user","id":"usr_1","label":"Ada"}'::jsonb,
      ${id}, now() + interval '1 hour', 'corr', now(), ${input.key ?? null},
      ${input.parentStep ? "key_holder" : null}, ${input.parentStep ?? null}, ${input.parentStep ? 1 : 0}
    )`;
}
