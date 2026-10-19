import { bindViewerScopes, scopedStatement } from "../scoped-tables";
import { z } from "zod";
import {
  AppError,
  DATA_STORE_ACTIONS,
  type DataStoreKnowledgeTarget,
  type KnowledgeBackend,
  type KnowledgeBackendStores,
  type KnowledgeCheckResult
} from "@work-shape/catalyst-core";
import { catalogTarget, rowsOf } from "../catalog";
import { databaseFailureError } from "../failures";
import { readStore } from "../operations";
import { PostgresExecutorError } from "@work-shape/catalyst-postgres-connector";
import { asStoreRole } from "../roles";
import type { DataStoreRuntime } from "../runtime";
import type { PublishedStore } from "../verbs";
import { dropReader, grantReader, revokeReader } from "./reader";

// The Data Store as the backend of a Knowledge Base. A Knowledge Base reads the store's rows
// as a role of its own, which may select from the tables it describes and nothing else
// (`reader.ts`), in a read-only transaction under the app role's statement timeout and the
// executor's row and byte caps. It creates no table and applies no migration there. Spec: Knowledge Base on top; the Knowledge Base
// that describes a Data Store's tables (build plan, readiness review slice 1).

/**
 * Which of the named relations of `public` the session's role may select from. Tables, views
 * and materialized views count: a Knowledge Base may describe a view a migration made.
 */
const READABLE_RELATIONS = `
  select c.relname::pg_catalog.text as name,
    pg_catalog.has_table_privilege(c.oid, 'select') as readable
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and c.relname = any ($1::pg_catalog.text[])
`;

const relationRow = z.object({ name: z.string(), readable: z.boolean() });

/**
 * The platform's rows a call reads: those of the transaction of a publish, a grant or a
 * retirement, which already holds a connection of the pool, or the pool's own outside of one.
 */
type Rows = Pick<KnowledgeBackendStores, "configAssets" | "connections" | "dataStores">;

/** The published store a Knowledge Base names, or nothing where none has that id. */
function storeOf(
  runtime: DataStoreRuntime,
  rows: Rows,
  dataStore: string
): Promise<PublishedStore | undefined> {
  return readStore({ clientInstanceId: runtime.clientInstanceId, stores: rows }, dataStore);
}

/**
 * The store whose database a Knowledge Base reads, or why it cannot read one now, as a
 * sentence that names no row value.
 */
async function reachableStore(
  runtime: DataStoreRuntime,
  rows: Rows,
  target: DataStoreKnowledgeTarget
): Promise<{ store: PublishedStore } | { problem: string }> {
  const name = target.dataStore;
  const store = await storeOf(runtime, rows, name);
  if (!store) {
    return {
      problem: `The Data Store '${name}' is not available: no published Data Store has that id. It may have been deleted.`
    };
  }
  return store.record.status === "ready"
    ? { store }
    : { problem: `The Data Store '${name}' has no database yet: it is being provisioned.` };
}

