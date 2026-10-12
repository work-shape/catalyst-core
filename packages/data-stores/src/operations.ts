import {
  POSTGRES_PARAMETERS_MAX_COUNT,
  POSTGRES_QUERY_TEXT_MAX_CHARS,
  POSTGRES_RESULT_MAX_BYTES,
  POSTGRES_RESULT_MAX_ROWS,
  POSTGRES_STATEMENT_TIMEOUT_MS
} from "@vivd-catalyst/postgres-connector";
import {
  AppError,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_OPERATION_PREFIX,
  DATA_STORE_OPERATION_VERBS,
  dataStoreOperationName,
  type ConfigAssetRecord,
  type DataStoreOperationVerb,
  type DataStoreRecord,
  type DataStoreRows,
  type DataToolDescriptor,
  type DataToolSource,
  type JsonObject,
  type OperationDefinition,
  type OperationResource,
  type OperationSource
} from "@vivd-catalyst/core";
import { z } from "zod";
import { dataStoreDefinitionSchema, type DataStoreDefinition } from "./definition";
import { databaseFailureError } from "./failures";
import { DATA_STORE_ROLE_LIMITS } from "./provisioning";
import { DATA_STORE_ACTIONS } from "./rights";
import type { DataStoreRuntime } from "./runtime";
import { quoteIdentifier } from "./server";

// The two operations on the rows of one store. Each is called through `runOperation` like
// every other operation: this file says who may call it and what it does, as the app role of
// the store. The database decides what that role may do; nothing here stands in for that.

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

const queryInputSchema = z.strictObject({
  sql: z.string().min(1).max(POSTGRES_QUERY_TEXT_MAX_CHARS),
  parameters: z
    .array(z.union([scalarSchema, z.array(scalarSchema)]))
    .max(POSTGRES_PARAMETERS_MAX_COUNT)
    .optional()
});

const queryOutputSchema = z.object({
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
  rows: z.array(z.record(z.string(), z.json())),
  truncated: z.boolean()
});

const insertInputSchema = z.strictObject({
  table: z.string().min(1).max(DATA_STORE_IDENTIFIER_MAX_CHARS),
  rows: z
    .array(z.record(z.string().min(1).max(DATA_STORE_IDENTIFIER_MAX_CHARS), z.json()))
    .min(1)
    .max(DATA_STORE_INSERT_MAX_ROWS)
});

const insertOutputSchema = z.object({ table: z.string(), insertedCount: z.number().int() });

type InsertInput = z.infer<typeof insertInputSchema>;

const jsonObjectSchema = z.record(z.string(), z.json());

/** A store as its operations read it: the published definition and the record of its database. */
interface PublishedStore {
  definition: DataStoreDefinition;
  record: DataStoreRecord;
  resource: OperationResource;
}

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

/** Every published store of the instance. Two reads, whatever their number. */
async function readStores(
  runtime: DataStoreRuntime
): Promise<{ stores: PublishedStore[]; truncated: boolean }> {
  const { clientInstanceId, stores } = runtime;
  const [assets, records] = await Promise.all([
    stores.configAssets.listActiveConfigAssets({ clientInstanceId, kind: DATA_STORE_ASSET_KIND }),
    stores.dataStores.listDataStores({ clientInstanceId, limit: DATA_STORE_LIST_MAX_STORES + 1 })
  ]);
  const recordOf = new Map(
    records.slice(0, DATA_STORE_LIST_MAX_STORES).map((record) => [record.id, record])
  );
  return {
    stores: assets.flatMap((asset) => publishedStore(asset, recordOf.get(asset.id)) ?? []),
    truncated: records.length > DATA_STORE_LIST_MAX_STORES
  };
}

function parseOperationName(
  name: string
): { store: string; verb: DataStoreOperationVerb } | undefined {
  if (!name.startsWith(DATA_STORE_OPERATION_PREFIX)) return undefined;
  const [store, verb, ...rest] = name.slice(DATA_STORE_OPERATION_PREFIX.length).split(".");
  const known = DATA_STORE_OPERATION_VERBS.find((candidate) => candidate === verb);
  return store && known && rest.length === 0 ? { store, verb: known } : undefined;
}

