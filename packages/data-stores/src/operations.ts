import {
  POSTGRES_PARAMETERS_MAX_COUNT,
  POSTGRES_QUERY_TEXT_MAX_CHARS,
  POSTGRES_RESULT_MAX_BYTES,
  POSTGRES_RESULT_MAX_ROWS,
  POSTGRES_STATEMENT_TIMEOUT_MS,
  PostgresExecutorError
} from "@vivd-catalyst/postgres-connector";
import {
  AppError,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_OPERATION_PREFIX,
  DATA_STORE_OPERATION_RIGHTS,
  DATA_STORE_OPERATION_SCOPES,
  DATA_STORE_PREVIEW_ROW_LIMIT,
  DATA_STORE_SCALAR_TYPES,
  dataStoreInsertConflictSchema,
  dataStoreInsertResultSchema,
  dataStoreOperationName,
  type ConfigAssetRecord,
  type DataStoreInsertResult,
  type DataStoreParameterType,
  type DataStoreRecord,
  type DataStoreSchema,
  type DataToolDescriptor,
  type DataToolSource,
  type JsonObject,
  type OperationDefinition,
  type OperationSource
} from "@vivd-catalyst/core";
import { z } from "zod";
import { catalogTarget, readTables, rowsOf } from "./catalog";
import { dataStoreDefinitionSchema } from "./definition";
import { databaseFailureError } from "./failures";
import { DATA_STORE_ROLE_LIMITS } from "./role-limits";
import type { DataStoreRuntime } from "./runtime";
import { asStoreRole } from "./roles";
import { quoteIdentifier } from "./server";
import { storeSizeBytes } from "./size";
import { reclaim, storeFull, tableUnknown, type PublishedStore, type StoreVerb } from "./verbs";
import { load } from "./load";

// The operations on the rows of one store. Each is called through `runOperation` like every
// other operation: this file says who may call it and what it does, as the app role of the
// store. The database decides what that role may do; nothing here stands in for that. Each
// has one name, `data_store.<id>.<verb>`, whoever calls it: a Workflow step, an agent, or the
// route of the HTTP API that names the store in its path.

/** The module the operations belong to. */
const DATA_STORES_MODULE = "dataStores";

/** How many rows one insert adds at most. A call with more is refused; send them in several calls. */
const DATA_STORE_INSERT_MAX_ROWS = 1_000;
/** How large the rows of one insert are at most, as JSON. A larger call is refused. */
const DATA_STORE_INSERT_MAX_BYTES = 1_048_576;
/** How long a name of a table or a column is at most: the length Postgres keeps of a name. */
const DATA_STORE_IDENTIFIER_MAX_CHARS = 63;
/** How many stores one listing of operations reads. More than that is reported as truncated. */
const DATA_STORE_LIST_MAX_STORES = 1_000;
/**
 * How much longer than its statement a run may stay `running` before it counts as
 * interrupted, in milliseconds. It covers the wait for a connection and the reads around it.
 */
const DATA_STORE_RUN_GRACE_MS = 30_000;
const RUN_TIMEOUT_MS = DATA_STORE_ROLE_LIMITS.app.statementTimeoutMs + DATA_STORE_RUN_GRACE_MS;

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const valueSchema = z.union([scalarSchema, z.array(scalarSchema)]);
const parameterTypes: readonly DataStoreParameterType[] = DATA_STORE_SCALAR_TYPES.flatMap(
  (type) => [type, `${type}[]`] as const
);
const tableNameSchema = z.string().min(1).max(DATA_STORE_IDENTIFIER_MAX_CHARS);

const queryInputSchema = z.strictObject({
  sql: z.string().min(1).max(POSTGRES_QUERY_TEXT_MAX_CHARS),
  parameters: z
    .array(
      z.union([valueSchema, z.strictObject({ type: z.enum(parameterTypes), value: valueSchema })])
    )
    .max(POSTGRES_PARAMETERS_MAX_COUNT)
    .optional()
});

