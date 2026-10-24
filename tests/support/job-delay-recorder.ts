import type { ClientInstanceId } from "@work-shape/catalyst-core";
import { onTestFinished } from "vitest";
import { withTestSql } from "./test-sql";

/**
 * Records the stored delay against the same transaction timestamp that schedules it.
 * Subtracting started_at instead spans two wall-clock readings and includes attempt time.
 * The trigger observes writes without changing the executor or its claim predicate.
 * This DDL exists only in the test file's disposable database and is removed after the test.
 */
export async function recordJobDelays(clientInstanceId: ClientInstanceId, kind: string) {
  await withTestSql(async (sql) => {
    await sql.begin(async (tx) => {
      await tx`create table test_job_delays (
        sequence bigint generated always as identity,
        client_instance_id text not null,
        kind text not null,
        milliseconds double precision not null
      )`;
      await tx`create function test_record_job_delay() returns trigger language plpgsql as $$
        begin
          if old.status = 'running' and new.status = 'queued' and new.run_after > now() then
            insert into test_job_delays (client_instance_id, kind, milliseconds)
            values (new.client_instance_id, new.kind,
              extract(epoch from (new.run_after - now())) * 1000);
          end if;
          return new;
        end
      $$`;
      await tx`create trigger test_record_job_delay after update of status on platform_jobs
        for each row execute function test_record_job_delay()`;
    });
  });
  onTestFinished(async () => {
    await withTestSql(async (sql) => {
      await sql`drop trigger test_record_job_delay on platform_jobs`;
      await sql`drop function test_record_job_delay()`;
      await sql`drop table test_job_delays`;
    });
  });
  return async () =>
    withTestSql(async (sql) => {
      const rows = await sql<{ milliseconds: number }[]>`
        with taken as (
          delete from test_job_delays
          where client_instance_id = ${clientInstanceId} and kind = ${kind}
          returning sequence, milliseconds
        ) select milliseconds from taken order by sequence`;
      return rows.map((row) => row.milliseconds);
    });
}