/** Refuses a call of a store whose database is not there yet, with what an author does next. */
function requireReady(store: PublishedStore): void {
  if (store.record.status === "ready") return;
  throw new AppError(
    "CONFLICT",
    store.record.failure
      ? `The Data Store '${store.record.name}' has no database: ${store.record.failure.message}`
      : `The Data Store '${store.record.name}' is being provisioned. Try again shortly.`,
    { reason: "data_store_not_ready" }
  );
}

function queryOperation(runtime: DataStoreRuntime, store: PublishedStore): OperationDefinition {
  const { server } = runtime;
  return {
    name: dataStoreOperationName(store.record.name, "query"),
    effect: "reading",
    // A read of a customer's rows is recorded, every time.
    recordsEveryCall: true,
    action: DATA_STORE_ACTIONS.read,
    scope: null,
    auth: "principal",
    inputSchema: queryInputSchema,
    outputSchema: queryOutputSchema,
    resource: () => store.resource,
    module: DATA_STORES_MODULE,
    timeoutMs: RUN_TIMEOUT_MS,
    async execute(call, context): Promise<DataStoreRows> {
      const input = queryInputSchema.parse(call);
      requireReady(store);
      try {
        const { columns, rows, truncated } = await server.executor.query({
          ...server.asRole(store.record, "app"),
          ...(context.runtime.signal ? { signal: context.runtime.signal } : {}),
          sql: input.sql,
          ...(input.parameters ? { parameters: input.parameters } : {})
        });
        return { columns, rows, truncated };
      } catch (error) {
        throw databaseFailureError(error, "The query");
      }
    }
  };
}

/**
 * The columns of one table of a store that an insert may name, as the app role reads them
 * from the catalog. The names and types that go into the statement are these, never a
 * caller's text.
 */
const TABLE_COLUMNS = `
  select c.relname as table_name, a.attname as column_name,
    pg_catalog.format_type(a.atttypid, a.atttypmod) as column_type
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid = c.oid
  where n.nspname = 'public' and c.relname = $1 and c.relkind in ('r', 'p')
    and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
  order by a.attnum
`;

const columnRow = z.object({
  table_name: z.string(),
  column_name: z.string(),
  column_type: z.string()
});

const insertedRow = z.object({ count: z.number().int() });