const rowsSchema = z.object({
  columns: z.array(z.object({ name: z.string(), type: z.string(), nativeType: z.string() })),
  rows: z.array(z.record(z.string(), z.json())),
  truncated: z.boolean()
});

const insertInputSchema = z.strictObject({
  table: tableNameSchema,
  rows: z
    .array(z.record(z.string().min(1).max(DATA_STORE_IDENTIFIER_MAX_CHARS), z.json()))
    .min(1)
    .max(DATA_STORE_INSERT_MAX_ROWS),
  onConflict: dataStoreInsertConflictSchema
});

const describeInputSchema = z.strictObject({});

const previewInputSchema = z.strictObject({
  table: tableNameSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(DATA_STORE_PREVIEW_ROW_LIMIT)
    .default(DATA_STORE_PREVIEW_ROW_LIMIT)
});

const jsonObjectSchema = z.record(z.string(), z.json());

/** The columns the rows of one insert name: those of its first row, which every row shares. */
function sharedColumns(rows: readonly JsonObject[]): string[] {
  const columns = Object.keys(rows[0] ?? {});
  const differing = rows.findIndex((row) => {
    const keys = Object.keys(row);
    return keys.length !== columns.length || !columns.every((column) => column in row);
  });
  if (columns.length === 0 || differing !== -1) {
    throw new AppError(
      "VALIDATION_FAILED",
      columns.length === 0
        ? "A row names at least one column"
        : `Row ${differing + 1} names other columns than row 1. All rows of one insert name the same columns; a column that is left out of all of them takes its default.`,
      { reason: "rows_differ" }
    );
  }
  return columns;
}

const insertedRow = z.object({ count: z.number().int() });

/**
 * The unique indexes of a table, each with its keys as the database writes them (a column or
 * an expression) and the columns a row must hold for the key to be worked out: those the key
 * names, and for a column the database computes, the columns it computes it from. A column an
 * index only carries (`include`) is no key.
 */
const UNIQUE_INDEXES = `
  select i.indnullsnotdistinct as nulls_not_distinct,
    i.indimmediate as immediate,
    i.indpred is not null as partial,
    array(
      select pg_catalog.pg_get_indexdef(i.indexrelid, key, true)
      from pg_catalog.generate_series(1, i.indnkeyatts) key order by key
    ) as keys,
    array(
      select distinct base.attname::text
      from pg_catalog.pg_attribute used
      left join pg_catalog.pg_attrdef def
        on def.adrelid = used.attrelid and def.adnum = used.attnum and used.attgenerated <> ''
      left join pg_catalog.pg_depend derived
        on derived.refclassid = 'pg_catalog.pg_class'::regclass
        and derived.refobjid = used.attrelid and derived.refobjsubid > 0
        and ((derived.classid = 'pg_catalog.pg_attrdef'::regclass and derived.objid = def.oid)
          or (derived.classid = 'pg_catalog.pg_class'::regclass
            and derived.objid = used.attrelid and derived.objsubid = used.attnum
            and used.attgenerated <> ''))
        and derived.refobjsubid <> used.attnum
      join pg_catalog.pg_attribute base
        on base.attrelid = used.attrelid
        and base.attnum = coalesce(derived.refobjsubid, used.attnum)
      where used.attrelid = i.indrelid and used.attnum > 0 and (
        used.attnum = any ((i.indkey::int2[])[0:i.indnkeyatts - 1])
        or (0 = any (i.indkey::int2[]) and exists (
          select 1 from pg_catalog.pg_depend expression
          where expression.classid = 'pg_catalog.pg_class'::regclass
            and expression.objid = i.indexrelid and expression.refobjid = i.indrelid
            and expression.refobjsubid = used.attnum)))
    ) as needs
  from pg_catalog.pg_index i
  join pg_catalog.pg_class c on c.oid = i.indrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = $1 and i.indisunique
`;

const uniqueIndexRow = z.object({
  nulls_not_distinct: z.boolean(),
  immediate: z.boolean(),
  partial: z.boolean(),
  keys: z.array(z.string()),
  needs: z.array(z.string())
});

type CatalogTable = Awaited<ReturnType<typeof readTables>>[number];
type UniqueIndex = z.infer<typeof uniqueIndexRow>;

