import type {
  PostgresChangeInput,
  PostgresChangeStatements,
  PostgresTarget
} from "@vivd-catalyst/postgres-connector";
import {
  AppError,
  type DataStoreOperationVerb,
  type DataStoreRecord,
  type OperationChangeClass,
  type OperationEffect,
  type OperationResource
} from "@vivd-catalyst/core";
import type { z } from "zod";
import type { DataStoreDefinition } from "./definition";
import type { DataStoreRuntime } from "./runtime";

// What every verb on the rows of a store is made of, and what the verbs that write share.

/** A store as its operations read it: the published definition and the record of its database. */
export interface PublishedStore {
  definition: DataStoreDefinition;
  record: DataStoreRecord;
  resource: OperationResource;
}

/** What one call of a verb works with: the store and the way to its database as the app role. */
interface VerbCall {
  runtime: DataStoreRuntime;
  store: PublishedStore;
  /** The database of the store as its app role, cancelled with the call. */
  target: PostgresTarget;
}

/**
 * One verb: what it takes, what it does and how an agent is told to use it. The right it asks
 * is the contract's (`DATA_STORE_OPERATION_RIGHTS`).
 */
export interface StoreVerb {
  verb: DataStoreOperationVerb;
  effect: OperationEffect;
  changeClass?: OperationChangeClass;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  /** What an agent reads of the tool, after the sentence that names the store. Missing where no agent is offered it. */
  use?: string;
  /** The rights one call needs beside the verb's own, by what it asks for. */
  furtherRights?(input: unknown): readonly string[];
  /** How long one call may take, in milliseconds, where the statement timeout of the app role is not its bound. */
  timeoutMs?: number;
  run(call: VerbCall, input: unknown): Promise<unknown>;
}

export function tableUnknown(table: string): AppError {
  return new AppError("VALIDATION_FAILED", `The store has no table '${table}'`, {
    reason: "table_unknown"
  });
}

/**
 * The failure of a change that had done all its work: its transaction was being kept when it
 * failed, so whether its rows are stored is not known.
 */
export class CommitOutcomeUnknown extends Error {
  constructor(readonly failure: unknown) {
    super("The change failed while its transaction was being kept");
  }
}

/**
 * Runs the whole of a changing verb as one transaction. A failure inside `work` rolls all of
 * it back and leaves here as it is. One that comes once `work` has ended leaves as
 * `CommitOutcomeUnknown`: only that one may have changed the store.
 */
export async function changeWhole<Result>(
  runtime: DataStoreRuntime,
  input: PostgresChangeInput,
  work: (sql: PostgresChangeStatements) => Promise<Result>
): Promise<Result> {
  let worked = false;
  try {
    return await runtime.server.executor.change(input, async (sql) => {
      const result = await work(sql);
      worked = true;
      return result;
    });
  } catch (error) {
    throw worked ? new CommitOutcomeUnknown(error) : error;
  }
}

/** The refusal of rows for a store that is at its size limit, or that they would take past it. */
export function storeFull(record: DataStoreRecord, sizeBytes: number): AppError {
  return new AppError(
    "CONFLICT",
    `The Data Store '${record.name}' holds ${sizeBytes} bytes and its size limit is ${record.sizeLimitBytes} bytes (sizeLimit). No rows are added until it is smaller or the limit is raised; reading keeps working.`,
    { reason: "data_store_size_limit", limit: record.sizeLimitBytes, actual: sizeBytes }
  );
}

/** How long giving back what a refused insert wrote may take. Past it the space stays for the server's own vacuum. */
const DATA_STORE_RECLAIM_TIMEOUT_MS = 60_000;

/**
 * Gives the space of rows that were written and not kept back to the files of a store, as the
 * platform's own role, which owns the database. A refused insert and one the database ended
 * for its time leave such rows, and a store whose files stay over its limit takes no insert.
 * Postgres gives back what lies at the end of a table; the rest is free for later rows.
 */
export async function reclaim(runtime: DataStoreRuntime, record: DataStoreRecord): Promise<void> {
  await runtime.server.executor
    .change(
      {
        ...runtime.server.asPlatform(record.location.database),
        timeoutMs: DATA_STORE_RECLAIM_TIMEOUT_MS,
        transaction: false
      },
      (sql) => sql.script("vacuum")
    )
    .catch(() =>
      runtime.logger.warn(
        { storeId: record.id },
        "The space of a refused insert was not given back"
      )
    );
}
