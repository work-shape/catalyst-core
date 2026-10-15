import { z } from "zod";
import {
  AppError,
  DATA_STORE_ACTIONS,
  type KnowledgeBackend,
  type KnowledgeBaseTarget,
  type KnowledgeCheckResult
} from "@work-shape/catalyst-core";
import { catalogTarget, rowsOf } from "../catalog";
import { databaseFailureError } from "../failures";
import { readStores } from "../operations";
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

/** The published store a Knowledge Base names, or nothing where none has that id. */
async function storeOf(
  runtime: DataStoreRuntime,
  target: KnowledgeBaseTarget
): Promise<PublishedStore | undefined> {
  const { stores } = await readStores(runtime, [target.backend.dataStore]);
  return stores.find((store) => store.record.name === target.backend.dataStore);
}

/**
 * The store whose database a Knowledge Base reads, or why it cannot read one now, as a
 * sentence that names no row value.
 */
async function reachableStore(
  runtime: DataStoreRuntime,
  target: KnowledgeBaseTarget
): Promise<{ store: PublishedStore } | { problem: string }> {
  const name = target.backend.dataStore;
  const store = await storeOf(runtime, target);
  if (!store) {
    return {
      problem: `The Data Store '${name}' is not available: no published Data Store has that id. It may have been deleted.`
    };
  }
  return store.record.status === "ready"
    ? { store }
    : { problem: `The Data Store '${name}' has no database yet: it is being provisioned.` };
}

export function createDataStoreKnowledgeBackend(runtime: DataStoreRuntime): KnowledgeBackend {
  return {
    async requirePublishRight(target, access) {
      const store = await storeOf(runtime, target);
      // A store the caller may not read is not named to it: the check refuses it as missing.
      if (store) access.require(DATA_STORE_ACTIONS.read, store.resource);
    },

    async check(target, signal): Promise<KnowledgeCheckResult> {
      const reached = await reachableStore(runtime, target);
      if ("problem" in reached) {
        return {
          status: "needs_attention",
          tables: target.tables.map(({ name }) => ({ name, readable: false })),
          problem: reached.problem
        };
      }
      const { record } = reached.store;
      const found = await asStoreRole(runtime, record, signal, async () =>
        z.array(relationRow).parse(
          (
            await runtime.server.executor.query({
              ...catalogTarget(runtime.server.asRole(record, "app")),
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
    },

    async grant(stores, target, replaced, signal) {
      const reached = await reachableStore(runtime, target);
      if ("problem" in reached) throw unavailable(reached.problem);
      // Away from the store before first: at no step may it read in both.
      const before = replaced?.backend.dataStore;
      if (before !== undefined && before !== target.backend.dataStore) {
        const old = await storeOf(runtime, { ...target, backend: { dataStore: before } });
        if (old?.record.status === "ready") {
          await revokeReader(runtime, old.record, target.assetId, signal);
        }
      }
      await grantReader(runtime, stores.connections, reached.store.record, target, signal);
    },

    async retire(stores, target, signal) {
      const store = await storeOf(runtime, target);
      if (store?.record.status === "ready") {
        await revokeReader(runtime, store.record, target.assetId, signal);
      }
      await dropReader(runtime, stores.connections, target.assetId, signal);
    },

    async query(target, statement, signal) {
      const reached = await reachableStore(runtime, target);
      if ("problem" in reached) throw unavailable(reached.problem);
      const { record } = reached.store;
      const read = async () =>
        rowsOf(
          await runtime.server.executor.query({
            ...runtime.server.asReader(record, target.assetId),
            ...(signal ? { signal } : {}),
            sql: statement.sql,
            ...(statement.parameters ? { parameters: statement.parameters } : {})
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
    }
  };
}

function unavailable(problem: string): AppError {
  return new AppError(
    "CONFLICT",
    problem,
    { reason: "knowledge_backend_unavailable" },
    { exposeMessage: true }
  );
}