/** The columns the rows of one insert name: those of its first row, which every row shares. */
function sharedColumns(rows: InsertInput["rows"]): string[] {
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

function insertOperation(runtime: DataStoreRuntime, store: PublishedStore): OperationDefinition {
  const { server } = runtime;
  const { record } = store;
  return {
    name: dataStoreOperationName(record.name, "insert"),
    effect: "changing",
    // An added row is removed again with a statement, and nothing outside is told of it.
    changeClass: "reversible",
    action: DATA_STORE_ACTIONS.write,
    scope: null,
    auth: "principal",
    inputSchema: insertInputSchema,
    outputSchema: insertOutputSchema,
    resource: () => store.resource,
    module: DATA_STORES_MODULE,
    timeoutMs: RUN_TIMEOUT_MS,
    async execute(call, context): Promise<z.infer<typeof insertOutputSchema>> {
      const input = insertInputSchema.parse(call);
      requireReady(store);
      if (record.sizeBytes !== undefined && record.sizeBytes >= record.sizeLimitBytes) {
        throw new AppError(
          "CONFLICT",
          `The Data Store '${record.name}' holds ${record.sizeBytes} bytes and its size limit is ${record.sizeLimitBytes} bytes (sizeLimit). No rows are added until it is smaller or the limit is raised; reading keeps working.`,
          {
            reason: "data_store_size_limit",
            limit: record.sizeLimitBytes,
            actual: record.sizeBytes
          }
        );
      }
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
      const target = {
        ...server.asRole(record, "app"),
        ...(context.runtime.signal ? { signal: context.runtime.signal } : {})
      };
      try {
        const table = z.array(columnRow).parse(
          (
            await server.executor.query({
              ...target,
              sql: TABLE_COLUMNS,
              parameters: [input.table]
            })
          ).rows
        );
        const [first] = table;
        if (!first) {
          throw new AppError("VALIDATION_FAILED", `The store has no table '${input.table}'`, {
            reason: "table_unknown"
          });
        }
        const typeOf = new Map(table.map((column) => [column.column_name, column.column_type]));
        const unknown = columns.find((column) => !typeOf.has(column));
        if (unknown !== undefined) {
          throw new AppError(
            "VALIDATION_FAILED",
            `The table '${first.table_name}' has no column '${unknown}' that an insert sets`,
            { reason: "column_unknown" }
          );
        }
        const names = columns.map(quoteIdentifier).join(", ");
        // The rows are one bound value. Postgres reads each column of it by the column's type.
        const statement = `
          with inserted as (
            insert into public.${quoteIdentifier(first.table_name)} (${names})
            select ${names}
            from pg_catalog.jsonb_to_recordset($1::jsonb)
              as rows(${columns.map((column) => `${quoteIdentifier(column)} ${typeOf.get(column)}`).join(", ")})
            returning 1
          )
          select count(*)::integer as count from inserted`;
        const [counted] = await server.executor.change(
          { ...target, timeoutMs: POSTGRES_STATEMENT_TIMEOUT_MS },
          (sql) => sql.run(statement, [rows])
        );
        return { table: first.table_name, insertedCount: insertedRow.parse(counted).count };
      } catch (error) {
        throw error instanceof AppError ? error : databaseFailureError(error, "The insert");
      }
    }
  };
}

function operationsOf(runtime: DataStoreRuntime, store: PublishedStore): OperationDefinition[] {
  return [queryOperation(runtime, store), insertOperation(runtime, store)];
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
      return store && operationsOf(runtime, store).find((operation) => operation.name === name);
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
          .flatMap((store) => operationsOf(runtime, store)),
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

function describeTool(store: PublishedStore, verb: DataStoreOperationVerb): DataToolDescriptor {
  const { definition, record } = store;
  const about = `the Data Store '${definition.title}'${definition.description ? ` (${definition.description})` : ""}`;
  const inputJsonSchema = (schema: z.ZodType): JsonObject =>
    jsonObjectSchema.parse(
      z.toJSONSchema(schema, { target: "draft-07", io: "input", unrepresentable: "any" })
    );
  return verb === "query"
    ? {
        name: dataStoreOperationName(record.name, "query"),
        effect: "reading",
        inputJsonSchema: inputJsonSchema(queryInputSchema),
        description: `Reads rows of ${about}. Use it to answer from what is stored there. Send one read-only SELECT or WITH statement in PostgreSQL syntax. Put every value into "parameters" and refer to it as $1, $2 and so on; never write a value into the SQL. The tables are in the schema "public"; read information_schema.columns to learn their columns. At most ${POSTGRES_RESULT_MAX_ROWS} rows and ${POSTGRES_RESULT_MAX_BYTES} bytes come back, and "truncated" says when there were more: narrow the statement or page with LIMIT and OFFSET. A statement that runs longer than ${POSTGRES_STATEMENT_TIMEOUT_MS / 1000} seconds is cancelled.`
      }
    : {
        name: dataStoreOperationName(record.name, "insert"),
        effect: "changing",
        inputJsonSchema: inputJsonSchema(insertInputSchema),
        description: `Adds rows to one table of ${about}. Use it to record new rows; it changes and removes nothing that is stored. Name the table and send each row as an object of column name to value. All rows of one call name the same columns, and a column that is left out takes its default. One call adds at most ${DATA_STORE_INSERT_MAX_ROWS} rows and ${DATA_STORE_INSERT_MAX_BYTES} bytes; either every row of a call is added or none.`
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
      const byName = new Map(
        (await readStores(runtime)).stores.map((store) => [store.record.name, store])
      );
      return wanted.flatMap(({ store: name, verb }) => {
        const store = byName.get(name);
        return store?.record.status === "ready" ? [describeTool(store, verb)] : [];
      });
    }
  };
}