/**
 * The unique indexes `skip` may go by, or the refusal. The rule is one: a row is left out
 * only on a unique key that holds for all rows, is not deferrable, and whose columns every
 * row of the call gives. A key the call leaves to a default may be another one every time, an
 * index over a part of the rows binds no row for certain, and Postgres skips on no deferrable
 * constraint at all.
 */
function skipKeys(
  table: CatalogTable,
  given: readonly string[],
  indexes: readonly UniqueIndex[]
): UniqueIndex[] {
  if (indexes.some((index) => !index.immediate)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `The table '${table.name}' has a deferrable unique constraint, on which Postgres skips no row. Make the constraint not deferrable, or leave onConflict out.`,
      { reason: "skip_deferrable_key" }
    );
  }
  const usable = indexes.filter(
    (index) =>
      !index.partial &&
      index.needs.length > 0 &&
      index.needs.every((column) => given.includes(column))
  );
  if (usable.length === 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `'skip' needs a unique constraint of the table '${table.name}' that holds for all rows, is not deferrable, and whose columns every row of the call gives. The table has none. Give the columns of such a key in every row, or leave onConflict out.`,
      { reason: "skip_without_key" }
    );
  }
  return usable;
}

/**
 * The statement that answers the number of the first row whose key is empty in every index
 * `skip` goes by, or nothing: such a row never conflicts and would be added again. The
 * database itself works each key out for each row, so an expression that comes to nothing
 * counts as empty. The keys are the catalog's text and the rows one bound value.
 */
function emptyKeyStatement(
  table: CatalogTable,
  given: readonly string[],
  indexes: readonly UniqueIndex[]
): string {
  // Names of this statement's own that no column of the table has: a key names its columns
  // without their table.
  const free = (name: string): string =>
    table.columns.some((column) => column.name === name) ? free(`${name}_`) : name;
  const [value, row] = [free("sent_value"), free("sent_row")].map(quoteIdentifier);
  const sent = table.columns
    .filter((column) => given.includes(column.name))
    .map((column) => `${quoteIdentifier(column.name)} ${column.nativeType}`)
    .join(", ");
  const computed = table.columns
    .flatMap((column) =>
      column.generation === undefined
        ? []
        : [`(${column.generation}) as ${quoteIdentifier(column.name)}`]
    )
    .join(", ");
  const bound = indexes
    .map((index) =>
      index.nulls_not_distinct
        ? "true"
        : index.keys.map((key) => `(${key}) is not null`).join(" and ")
    )
    .map((condition) => `(${condition})`)
    .join(" or ");
  return `
    select pg_catalog.min(sent.${row})::pg_catalog.int4 as row
    from pg_catalog.jsonb_array_elements($1::pg_catalog.jsonb)
      with ordinality as sent(${value}, ${row}),
      lateral pg_catalog.jsonb_to_record(sent.${value}) as given(${sent})
      ${computed === "" ? "" : `, lateral (select ${computed}) as computed`}
    where not (${bound})`;
}

const query: StoreVerb = {
  verb: "query",
  effect: "reading",
  inputSchema: queryInputSchema,
  outputSchema: rowsSchema,
  use: `Reads rows. Use it to answer from what is stored there. Send one read-only SELECT or WITH statement in PostgreSQL syntax. Put every value into "parameters" and refer to it as $1, $2 and so on; never write a value into the SQL. A parameter is the bare value, or { "type", "value" } where the database cannot tell its type. The tables are in the schema "public"; call describe to learn their columns. At most ${POSTGRES_RESULT_MAX_ROWS} rows and ${POSTGRES_RESULT_MAX_BYTES} bytes come back, and "truncated" says when there were more: narrow the statement or page with LIMIT and OFFSET. A statement that runs longer than ${POSTGRES_STATEMENT_TIMEOUT_MS / 1000} seconds is cancelled.`,
  async run({ runtime, target }, call) {
    const input = queryInputSchema.parse(call);
    return rowsOf(
      await runtime.server.executor.query({
        ...target,
        sql: input.sql,
        ...(input.parameters ? { parameters: input.parameters } : {})
      })
    );
  }
};

