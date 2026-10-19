import { recordsPropose } from "./records/propose";
import { query, rowsSchema } from "./query";
import {
  AppError,
  auditActorFromIdentity,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_OPERATION_PREFIX,
  DATA_STORE_OPERATION_RIGHTS,
  DATA_STORE_OPERATION_SCOPES,
  DATA_STORE_PREVIEW_ROW_LIMIT,
  dataStoreOperationName,
  type ConfigAssetRecord,
  type DataStoreRecord,
  type PlatformStores,
  type DataStoreSchema,
  type DataToolDescriptor,
  type DataToolSource,
  type OperationDefinition,
  type OperationExecutionContext,
  type OperationSource
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { ensureCallRecords, keyedCall, readRecordedCall } from "./calls";
import { readTables, rowsOf } from "./catalog";
import { validateConstraintNames } from "./constraint-errors";
import { dataStoreDefinitionSchema } from "./definition";
import { databaseFailureError } from "./failures";
import { rowWriteDatabaseFailure } from "./row-write-failures";
import { DATA_STORE_ROLE_LIMITS } from "./role-limits";
import type { DataStoreRuntime } from "./runtime";
import { asStoreRole } from "./roles";
import { quoteIdentifier } from "./server";
import { rows, value } from "./rows";
import { DATA_STORE_STATE_VERB, stateOperation } from "./state";
import { DATA_STORE_USED_BY_PART, usedByOperation } from "./used-by";
import {
  AnsweredBefore,
  CommitOutcomeUnknown,
  tableUnknown,
  type PublishedStore,
  type StoreRead,
  type StoreVerb
} from "./verbs";
import { load } from "./load";
import { insert } from "./insert";
import { update, deleteRows } from "./row-mutations";
import { tableNameSchema } from "./row-write-input";

// The operations on the rows of one store. Each is called through `runOperation` like every
// other operation: this file says who may call it and what it does, as the app role of the
// store. The database decides what that role may do; nothing here stands in for that. Each
// has one name, `data_store.<id>.<verb>`, whoever calls it: a Workflow step, an agent, or the
// route of the HTTP API that names the store in its path.

/** The module the operations belong to. */
const DATA_STORES_MODULE = "dataStores";

/** How many stores one listing of operations reads. More than that is reported as truncated. */
const DATA_STORE_LIST_MAX_STORES = 1_000;
/**
 * How much longer than its statement a run may stay `running` before it counts as
 * interrupted, in milliseconds. It covers the wait for a connection and the reads around it.
 */
const DATA_STORE_RUN_GRACE_MS = 30_000;
export const RUN_TIMEOUT_MS =
  DATA_STORE_ROLE_LIMITS.app.statementTimeoutMs + DATA_STORE_RUN_GRACE_MS;

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

const VERBS: readonly StoreVerb[] = [
  query,
  insert,
  update,
  deleteRows,
  load,
  recordsPropose,
  describe,
  previewRows
];

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
      title: definition.data.title,
      id: asset.id,
      assetId: asset.id,
      name: asset.name,
      ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
    }
  };
}

