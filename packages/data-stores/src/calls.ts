import { createHash } from "node:crypto";
import type { PostgresChangeStatements, PostgresTarget } from "@vivd-catalyst/postgres-connector";
import {
  AppError,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type DataStoreRecord,
  type JsonObject
} from "@vivd-catalyst/core";
import { z } from "zod";
import type { DataStoreRuntime } from "./runtime";
import { quoteIdentifier } from "./server";

// What a store keeps of the changing calls that carried an idempotency key: one row per call
// in `catalyst.calls`, written in the transaction of the call's own rows. The rows of a call
// and the record of its key are therefore kept together or not at all, whatever becomes of
// the process that made the call and of its Operation Run, which is the platform database's
// and cannot commit with them. A call under a key that is recorded changes nothing and is
// answered what the first call was answered.
//
// The table is the platform's, in the schema the store's migrations may not name. The app
// role holds nothing on it: it reads the record of one key and adds one through two functions
// of the platform's, which run with their owner's rights. A statement that runs as the app
// role, such as the one of a query or of an `sql` action of an App, therefore reads no record
// it does not hold the key of, and the read-only transaction of a query adds none.

/**
 * For how many days a store keeps the record of a call: as long as the data of a step is kept.
 * A call whose record is gone is no longer answered from the store. Its Operation Run, where
 * that is still there, answers it before the store is asked.
 */
const DATA_STORE_CALL_RECORD_RETENTION_DAYS = 30;

/** How long making the table of the records in a store that lacks it may take, in milliseconds. */
const DATA_STORE_CALL_RECORDS_SETUP_TIMEOUT_MS = 30_000;
/** How long removing the old records of one store may take, in milliseconds. */
const DATA_STORE_CALL_RECORDS_PRUNE_TIMEOUT_MS = 60_000;

/**
 * The statements that make the table of the records and the two functions the app role reaches
 * it through. Each finds what is there and adds what is missing, and takes from the app role
 * what an earlier version of this gave it on the table itself.
 */
export function callRecordsSetup(appRole: string): string {
  const app = quoteIdentifier(appRole);
  return `
    create table if not exists catalyst.calls (
      key text primary key,
      operation text not null,
      input_hash text not null,
      outcome jsonb not null,
      made_at timestamp with time zone not null default now()
    );
    create index if not exists calls_made_at on catalyst.calls (made_at);
    revoke all on catalyst.calls from ${app};
    create or replace function catalyst.recorded_call(call_key pg_catalog.text)
      returns table (operation pg_catalog.text, input_hash pg_catalog.text, outcome pg_catalog.jsonb)
      language sql stable security definer set search_path = pg_catalog
      as $recorded$
        select c.operation, c.input_hash, c.outcome from catalyst.calls c where c.key = call_key
      $recorded$;
    create or replace function catalyst.record_call(
      call_key pg_catalog.text,
      call_operation pg_catalog.text,
      call_input_hash pg_catalog.text,
      call_outcome pg_catalog.jsonb
    )
      returns pg_catalog.void
      language sql security definer set search_path = pg_catalog
      as $record$
        insert into catalyst.calls (key, operation, input_hash, outcome)
        values (call_key, call_operation, call_input_hash, call_outcome)
      $record$;
    revoke all on function catalyst.recorded_call(pg_catalog.text) from public;
    revoke all on function
      catalyst.record_call(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb)
      from public;
    grant usage on schema catalyst to ${app};
    grant execute on function catalyst.recorded_call(pg_catalog.text) to ${app};
    grant execute on function
      catalyst.record_call(pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb)
      to ${app};`;
}

