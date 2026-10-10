import { z } from "zod";
import type { JsonObject, ScopedSecretResolver } from "@vivd-catalyst/core";
import { describePostgres, type PostgresDescribeResult } from "./describe";
import { PostgresExecutorError, toPostgresExecutorError } from "./errors";
import {
  POSTGRES_CURSOR_BATCH_ROWS,
  POSTGRES_DEADLINE_GRACE_MS,
  resolvePostgresLimits,
  type PostgresLimits,
  type ResolvedPostgresLimits
} from "./limits";
import {
  bindPostgresParameters,
  textParameter,
  type BoundPostgresParameter,
  type PostgresParameter
} from "./parameters";
import {
  PostgresConnection,
  PostgresPool,
  type PostgresSession,
  type PostgresTextRow
} from "./pool";
import { readPostgresPrivileges, type PostgresPrivileges } from "./privileges";
import { screenPostgresQuery } from "./screen";
import type { PinPostgresAddress, PostgresLocation } from "./socket";
import { postgresValueReader, readPostgresRow, type PostgresValueReader } from "./values";

/** Which database a call goes to, under which credential and limits. */
export interface PostgresTarget {
  location: PostgresLocation;
  /** The name the password is resolved by. Never the password. */
  credentialHandle: string;
  limits?: PostgresLimits;
  /** Aborting it cancels the query on the server. */
  signal?: AbortSignal;
}

export interface PostgresQueryInput extends PostgresTarget {
  sql: string;
  parameters?: readonly PostgresParameter[];
}

export interface PostgresQueryResult {
  /** Present even when no row is. `type` is the database's name of the column type. */
  columns: { name: string; type: string }[];
  rows: JsonObject[];
  rowCount: number;
  truncated: boolean;
  /** Which cap ended the result. */
  truncatedBy?: "rows" | "bytes";
}

export interface PostgresDescribeInput extends PostgresTarget {
  /** A relation name, alone or qualified by its schema. Omit it to list the relations. */
  relation?: string;
}

/**
 * Runs every query against a database outside the platform. Each call takes a connection from
 * a bounded pool, works in a read-only transaction under a statement timeout and the
 * configured search path, and ends with a rollback. The platform's own timer cancels a call
 * the database did not end. Every failure is a `PostgresExecutorError`.
 */
export interface PostgresExecutor {
  query(input: PostgresQueryInput): Promise<PostgresQueryResult>;
  describe(input: PostgresDescribeInput): Promise<PostgresDescribeResult>;
  /** What the account may read and change. Data about the role only, never a business row. */
  readPrivileges(target: PostgresTarget): Promise<PostgresPrivileges>;
  ping(target: PostgresTarget): Promise<void>;
  /** Closes the idle connections. Call it when no call is in flight. */
  close(): Promise<void>;
}

export interface CreatePostgresExecutorInput {
  secrets: ScopedSecretResolver;
  pinAddress: PinPostgresAddress;
}