const insert: StoreVerb = {
  verb: "insert",
  effect: "changing",
  // An added row is removed again with a statement, and nothing outside is told of it.
  changeClass: "reversible",
  // A step of a Workflow Run adds rows with nobody there to confirm, and the call path refuses
  // a call that would have to wait for its own caller. So adding rows waits for nobody: the
  // right on the rows of this one store, which is granted to the principal by name, is what
  // lets it. A setting of the instance and a guardrail still tighten it.
  defaultPolicy: "allow",
  inputSchema: insertInputSchema,
  outputSchema: dataStoreInsertResultSchema,
  use: `Adds rows to one table. Use it to record new rows; it changes and removes nothing that is stored. Name the table and send each row as an object of column name to value. All rows of one call name the same columns, and a column that is left out takes its default. "onConflict" says what happens to a row that a unique constraint of the table refuses: "fail", the default, adds no row of the call; "skip" leaves that row out and adds the others, which makes sending the same rows again safe. One call adds at most ${DATA_STORE_INSERT_MAX_ROWS} rows and ${DATA_STORE_INSERT_MAX_BYTES} bytes.`,
  async run({ runtime, store, target }, call) {
    const input = insertInputSchema.parse(call);
    const { record } = store;
    const columns = sharedColumns(input.rows);
    const rows = JSON.stringify(input.rows);
    const bytes = Buffer.byteLength(rows);
    if (bytes > DATA_STORE_INSERT_MAX_BYTES) {
      throw new AppError(
        "VALIDATION_FAILED",
        `The rows have ${bytes} bytes. One insert carries at most ${DATA_STORE_INSERT_MAX_BYTES} bytes of rows (DATA_STORE_INSERT_MAX_BYTES); send them in several calls.`,
        { reason: "rows_too_large", cap: "DATA_STORE_INSERT_MAX_BYTES", actual: bytes }
      );
    }
    const [table] = await readTables(runtime.server.executor, target, input.table);
    if (!table) throw tableUnknown(input.table);
    // The names and types that go into the statement are the catalog's, never a caller's text.
    const typeOf = new Map(
      table.columns.flatMap((column) =>
        column.generated ? [] : [[column.name, column.nativeType] as const]
      )
    );
    const unknown = columns.find((column) => !typeOf.has(column));
    if (unknown !== undefined) {
      throw new AppError(
        "VALIDATION_FAILED",
        `The table '${table.name}' has no column '${unknown}' that an insert sets`,
        { reason: "column_unknown" }
      );
    }
    const keys =
      input.onConflict === "skip"
        ? skipKeys(
            table,
            columns,
            z.array(uniqueIndexRow).parse(
              (
                await runtime.server.executor.query({
                  ...catalogTarget(target),
                  sql: UNIQUE_INDEXES,
                  parameters: [table.name]
                })
              ).rows
            )
          )
        : [];
    const names = columns.map(quoteIdentifier).join(", ");
    // The rows are one bound value. Postgres reads each column of it by the column's type.
    const statement = `
      with inserted as (
        insert into public.${quoteIdentifier(table.name)} (${names})
        select ${names}
        from pg_catalog.jsonb_to_recordset($1::pg_catalog.jsonb)
          as rows(${columns.map((column) => `${quoteIdentifier(column)} ${typeOf.get(column)}`).join(", ")})
        ${input.onConflict === "skip" ? "on conflict do nothing" : ""}
        returning 1
      )
      select pg_catalog.count(*)::pg_catalog.int4 as count from inserted`;
    const full = (sizeBytes: number) => storeFull(record, sizeBytes);
    // The size is the server's own word for the files of the store, read on a connection of
    // the platform's own, which nothing the store runs can have touched. It is read before
    // the rows are written and again once they are: whoever calls and from whichever
    // process, a store at its limit takes no further row.
    const size = () => storeSizeBytes(runtime.server, record.location.database, target.signal);
    const before = await size();
    if (before >= record.sizeLimitBytes) throw full(before);
    // Everything of one insert is one transaction as the app role, and a refusal rolls it
    // back. Whatever a change throws leaves it as a failure of the database, so the refusal
    // is kept here and raised once the change has rolled back.
    let refusal: AppError | undefined;
    const refuse = (error: AppError): never => {
      refusal = error;
      throw error;
    };
    let wrote = false;
    let inserted: number;
    try {
      inserted = await runtime.server.executor.change(
        { ...target, timeoutMs: POSTGRES_STATEMENT_TIMEOUT_MS },
        async (sql) => {
          if (keys.length > 0) {
            const [empty] = await sql.run(emptyKeyStatement(table, columns, keys), [rows]);
            const row = z.object({ row: z.number().nullable() }).parse(empty).row;
            if (row !== null) {
              refuse(
                new AppError(
                  "VALIDATION_FAILED",
                  `Row ${row} would be added again by a repeated call: its key is empty in every unique constraint of the table '${table.name}' that the call gives the columns of. Set the key in every row, or make the constraint NULLS NOT DISTINCT.`,
                  { reason: "nullable_key", row }
                )
              );
            }
          }
          wrote = true;
          const [counted] = await sql.run(statement, [rows]);
          // What the store left to the end of the transaction, such as a deferred trigger,
          // happens now, before the size is read again: a default or a trigger may write far
          // more than the rows that were sent. An insert that took the store past its limit
          // is rolled back, so no row that is kept lies beyond it.
          await sql.script("set constraints all immediate");
          const after = await size();
          if (after > record.sizeLimitBytes) refuse(full(after));
          return insertedRow.parse(counted).count;
        }
      );
    } catch (error) {
      // Rows that were written and not kept still fill the files, which would keep the store
      // at its limit: the refusal for size and the statement that ran out of time give them back.
      const sizeRefusal = refusal !== undefined && refusal.code === "CONFLICT";
      const timedOut = error instanceof PostgresExecutorError && error.kind === "timeout";
      if (wrote && (sizeRefusal || timedOut)) await reclaim(runtime, record);
      throw refusal ?? error;
    }
    return {
      table: table.name,
      inserted,
      skipped: input.rows.length - inserted
    } satisfies DataStoreInsertResult;
  }
};

