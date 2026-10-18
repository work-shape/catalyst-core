import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import {
  AppError,
  auditActorFromIdentity,
  DATA_STORE_LOAD_CHANGE_RIGHT,
  DATA_STORE_LOAD_DEFAULT_LIMITS,
  dataStoreLoadInputSchema,
  dataStoreLoadResultSchema,
  dataStoreOperationName,
  type DataStoreLoadResult,
  type JsonObject
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { readKeyIndexes, readTables } from "./catalog";
import { replacementStatements } from "./load-replace";
import { statementsOf, rowOf, type LoadStatements } from "./load-statements";
import { storeSizeBytes } from "./size";
import {
  AnsweredBefore,
  changeWhole,
  reclaim,
  storeFull,
  tableUnknown,
  type StoreVerb
} from "./verbs";

// `load`: the rows of a dataset of a Workflow Run into one table of a store, all in one
// transaction as the app role. A reader of the table sees the rows as they were until the
// load is kept, and then all of it: also where it replaces rows. It holds to what an insert
// holds to, and to a bound of its own on one call.

/** How many rows one statement of a load writes at most. */
const DATA_STORE_LOAD_STATEMENT_ROWS = 1_000;
/** How large the rows of one statement of a load are at most, as JSON, in bytes: one row where a row is larger. */
const DATA_STORE_LOAD_STATEMENT_BYTES = 1_048_576;
/** How much longer than the load its run may stay `running` before it counts as interrupted, in milliseconds. */
const DATA_STORE_LOAD_RUN_GRACE_MS = 30_000;

function refused(message: string, details: JsonObject): AppError {
  return new AppError("VALIDATION_FAILED", message, details);
}

function tooLarge(
  cap: "ROWS" | "BYTES",
  actual: number,
  limits: { rows: number; bytes: number }
): AppError {
  const [limit, unit] = cap === "ROWS" ? [limits.rows, "rows"] : [limits.bytes, "bytes"];
  return refused(
    `The dataset has ${cap === "ROWS" ? "" : "rows of "}${actual} ${unit} or more. One load takes at most ${limits.rows} rows (dataStores.load.rows) and ${limits.bytes} bytes of rows (dataStores.load.bytes, as JSON); produce smaller datasets upstream for separate calls, or raise the dataStores.load operator ceilings.`,
    {
      reason: "load_too_large",
      cap: cap === "ROWS" ? "dataStores.load.rows" : "dataStores.load.bytes",
      limit,
      actual
    }
  );
}

const checkedRow = z.object({ empty: z.number().nullable(), twice: z.number().nullable() });
const deletedRow = z.object({ count: z.number().int() });
const writtenRow = z.object({ inserted: z.number().int(), updated: z.number().int() });
export const load: StoreVerb = {
  verb: "load",
  effect: "changing",
  // A load that replaces or updates leaves nothing of the rows that were there.
  changeClass: "irreversible",
  inputSchema: dataStoreLoadInputSchema,
  outputSchema: dataStoreLoadResultSchema,
  timeoutMs: DATA_STORE_LOAD_DEFAULT_LIMITS.timeoutMs + DATA_STORE_LOAD_RUN_GRACE_MS,
  // Adding rows is `data_store.insert`. Changing or removing rows that are stored is more.
  furtherRights(call) {
    const input = dataStoreLoadInputSchema.safeParse(call);
    return !input.success || input.data.onConflict === "update" || input.data.replace
      ? [DATA_STORE_LOAD_CHANGE_RIGHT]
      : [];
  },
  async run({ runtime, store, target, keyed, context }, call) {
    const input = dataStoreLoadInputSchema.parse(call);
    const { record } = store;
    const limits = runtime.limits.load ?? DATA_STORE_LOAD_DEFAULT_LIMITS;
    const stepId = context?.origin.kind === "workflow" ? context.origin.stepRunId : undefined;
    const replay = async (sql: Pick<PostgresChangeStatements, "run">) => {
      if (!stepId) return undefined;
      const [row] = await sql.run("select catalyst.recorded_load($1::text) as outcome", [stepId]);
      return row?.outcome == null ? undefined : dataStoreLoadResultSchema.parse(row.outcome);
    };
    const beforeLoad = stepId
      ? await replay({
          run: async (sql, parameters) =>
            (
              await runtime.server.executor.query({
                ...target,
                sql,
                ...(parameters ? { parameters } : {})
              })
            ).rows
        })
      : undefined;
    if (beforeLoad) return beforeLoad;
    const reader = runtime.datasets;
    if (!reader) {
      throw refused(
        `${dataStoreOperationName(record.name, "load")} is not supported yet: a dataset of a Workflow Run cannot be loaded into a Data Store by this release. Add rows with ${dataStoreOperationName(record.name, "insert")}.`,
        { reason: "not_supported_yet" }
      );
    }
    // What the reference says is refused before a row is read. What the dataset holds is
    // counted as it is read, since a reference is a caller's word.
    if (input.dataset.rowCount > limits.rows) {
      throw tooLarge("ROWS", input.dataset.rowCount, limits);
    }
    let knownBytes = input.dataset.offset === undefined ? input.dataset.bytes : undefined;
    if (input.dataset.offset !== undefined) {
      // A view's `bytes` belongs to its parent. Part-aligned views have a known size of their
      // own, including an offset-zero view over the whole dataset. Other cuts are counted below.
      const parent = await runtime.stores.workflowRunDatasets.get({
        clientInstanceId: runtime.clientInstanceId,
        id: input.dataset.$dataset
      });
      if (parent?.state === "complete") {
        let skip = input.dataset.offset;
        let left = input.dataset.rowCount;
        let bytes = 0;
        for (const part of parent.parts) {
          if (left === 0) break;
          if (skip >= part.rows) {
            skip -= part.rows;
            continue;
          }
          if (skip !== 0 || left < part.rows) break;
          bytes += part.bytes;
          left -= part.rows;
        }
        if (skip === 0 && left === 0) knownBytes = bytes;
      }
    }
    if (knownBytes !== undefined && knownBytes > limits.bytes) {
      throw tooLarge("BYTES", knownBytes, limits);
    }
    const [table] = await readTables(runtime.server.executor, target, input.table);
    if (!table) throw tableUnknown(input.table);
    const tableName = table.name;
    // The names and types that go into the statements are the catalog's, never a caller's text.
    const typeOf = new Map(
      table.columns.flatMap((column) =>
        column.generated ? [] : [[column.name, column.nativeType] as const]
      )
    );
    const scope = input.replace?.values;
    const scopedReplace =
      input.replace && scope !== undefined
        ? replacementStatements(tableName, typeOf, input.replace.by)
        : undefined;
    let keyMayBeEmpty = false;
    if (input.key) {
      const indexes = await readKeyIndexes(runtime.server.executor, target, table.name, input.key);
      if (indexes.length === 0) {
        throw refused(
          `The table '${table.name}' has no unique constraint over exactly the columns of the key (${input.key.join(", ")}) that holds for all rows and is not deferrable. Name as key the columns of such a constraint.`,
          { reason: "key_without_constraint" }
        );
      }
      keyMayBeEmpty = !indexes.some((index) => index.nulls_not_distinct);
    }
    const size = () => storeSizeBytes(runtime.server, record.location.database, target.signal);
    const before = await size();
    if (before >= record.sizeLimitBytes) throw storeFull(record, before);

    const counts = { rows: 0, bytes: 0, inserted: 0, updated: 0, deleted: 0 };
    let statements: LoadStatements | undefined;
    // Whatever a change throws leaves it as a failure of the database, so a refusal is kept
    // here and raised once the change has rolled back.
    let refusal: AppError | undefined;
    let wrote = false;
    let replayed: DataStoreLoadResult | undefined;

    /** Checks and writes the rows of one statement, the first of which is row `first` of the dataset. */
    async function writePart(
      sql: PostgresChangeStatements,
      { check, lock, remove, write }: LoadStatements,
      rows: readonly string[],
      first: number
    ): Promise<void> {
      const part = `[${rows.join(",")}]`;
      if (
        scopedReplace &&
        deletedRow.parse((await sql.run(scopedReplace.outside, [part, JSON.stringify(scope)]))[0])
          .count > 0
      ) {
        throw refused(
          "Every row of a scoped replacement must match 'replace.values'. Nothing was loaded.",
          {
            reason: "replace_scope_mismatch"
          }
        );
      }
      if (check) {
        const { empty, twice } = checkedRow.parse((await sql.run(check, [part]))[0]);
        if (empty !== null) {
          throw refused(
            `Row ${first + empty - 1} has an empty key. A row without a key is never found again, so a later load would add it once more. Set every column of the key in every row.`,
            { reason: "nullable_key", row: first + empty - 1 }
          );
        }
        if (twice !== null) {
          throw refused(
            `Row ${first + twice - 1} has the key of a row before it. A dataset holds each key once.`,
            { reason: "duplicate_key", row: first + twice - 1 }
          );
        }
      }
      wrote = true;
      // Before the statement that deletes: it then sees what a load before this one stored.
      if (lock) await sql.run(lock, [part, tableName]);
      if (remove) counts.deleted += deletedRow.parse((await sql.run(remove, [part]))[0]).count;
      const written = writtenRow.parse((await sql.run(write, [part]))[0]);
      counts.inserted += written.inserted;
      counts.updated += written.updated;
      // The size is read as for an insert, after every statement: a load that takes the store
      // past its limit ends there and not at its last row.
      const after = await size();
      if (after > record.sizeLimitBytes) throw storeFull(record, after);
    }

    try {
      const result = await changeWhole(
        { runtime, keyed },
        { ...target, timeoutMs: limits.timeoutMs },
        async (sql) => {
          try {
            if (stepId) {
              await sql.run(
                "select pg_advisory_xact_lock(hashtextextended('catalyst load ' || $1::text, 0))::text as held",
                [stepId]
              );
              replayed = await replay(sql);
              if (replayed) throw new AnsweredBefore(replayed);
            }
            // The app role normally limits each statement to 15 seconds; a bulk load uses
            // the operator's own timeout for its transaction and statements.
            await sql.run("select set_config('statement_timeout', $1, true)", [
              String(limits.timeoutMs)
            ]);
            if (input.replace) {
              // Group locks survive every streamed chunk. Serialize replacements of this
              // table before any group lock, since later chunks can visit groups in any order.
              await sql.run(
                "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('catalyst replace table ' || $1::pg_catalog.text, 0))::pg_catalog.text as held",
                [tableName]
              );
            }
            if (scopedReplace) {
              const group = JSON.stringify([scope]);
              await sql.run(scopedReplace.lock, [group, tableName]);
              wrote = true;
              counts.deleted += deletedRow.parse(
                (await sql.run(scopedReplace.remove, [group]))[0]
              ).count;
            }
            let pending: string[] = [];
            let pendingBytes = 0;
            let written = 0;
            const flush = async (plan: LoadStatements) => {
              if (pending.length === 0) return;
              await writePart(sql, plan, pending, written + 1);
              written += pending.length;
              pending = [];
              pendingBytes = 0;
            };
            for await (const rows of reader.read(input.dataset, target.signal, context)) {
              for (const row of rows) {
                statements ??= statementsOf(input, table, typeOf, Object.keys(row), keyMayBeEmpty);
                counts.rows += 1;
                if (counts.rows > limits.rows) throw tooLarge("ROWS", counts.rows, limits);
                const text = rowOf(statements, input.columns !== undefined, row, counts.rows);
                const bytes = Buffer.byteLength(text);
                counts.bytes += bytes;
                if (counts.bytes > limits.bytes) throw tooLarge("BYTES", counts.bytes, limits);
                if (
                  pending.length === DATA_STORE_LOAD_STATEMENT_ROWS ||
                  pendingBytes + bytes > DATA_STORE_LOAD_STATEMENT_BYTES
                ) {
                  await flush(statements);
                }
                pending.push(text);
                pendingBytes += bytes;
              }
            }
            if (statements) await flush(statements);
            // What the store left to the end of the transaction happens now, before the size
            // is read for the last time.
            await sql.script("set constraints all immediate");
            const after = await size();
            if (after > record.sizeLimitBytes) throw storeFull(record, after);
            const result = {
              table: table.name,
              inserted: counts.inserted,
              updated: counts.updated,
              skipped: counts.rows - counts.inserted - counts.updated,
              deleted: counts.deleted
            } satisfies DataStoreLoadResult;
            if (stepId)
              await sql.run("select catalyst.record_load($1::text, $2::jsonb)::text as recorded", [
                stepId,
                JSON.stringify(result)
              ]);
            return result;
          } catch (error) {
            if (error instanceof AppError) refusal = error;
            throw error;
          }
        }
      );
      if (context?.origin.kind === "workflow")
        await context.audit.record({
          type: "workflow_run.dataset_loaded",
          actor: auditActorFromIdentity(context.actor),
          status: "success",
          subject: input.dataset.$dataset,
          correlationId: context.correlationId,
          metadata: {
            ...(stepId ? { stepRunId: stepId } : {}),
            ...(context.origin.kind === "workflow" ? { runId: context.origin.workflowRunId } : {}),
            datasetId: input.dataset.$dataset,
            rowCount: counts.rows,
            bytes: counts.bytes,
            ...result
          }
        });
      return result;
    } catch (error) {
      if (replayed) throw new AnsweredBefore(replayed);
      // Rows that were written and not kept still fill the files of the store.
      if (wrote) await reclaim(runtime, record);
      throw refusal ?? error;
    }
  }
};