export function createPostgresExecutor(input: CreatePostgresExecutorInput): PostgresExecutor {
  const pools = new Map<string, PostgresPool>();

  /** One pool per target and credential handle. The schemas and limits of a call do not split it. */
  function poolFor({ location, credentialHandle }: PostgresTarget): PostgresPool {
    const key = JSON.stringify([
      location.host,
      location.port,
      location.database,
      location.user,
      location.tls,
      location.caBundle ?? null,
      credentialHandle
    ]);
    let pool = pools.get(key);
    if (!pool) {
      pool = new PostgresPool(
        () => new PostgresConnection({ ...input, location, credentialHandle })
      );
      pools.set(key, pool);
    }
    return pool;
  }

  async function guarded<T>(
    target: PostgresTarget,
    work: (session: PostgresSession, limits: ResolvedPostgresLimits) => Promise<T>
  ): Promise<T> {
    const limits = resolvePostgresLimits(target.limits);
    const pool = poolFor(target);
    const connection = await pool.acquire(limits.maxConnections, target.signal);
    const interruption = watchInterruption(
      limits.statementTimeoutMs + POSTGRES_DEADLINE_GRACE_MS,
      target.signal
    );
    const first = await Promise.race([
      interruption.raised,
      rolledBack(connection, async () => {
        await applySettings(connection, target.location.schemas, limits.statementTimeoutMs);
        return work(connection, limits);
      })
    ]);
    interruption.stop();
    if (typeof first === "string") {
      await connection.cancelRunningQuery(POSTGRES_DEADLINE_GRACE_MS);
      pool.discard(connection);
      throw new PostgresExecutorError(first);
    }
    if (first.clean) pool.release(connection);
    else pool.discard(connection);
    if (first.outcome.ok) return first.outcome.value;
    throw toPostgresExecutorError(first.outcome.error);
  }

  return {
    async query(query) {
      screenPostgresQuery(query.sql);
      const parameters = bindPostgresParameters(query.parameters ?? []);
      return guarded(query, async (session, limits) => {
        const columns = await resultColumns(session, await session.columns(query.sql, parameters));
        const batchRows = Math.min(POSTGRES_CURSOR_BATCH_ROWS, limits.maxRows + 1);
        const batches = session.cursor(query.sql, parameters, batchRows);
        const read = await readCapped(batches, columns, limits);
        return {
          columns: columns.map(({ name, type }) => ({ name, type })),
          rows: read.rows,
          rowCount: read.rows.length,
          truncated: read.truncatedBy !== undefined,
          ...(read.truncatedBy === undefined ? {} : { truncatedBy: read.truncatedBy })
        };
      });
    },
    describe: (describe) =>
      guarded(describe, (session, limits) =>
        describePostgres(session, {
          schemas: describe.location.schemas,
          maxRelations: limits.maxRows,
          ...(describe.relation === undefined ? {} : { relation: describe.relation })
        })
      ),
    readPrivileges: (target) => guarded(target, (session) => readPostgresPrivileges(session)),
    async ping(target) {
      await guarded(target, (session) => session.run("select 1"));
    },
    async close() {
      await Promise.all([...pools.values()].map((pool) => pool.close()));
      pools.clear();
    }
  };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Runs `work` in a read-only transaction that always ends with a rollback, so nothing a query
 * set on the session outlives it. It never rejects. `clean` says whether the rollback went
 * through, which is what makes the connection fit for the next call.
 */
async function rolledBack<T>(
  connection: PostgresConnection,
  work: () => Promise<T>
): Promise<{ outcome: Outcome<T>; clean: boolean }> {
  try {
    await connection.beginReadOnly();
  } catch (error) {
    return { outcome: { ok: false, error }, clean: false };
  }
  let outcome: Outcome<T>;
  try {
    outcome = { ok: true, value: await work() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await connection.run("rollback");
    return { outcome, clean: true };
  } catch {
    return { outcome, clean: false };
  }
}

/** Both settings last for the transaction only, and the rollback removes them. */
async function applySettings(
  session: PostgresSession,
  schemas: readonly string[],
  statementTimeoutMs: number
): Promise<void> {
  const timeout = textParameter(String(statementTimeoutMs));
  if (schemas.length === 0) {
    await session.run("select set_config('statement_timeout', $1, true)", [timeout]);
    return;
  }
  const searchPath = schemas.map((schema) => `"${schema.replaceAll('"', '""')}"`).join(", ");
  await session.run(
    "select set_config('statement_timeout', $1, true), set_config('search_path', $2, true)",
    [timeout, textParameter(searchPath)]
  );
}

/**
 * The platform's own end of a call: the deadline, or the caller's abort. It resolves with the
 * kind of error the call then fails with. No setting a query can change reaches it.
 */
function watchInterruption(
  deadlineMs: number,
  signal: AbortSignal | undefined
): { raised: Promise<"timeout" | "cancelled">; stop(): void } {
  let stop = (): void => undefined;
  const raised = new Promise<"timeout" | "cancelled">((resolve) => {
    const onAbort = () => resolve("cancelled");
    const timer = setTimeout(() => resolve("timeout"), deadlineMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
  });
  return { raised, stop };
}

const typeRow = z.object({
  oid: z.string(),
  name: z.string(),
  element_oid: z.string().nullable(),
  delimiter: z.string().nullable()
});

/** The name of each type of a result and, for an array type, what its elements are. */
const RESULT_TYPES = `
  select
    type.oid::text as oid,
    pg_catalog.format_type(type.oid, null) as name,
    element.oid::text as element_oid,
    element.typdelim::text as delimiter
  from pg_catalog.pg_type type
  left join pg_catalog.pg_type element
    on element.oid = type.typelem and type.typcategory = 'A'
  where type.oid = any($1::oid[])
`;

interface ResultColumn {
  name: string;
  type: string;
  read: PostgresValueReader;
}

async function resultColumns(
  session: PostgresSession,
  columns: readonly { name: string; typeOid: number }[]
): Promise<ResultColumn[]> {
  if (columns.length === 0) return [];
  const oids: BoundPostgresParameter = {
    oid: 0,
    text: `{${[...new Set(columns.map((column) => column.typeOid))].join(",")}}`
  };
  const types = new Map(
    z
      .array(typeRow)
      .parse(await session.run(RESULT_TYPES, [oids]))
      .map((type) => [type.oid, type])
  );
  return columns.map((column) => {
    const type = types.get(String(column.typeOid));
    const element =
      type?.element_oid && type.delimiter
        ? { element: { oid: Number(type.element_oid), delimiter: type.delimiter } }
        : {};
    return {
      name: column.name,
      type: type?.name ?? "unknown",
      read: postgresValueReader({ oid: column.typeOid, ...element })
    };
  });
}

/**
 * Reads batches until a cap is reached and then stops reading, which closes the cursor. A row
 * counts with the bytes of its JSON form, and the row that would cross the byte cap is left out.
 */
async function readCapped(
  batches: AsyncIterable<PostgresTextRow[]>,
  columns: readonly ResultColumn[],
  limits: ResolvedPostgresLimits
): Promise<{ rows: JsonObject[]; truncatedBy?: "rows" | "bytes" }> {
  const rows: JsonObject[] = [];
  let bytes = 0;
  for await (const batch of batches) {
    for (const raw of batch) {
      if (rows.length === limits.maxRows) return { rows, truncatedBy: "rows" };
      const row = readPostgresRow(raw, columns);
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (bytes > limits.maxBytes) return { rows, truncatedBy: "bytes" };
      rows.push(row);
    }
  }
  return { rows };
}