const describe: StoreVerb = {
  verb: "describe",
  effect: "reading",
  inputSchema: describeInputSchema,
  outputSchema: jsonObjectSchema,
  use: `Answers the tables with their columns, types, defaults and comments, and an estimate of the rows of each. Use it before a query or an insert to learn the names; it reads no row. "type" is the product's name of a type and "nativeType" the database's.`,
  async run({ runtime, store, target }, call) {
    describeInputSchema.parse(call);
    const tables = await readTables(runtime.server.executor, target);
    return {
      schemaLevel: store.record.level,
      tables: tables.map(({ columns, ...table }) => ({
        ...table,
        columns: columns.map(({ generated: _generated, ...column }) => column)
      }))
    } satisfies DataStoreSchema;
  }
};

const previewRows: StoreVerb = {
  verb: "preview_rows",
  effect: "reading",
  inputSchema: previewInputSchema,
  outputSchema: rowsSchema,
  use: `Answers the first rows of one table, at most ${DATA_STORE_PREVIEW_ROW_LIMIT}, in no promised order. Use it to see what rows of a table look like; use query for anything that selects or counts.`,
  async run({ runtime, target }, call) {
    const input = previewInputSchema.parse(call);
    const [table] = await readTables(runtime.server.executor, target, input.table);
    if (!table) throw tableUnknown(input.table);
    return rowsOf(
      await runtime.server.executor.query({
        ...target,
        limits: { ...target.limits, maxRows: input.limit },
        sql: `select * from public.${quoteIdentifier(table.name)}`
      })
    );
  }
};

const VERBS: readonly StoreVerb[] = [query, insert, load, describe, previewRows];