export function createDataStoreKnowledgeBackend(
  runtime: DataStoreRuntime
): KnowledgeBackend<DataStoreKnowledgeTarget> {
  /** The roles of a store held with the passwords read from `rows`. */
  const withRows = (rows: Rows) => ({ ...runtime, stores: rows });

  async function check(
    rows: Rows,
    target: DataStoreKnowledgeTarget,
    signal: AbortSignal | undefined
  ): Promise<KnowledgeCheckResult> {
    const reached = await reachableStore(runtime, rows, target);
    if ("problem" in reached) {
      return {
        status: "needs_attention",
        tables: target.tables.map(({ name }) => ({ name, readable: false })),
        problem: reached.problem
      };
    }
    const { record } = reached.store;
    const found = await asStoreRole(withRows(rows), record, signal, async () =>
      z.array(relationRow).parse(
        (
          await runtime.server.executor.query({
            ...catalogTarget(runtime.server.asRole(record, "app", rows.connections)),
            ...(signal ? { signal } : {}),
            sql: READABLE_RELATIONS,
            parameters: [{ type: "text[]", value: target.tables.map(({ name }) => name) }]
          })
        ).rows
      )
    );
    const tables = target.tables.map(({ name }) => ({
      name,
      readable: found.some((relation) => relation.name === name && relation.readable)
    }));
    return {
      status: tables.every((table) => table.readable) ? "ok" : "needs_attention",
      tables
    };
  }

  const backend: KnowledgeBackend<DataStoreKnowledgeTarget> = {
    // Every read goes through `stores`, the rows of the publish's transaction.
    async publish(stores, { target, replaced, access }) {
      const store = await storeOf(runtime, stores, target.dataStore);
      // The publisher hands the store's rows to whoever holds the Knowledge Base's `use`. A
      // store the publisher may not read is not named to them: the check refuses it as missing.
      if (store) {
        access.require(DATA_STORE_ACTIONS.read, store.resource);
        if (Object.keys(store.definition.tables ?? {}).length && !target.queries?.length)
          throw new AppError(
            "VALIDATION_FAILED",
            "A Knowledge Base on scoped tables requires named queries",
            { reason: "scoped_sql_refused" }
          );
      }
      const result = await check(stores, target, undefined);
      if (result.status !== "ok") {
        const missing = result.tables.filter((table) => !table.readable).map(({ name }) => name);
        throw new AppError(
          "VALIDATION_FAILED",
          result.problem ??
            `The Knowledge Base cannot read ${missing.length === 1 ? "the table" : "the tables"} ${missing.map((name) => `'${name}'`).join(", ")} of the Data Store '${target.dataStore}'. Describe tables the store has, or publish the store's migration that makes them.`,
          { reason: "knowledge_base_needs_attention", tables: missing },
          { exposeMessage: true }
        );
      }
      // Away from the store before first: at no step may it read in both.
      const before = replaced?.backend === "dataStore" ? replaced.dataStore : undefined;
      if (before !== undefined && before !== target.dataStore) {
        const old = await storeOf(runtime, stores, before);
        if (old?.record.status === "ready") {
          await revokeReader(withRows(stores), old.record, target.assetId, undefined);
        }
      }
      await backend.grant(stores, target);
      return result;
    },

    check(target, signal): Promise<KnowledgeCheckResult> {
      return check(runtime.stores, target, signal);
    },

    async grant(stores, target, signal) {
      const reached = await reachableStore(runtime, stores, target);
      if ("problem" in reached) throw unavailable(reached.problem);
      await grantReader(withRows(stores), stores.connections, reached.store.record, target, signal);
    },

    async retire(stores, target, signal) {
      const store = await storeOf(runtime, stores, target.dataStore);
      if (store?.record.status === "ready") {
        await revokeReader(withRows(stores), store.record, target.assetId, signal);
      }
      await dropReader(runtime, stores.connections, target.assetId, signal);
    },

    async query(target, statement, signal, viewer) {
      const reached = await reachableStore(runtime, runtime.stores, target);
      if ("problem" in reached) throw unavailable(reached.problem);
      const { record } = reached.store;
      if (Object.keys(reached.store.definition.tables ?? {}).length && !viewer?.namedQuery)
        throw new AppError(
          "VALIDATION_FAILED",
          "Free SQL on scoped tables is refused. Use a published named query.",
          { reason: "scoped_sql_refused" }
        );
      const named = viewer?.namedQuery
        ? bindViewerScopes(statement.sql, statement.parameters, viewer.access)
        : undefined;
      const bound = named
        ? scopedStatement(
            named.sql,
            reached.store.definition.tables,
            viewer?.access,
            named.parameters
          )
        : statement;
      const read = async () =>
        rowsOf(
          await runtime.server.executor.query({
            ...runtime.server.asReader(record, target.assetId, runtime.stores.connections),
            ...(signal ? { signal } : {}),
            sql: bound.sql,
            ...(bound.parameters ? { parameters: bound.parameters } : {})
          })
        );
      try {
        try {
          return await read();
        } catch (error) {
          // The role is missing or its password is not the one held, as for a Knowledge Base
          // published before it had a role of its own: it is given the published access again.
          if (!(error instanceof PostgresExecutorError) || error.kind !== "unauthorized") {
            throw error;
          }
          await grantReader(runtime, runtime.stores.connections, record, target, signal);
          return await read();
        }
      } catch (error) {
        throw error instanceof AppError ? error : databaseFailureError(error, "The query");
      }
    },

    addDocuments(target) {
      return Promise.reject(
        new AppError(
          "VALIDATION_FAILED",
          `Knowledge Base '${target.name}' describes tables of a Data Store and keeps no documents: files are added to a Knowledge Base without a backend.`,
          { reason: "method_not_offered" },
          { exposeMessage: true }
        )
      );
    },

    // A Knowledge Base on a Data Store keeps no documents, so no file is named.
    documentFileIds() {
      return Promise.resolve([]);
    },

    documentStore() {
      return undefined;
    }
  };
  return backend;
}

function unavailable(problem: string): AppError {
  return new AppError(
    "CONFLICT",
    problem,
    { reason: "knowledge_backend_unavailable" },
    { exposeMessage: true }
  );
}