/** One published store by its name: two reads, through the rows the caller hands in. */
export async function readStore(
  runtime: Pick<DataStoreRuntime, "clientInstanceId"> & {
    stores: {
      configAssets: Pick<PlatformStores["configAssets"], "getConfigAsset">;
      dataStores: Pick<PlatformStores["dataStores"], "getDataStore">;
    };
  },
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
 * number. `owned` are the records of the stores Knowledge Bases own, which have no asset and
 * no operation of their own. `truncated` says that more stores exist than one listing reads.
 */
export async function readStores(
  runtime: DataStoreRuntime,
  names?: readonly string[]
): Promise<{ stores: PublishedStore[]; owned: DataStoreRecord[]; truncated: boolean }> {
  const { clientInstanceId, stores } = runtime;
  const named = names?.length === 1 ? names[0] : undefined;
  const [assets, records] = await Promise.all([
    stores.configAssets.listPublishedConfigAssets({
      clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      ...(names ? { names } : {}),
      limit: DATA_STORE_LIST_MAX_STORES + 1
    }),
    // A subject offer asks about one store. Its availability must not depend on a listing cap.
    named !== undefined
      ? stores.dataStores
          .findDataStoreByName({ clientInstanceId, name: named })
          .then((record) => (record ? [record] : []))
      : stores.dataStores.listDataStores({
          clientInstanceId,
          limit: DATA_STORE_LIST_MAX_STORES + 1
        })
  ]);
  const recordOf = new Map(records.map((record) => [record.id, record]));
  return {
    stores: assets
      .slice(0, DATA_STORE_LIST_MAX_STORES)
      .flatMap((asset) => publishedStore(asset, recordOf.get(asset.id)) ?? []),
    owned: records
      .slice(0, DATA_STORE_LIST_MAX_STORES)
      .filter((record) => record.ownerKnowledgeBaseId !== undefined && record.status !== "retired"),
    truncated: Math.max(assets.length, records.length) > DATA_STORE_LIST_MAX_STORES
  };
}

/** The store and the last part of a name of the form `data_store.<id>.<part>`. */
function splitOperationName(name: string): { store: string; part: string } | undefined {
  if (!name.startsWith(DATA_STORE_OPERATION_PREFIX)) return undefined;
  const [store, ...parts] = name.slice(DATA_STORE_OPERATION_PREFIX.length).split(".");
  const part = parts.join(".");
  return store && part ? { store, part } : undefined;
}

function parseOperationName(name: string): { store: string; verb: StoreVerb } | undefined {
  const split = splitOperationName(name);
  const verb = split && VERBS.find((candidate) => candidate.verb === split.part);
  return verb ? { store: split.store, verb } : undefined;
}

/**
 * Runs one verb on one store as its app role. A store whose database is not there yet is
 * refused with what an author does next, and a failure of the database is answered as a
 * localized row refusal or, for author-written SQL, database diagnostics.
 */
async function runVerb(
  runtime: DataStoreRuntime,
  store: PublishedStore,
  verb: Pick<StoreVerb, "effect" | "run" | "outputSchema"> & { verb: string },
  input: unknown,
  context: OperationExecutionContext
): Promise<unknown> {
  const { record } = store;
  const { signal } = context.runtime;
  // A changing call that carried a key is recorded in the store with its rows.
  const keyed =
    verb.effect === "changing" && context.idempotencyKey !== undefined
      ? keyedCall(
          context.actor,
          context.idempotencyKey,
          `${DATA_STORE_OPERATION_PREFIX}${record.name}.${verb.verb}`,
          input
        )
      : undefined;
  try {
    if (record.status !== "ready") {
      throw new AppError(
        "CONFLICT",
        record.failure
          ? `The Data Store '${record.name}' has no database: ${record.failure.message}`
          : `The Data Store '${record.name}' is being provisioned. Try again shortly.`,
        { reason: "data_store_not_ready" }
      );
    }
    // Fixed proposal reads use the platform connection; the preinstalled frame performs
    // customer writes as the app role. Neither role repair nor call-record DDL runs here.
    if (verb.verb === "records.propose")
      return await verb.run(
        {
          runtime,
          store,
          target: {
            ...runtime.server.asPlatform(record.location.database),
            ...(signal ? { signal } : {})
          },
          context,
          ...(keyed ? { keyed } : {})
        },
        input
      );
    // The app role as the platform gave it, before anything runs as that role.
    const output = await asStoreRole(runtime, record, signal, async () => {
      const target = {
        ...runtime.server.asRole(record, "app", runtime.stores.connections),
        ...(signal ? { signal } : {})
      };
      if (keyed || verb.verb === "load") await ensureCallRecords(runtime, record, signal);
      if (verb.verb === "load" && runtime.datasets?.authorize)
        await runtime.datasets.authorize(input, context);
      if (keyed) {
        await ensureCallRecords(runtime, record, signal);
        // Asked before anything of the call is checked: what the first call was answered
        // stands, also where the store has since become full or its table has changed.
        const before = await readRecordedCall(runtime, target, keyed);
        if (before) return verb.outputSchema.parse(before);
      }
      return verb.run({ runtime, store, target, context, ...(keyed ? { keyed } : {}) }, input);
    });
    if (["insert", "update", "delete_rows"].includes(verb.verb)) {
      const result = jsonObjectSchema.parse(output);
      await context.audit
        .record({
          type: "data_store.rows_written",
          actor: auditActorFromIdentity(context.actor),
          status: "success",
          subject: record.id,
          correlationId: context.correlationId,
          metadata: { store: record.name, ...result, operationRunId: context.runId }
        })
        .catch(() => {
          // The rows committed already: an audit outage cannot be reported as a refused write.
          runtime.logger.error(
            { storeId: record.id },
            "A row write completed but its counts could not be audited"
          );
        });
    }
    return output;
  } catch (error) {
    // A call under the same key was kept while this one waited for it.
    if (error instanceof AnsweredBefore) return verb.outputSchema.parse(error.outcome);
    const unknown = error instanceof CommitOutcomeUnknown;
    const cause: unknown = unknown ? error.failure : error;
    const checked =
      cause instanceof AppError
        ? cause
        : await validateConstraintNames(
            runtime.server.executor,
            {
              ...runtime.server.asPlatform(record.location.database),
              ...(signal ? { signal } : {})
            },
            cause
          );
    const rowFailure = ["insert", "update", "delete_rows"].includes(verb.verb)
      ? await rowWriteDatabaseFailure(
          runtime.server.executor,
          {
            ...runtime.server.asRole(record, "app", runtime.stores.connections),
            ...(signal ? { signal } : {})
          },
          checked,
          input,
          verb.verb,
          context.runtime.locale ?? runtime.defaultLocale
        )
      : undefined;
    const failure =
      rowFailure ??
      (cause instanceof AppError
        ? cause
        : databaseFailureError(
            checked,
            `The ${verb.effect === "changing" ? verb.verb : "query"}`,
            context.runtime.locale
          ));
    // Everything a changing verb does to a store is one transaction. Whatever fails before
    // that transaction is being kept leaves nothing of the call, so the call path may run the
    // same call again under its key: a step that is tried again adds its rows once the cause
    // is gone. A failure while it was being kept may have left the rows, and is not run again,
    // unless the call carried a key: then the store itself answers a second call.
    throw verb.effect === "changing" && (!unknown || keyed !== undefined)
      ? new AppError(failure.code, failure.message, failure.details, {
          exposeMessage: failure.exposeMessage,
          changedNothing: true
        })
      : failure;
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
    ...(verb.batch ? { batch: true as const } : {}),
    ...(verb.streams ? { streams: true as const } : {}),
    // A read of a customer's rows is recorded, every time.
    ...(verb.effect === "reading" ? { recordsEveryCall: true as const } : {}),
    ...(verb.changeClass ? { changeClass: verb.changeClass } : {}),
    // The store records the key of a changing call with its rows and carries out one call per
    // key, so a call that was cut off is made again under its key.
    ...(verb.effect === "changing" ? { repeatsUnderKey: true as const } : {}),
    ...rightsOf(store, verb),
    // What a key must carry to call the verb over HTTP. The grants of its holder still decide.
    scope: DATA_STORE_OPERATION_SCOPES[verb.verb],
    auth: "principal",
    inputSchema: verb.inputSchema,
    outputSchema: verb.outputSchema,
    resource: () => store.resource,
    module: DATA_STORES_MODULE,
    timeoutMs:
      verb.verb === "query" && runtime.limits.queryTimeoutMs
        ? runtime.limits.queryTimeoutMs + DATA_STORE_RUN_GRACE_MS
        : (verb.verb === "load" || verb.verb === "records.propose") && runtime.limits.load
          ? runtime.limits.load.timeoutMs + DATA_STORE_RUN_GRACE_MS
          : (verb.timeoutMs ?? RUN_TIMEOUT_MS),
    execute: (input, context) => runVerb(runtime, store, verb, input, context)
  };
}

/** The reads of a store's page beside the contract's verbs. */
const READS: readonly StoreRead[] = [rows, value];

/** One read of a store's page: recorded like every read of a customer's rows. */
function readOperation(
  runtime: DataStoreRuntime,
  store: PublishedStore,
  read: StoreRead
): OperationDefinition {
  return {
    name: `${DATA_STORE_OPERATION_PREFIX}${store.record.name}.${read.part}`,
    effect: "reading",
    recordsEveryCall: true,
    action: DATA_STORE_ACTIONS.read,
    scope: "data_store_rows:read",
    auth: "principal",
    inputSchema: read.inputSchema,
    outputSchema: read.outputSchema,
    resource: () => store.resource,
    module: DATA_STORES_MODULE,
    timeoutMs: RUN_TIMEOUT_MS,
    execute: (input, context) =>
      runVerb(
        runtime,
        store,
        { verb: read.part, effect: "reading", run: read.run, outputSchema: read.outputSchema },
        input,
        context
      )
  };
}

/**
 * The source of every store's operations. `resolve` reads the one store a name stands for,
 * `list` all of them in two reads. Neither opens a connection to a store.
 */
export function createDataStoreOperationSource(runtime: DataStoreRuntime): OperationSource {
  return {
    async resolve(name, stores = runtime.stores) {
      const lookup = { clientInstanceId: runtime.clientInstanceId, stores };
      const split = splitOperationName(name);
      if (split?.part === DATA_STORE_STATE_VERB) {
        // The state of a store is answered from its record, whether its database is there or not.
        const store = await readStore(lookup, split.store);
        return store && stateOperation(store, DATA_STORES_MODULE);
      }
      if (split?.part === DATA_STORE_USED_BY_PART) {
        const store = await readStore(lookup, split.store);
        return store && usedByOperation(runtime, store, DATA_STORES_MODULE);
      }
      const read = split && READS.find((candidate) => candidate.part === split.part);
      if (read) {
        const store = await readStore(lookup, split.store);
        return store && readOperation(runtime, store, read);
      }
      const parsed = parseOperationName(name);
      const store = parsed && (await readStore(lookup, parsed.store));
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
            ...(verb.batch ? { batch: true as const } : {}),
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