function publishedStore(
  asset: ConfigAssetRecord,
  record: DataStoreRecord | undefined
): PublishedStore | undefined {
  const definition = dataStoreDefinitionSchema.safeParse(asset.publishedConfig);
  if (
    asset.status !== "active" ||
    !definition.success ||
    record?.id !== asset.id ||
    record.status === "retired"
  ) {
    return undefined;
  }
  return {
    definition: definition.data,
    record,
    resource: {
      kind: DATA_STORE_ASSET_KIND,
      id: asset.id,
      assetId: asset.id,
      name: asset.name,
      ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
    }
  };
}

async function readStore(
  runtime: DataStoreRuntime,
  name: string
): Promise<PublishedStore | undefined> {
  const { clientInstanceId, stores } = runtime;
  const asset = await stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: DATA_STORE_ASSET_KIND,
    name
  });
  if (!asset) return undefined;
  return publishedStore(
    asset,
    await stores.dataStores.getDataStore({ clientInstanceId, id: asset.id })
  );
}

/**
 * The published stores of the instance, or those of the names: two reads, whatever their
 * number. `truncated` says that more stores exist than one listing reads.
 */
async function readStores(
  runtime: DataStoreRuntime,
  names?: readonly string[]
): Promise<{ stores: PublishedStore[]; truncated: boolean }> {
  const { clientInstanceId, stores } = runtime;
  const [assets, records] = await Promise.all([
    stores.configAssets.listPublishedConfigAssets({
      clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      ...(names ? { names } : {}),
      limit: DATA_STORE_LIST_MAX_STORES + 1
    }),
    stores.dataStores.listDataStores({ clientInstanceId, limit: DATA_STORE_LIST_MAX_STORES + 1 })
  ]);
  const recordOf = new Map(records.map((record) => [record.id, record]));
  return {
    stores: assets
      .slice(0, DATA_STORE_LIST_MAX_STORES)
      .flatMap((asset) => publishedStore(asset, recordOf.get(asset.id)) ?? []),
    truncated: Math.max(assets.length, records.length) > DATA_STORE_LIST_MAX_STORES
  };
}

function parseOperationName(name: string): { store: string; verb: StoreVerb } | undefined {
  if (!name.startsWith(DATA_STORE_OPERATION_PREFIX)) return undefined;
  const [store, verbName, ...rest] = name.slice(DATA_STORE_OPERATION_PREFIX.length).split(".");
  const verb = VERBS.find((candidate) => candidate.verb === verbName);
  return store && verb && rest.length === 0 ? { store, verb } : undefined;
}

/**
 * Runs one verb on one store as its app role. A store whose database is not there yet is
 * refused with what an author does next, and a failure of the database is answered as a
 * sentence and its SQLSTATE.
 */
async function runVerb(
  runtime: DataStoreRuntime,
  store: PublishedStore,
  verb: StoreVerb,
  input: unknown,
  signal: AbortSignal | undefined
): Promise<unknown> {
  const { record } = store;
  if (record.status !== "ready") {
    throw new AppError(
      "CONFLICT",
      record.failure
        ? `The Data Store '${record.name}' has no database: ${record.failure.message}`
        : `The Data Store '${record.name}' is being provisioned. Try again shortly.`,
      { reason: "data_store_not_ready" }
    );
  }
  try {
    // The app role as the platform gave it, before anything runs as that role.
    return await asStoreRole(runtime, record, signal, () =>
      verb.run(
        {
          runtime,
          store,
          target: { ...runtime.server.asRole(record, "app"), ...(signal ? { signal } : {}) }
        },
        input
      )
    );
  } catch (error) {
    throw error instanceof AppError
      ? error
      : databaseFailureError(error, `The ${verb.effect === "changing" ? verb.verb : "query"}`);
  }
}

/**
 * Who may call a verb: the one right the contract names for it, or, where a call needs more
 * by what it asks for, each of those rights on the store. A refusal names the right that lacks.
 */