/** One changing call that carried a key, as the store records it. */
export interface KeyedCall {
  /**
   * SHA-256 over who called and the key. The key itself is not kept: whoever may read the
   * rows of the store learns no key from the record, and two callers never share one.
   */
  key: string;
  operation: string;
  /** SHA-256 over the input with sorted keys. */
  inputHash: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, field]) => field !== undefined);
    return `{${entries
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, field]) => `${JSON.stringify(name)}:${canonicalJson(field)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The call as the store records it, from who made it, under which key, and with what. */
export function keyedCall(
  actor: AuthenticatedIdentity,
  idempotencyKey: string,
  operation: string,
  input: unknown
): KeyedCall {
  const holder = `${isAuthenticatedServicePrincipal(actor) ? "service_principal" : "user"}\n${actor.id}`;
  return {
    key: sha256(`${holder}\n${idempotencyKey}`),
    operation,
    inputHash: sha256(canonicalJson(input))
  };
}

const recordRow = z.object({
  operation: z.string(),
  input_hash: z.string(),
  outcome: z.record(z.string(), z.json())
});

const RECORDED = `
  select operation, input_hash, outcome from catalyst.recorded_call($1::pg_catalog.text)`;

/**
 * What the first call under the key was answered, or nothing where the store has no record of
 * the key. A key that is recorded for another call is refused: one key is one call.
 */
function answerOf(call: KeyedCall, rows: readonly JsonObject[]): JsonObject | undefined {
  const [row] = rows;
  if (row === undefined) return undefined;
  const recorded = recordRow.parse(row);
  if (recorded.operation !== call.operation || recorded.input_hash !== call.inputHash) {
    throw new AppError(
      "CONFLICT",
      "This idempotency key was used for another call on this Data Store: another operation or another input. One key is one call; send a new key for a new call.",
      { reason: "data_store_key_reused" }
    );
  }
  return recorded.outcome;
}

/** Asks the store for the answer of an earlier call under the key, before anything is checked or written. */
export async function readRecordedCall(
  runtime: DataStoreRuntime,
  target: PostgresTarget,
  call: KeyedCall
): Promise<JsonObject | undefined> {
  const read = await runtime.server.executor.query({
    ...target,
    sql: RECORDED,
    parameters: [call.key]
  });
  return answerOf(call, read.rows);
}

/**
 * Takes the key for the rest of the transaction and answers what an earlier call under it was
 * answered. A call under the same key at the same moment waits here until this one is kept or
 * rolled back, and then reads its record: of two such calls one changes the store.
 */
export async function claimCall(
  sql: PostgresChangeStatements,
  call: KeyedCall
): Promise<JsonObject | undefined> {
  await sql.run(
    `select pg_catalog.pg_advisory_xact_lock(
       pg_catalog.hashtextextended('catalyst call ' || $1::pg_catalog.text, 0)
     )::pg_catalog.text as held`,
    [call.key]
  );
  return answerOf(call, await sql.run(RECORDED, [call.key]));
}

/** Records the call with what it is answered, in the transaction of its rows. */
export async function recordCall(
  sql: PostgresChangeStatements,
  call: KeyedCall,
  outcome: JsonObject
): Promise<void> {
  await sql.run(
    `select catalyst.record_call(
       $1::pg_catalog.text, $2::pg_catalog.text, $3::pg_catalog.text, $4::pg_catalog.jsonb
     )::pg_catalog.text as recorded`,
    [call.key, call.operation, call.inputHash, JSON.stringify(outcome)]
  );
}

/**
 * Makes sure the store has the table of the records: a store that was provisioned before the
 * table existed gets it at its first call with a key. Asked once per store and process.
 */
export function ensureCallRecords(
  runtime: DataStoreRuntime,
  record: Pick<DataStoreRecord, "id" | "location" | "roles">,
  signal: AbortSignal | undefined
): Promise<void> {
  const known = runtime.callRecords.get(record.id);
  if (known) return known;
  const made = runtime.server.executor
    .change(
      {
        ...runtime.server.asPlatform(record.location.database),
        timeoutMs: DATA_STORE_CALL_RECORDS_SETUP_TIMEOUT_MS,
        ...(signal ? { signal } : {})
      },
      async (sql) => {
        // Two processes that make the table at once would each find it missing.
        await sql.run(
          `select pg_catalog.pg_advisory_xact_lock(
             pg_catalog.hashtextextended('catalyst call records', 0)
           )::pg_catalog.text as held`
        );
        await sql.script(
          `create schema if not exists catalyst;${callRecordsSetup(record.roles.app)}`
        );
      }
    )
    .catch((error: unknown) => {
      runtime.callRecords.delete(record.id);
      throw error;
    });
  runtime.callRecords.set(record.id, made);
  return made;
}

/** Removes the records of one store that are older than their retention. Answers how many. */
export async function pruneCallRecords(
  runtime: DataStoreRuntime,
  record: Pick<DataStoreRecord, "id" | "location" | "roles">,
  signal: AbortSignal
): Promise<number> {
  await ensureCallRecords(runtime, record, signal);
  return runtime.server.executor.change(
    {
      ...runtime.server.asPlatform(record.location.database),
      timeoutMs: DATA_STORE_CALL_RECORDS_PRUNE_TIMEOUT_MS,
      signal
    },
    async (sql) => {
      const [removed] = await sql.run(
        `with gone as (
           delete from catalyst.calls
           where made_at < pg_catalog.now() - pg_catalog.make_interval(days => $1::pg_catalog.int4)
           returning 1
         )
         select pg_catalog.count(*)::pg_catalog.int4 as count from gone`,
        [DATA_STORE_CALL_RECORD_RETENTION_DAYS]
      );
      return z.object({ count: z.number().int() }).parse(removed).count;
    }
  );
}