function rightsOf(
  store: PublishedStore,
  verb: StoreVerb
): { action: string } | { action: null; authorize: NonNullable<OperationDefinition["authorize"]> } {
  const action = DATA_STORE_OPERATION_RIGHTS[verb.verb];
  const { furtherRights } = verb;
  if (!furtherRights) return { action };
  return {
    action: null,
    authorize(input, context) {
      for (const right of [action, ...furtherRights(input)]) {
        const decision = context.access.authorize(right, store.resource);
        if (!decision.allowed) return { allowed: false, action: right, reason: decision.reason };
      }
      return { allowed: true };
    }
  };
}

function operationOf(
  runtime: DataStoreRuntime,
  store: PublishedStore,
  verb: StoreVerb
): OperationDefinition {
  return {
    name: dataStoreOperationName(store.record.name, verb.verb),
    effect: verb.effect,
    // A read of a customer's rows is recorded, every time.
    ...(verb.effect === "reading" ? { recordsEveryCall: true as const } : {}),
    ...(verb.changeClass ? { changeClass: verb.changeClass } : {}),
    ...(verb.defaultPolicy ? { defaultPolicy: verb.defaultPolicy } : {}),
    ...rightsOf(store, verb),
    // What a key must carry to call the verb over HTTP. The grants of its holder still decide.
    scope: DATA_STORE_OPERATION_SCOPES[verb.verb],
    auth: "principal",
    inputSchema: verb.inputSchema,
    outputSchema: verb.outputSchema,
    resource: () => store.resource,
    module: DATA_STORES_MODULE,
    timeoutMs: verb.timeoutMs ?? RUN_TIMEOUT_MS,
    execute: (input, context) => runVerb(runtime, store, verb, input, context.runtime.signal)
  };
}

/**
 * The source of every store's operations. `resolve` reads the one store a name stands for,
 * `list` all of them in two reads. Neither opens a connection to a store.
 */
export function createDataStoreOperationSource(runtime: DataStoreRuntime): OperationSource {
  return {
    async resolve(name) {
      const parsed = parseOperationName(name);
      const store = parsed && (await readStore(runtime, parsed.store));
      return store ? operationOf(runtime, store, parsed.verb) : undefined;
    },
    async list(scope) {
      const { stores, truncated } = await readStores(runtime);
      return {
        operations: stores
          .filter(
            (store) =>
              store.record.status === "ready" &&
              (scope.workspaceId === undefined ||
                store.resource.workspaceId === undefined ||
                store.resource.workspaceId === scope.workspaceId)
          )
          // A verb no caller can use yet is resolved, so its call is refused, and not listed.
          .flatMap((store) =>
            VERBS.filter((verb) => verb.use !== undefined).map((verb) =>
              operationOf(runtime, store, verb)
            )
          ),
        truncated: truncated
          ? [
              {
                prefix: DATA_STORE_OPERATION_PREFIX,
                limit: DATA_STORE_LIST_MAX_STORES,
                limitName: "DATA_STORE_LIST_MAX_STORES"
              }
            ]
          : []
      };
    }
  };
}

/**
 * What an agent's tool list reads: of the names an agent lists, the operations of the stores
 * that have a database, each with the description and the input an agent needs to use it.
 */
export function createDataStoreToolSource(runtime: DataStoreRuntime): DataToolSource {
  return {
    async describe(toolNames) {
      const wanted = toolNames.flatMap((name) => parseOperationName(name) ?? []);
      if (wanted.length === 0) return [];
      const read = await readStores(runtime, [...new Set(wanted.map(({ store }) => store))]);
      const byName = new Map(read.stores.map((store) => [store.record.name, store]));
      return wanted.flatMap(({ store: name, verb }): DataToolDescriptor[] => {
        const store = byName.get(name);
        if (store?.record.status !== "ready" || verb.use === undefined) return [];
        const { title, description } = store.definition;
        return [
          {
            name: dataStoreOperationName(name, verb.verb),
            effect: verb.effect,
            description: `A tool of the Data Store '${title}'${description ? ` (${description})` : ""}. ${verb.use}`,
            inputJsonSchema: jsonObjectSchema.parse(
              z.toJSONSchema(verb.inputSchema, {
                target: "draft-07",
                io: "input",
                unrepresentable: "any"
              })
            )
          }
        ];
      });
    }
  };
}
