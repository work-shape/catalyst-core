import {
  AppError,
  type BuiltinKnowledgeTarget,
  type DataStoreRecord,
  type KnowledgeBackend,
  type KnowledgeBackendStores
} from "@work-shape/catalyst-core";
import { enqueueStoreDrop, enqueueStoreJob } from "../../jobs";
import type { DataStoreRuntime } from "../../runtime";
import { semanticSearchIssue, type KnowledgeEmbedding } from "../definition";
import { addKnowledgeDocuments, knowledgeDocumentFileIds } from "./documents";
import { ownedStoreCheck, ownedStoreName } from "./owned-store";

// The built-in backend: a Knowledge Base without a backend keeps its documents in a Data Store
// it owns. Publishing it makes the store through the provisioning of every store (DS-1), as a
// record and a job in the publish's transaction; the job makes the database and its roles,
// then pgvector where the Knowledge Base searches by meaning, then the platform's tables
// (`store-schema.ts`). Deleting the Knowledge Base drops the store with a job of its own.
//
// Sensitive data. The store holds a row per document added to the Knowledge Base, with its
// title and file name (`documents.ts`); the bytes stay in a Managed File the Knowledge Base
// owns. No text is sent to an embedding provider and nothing is searched yet. Dropping the
// store removes every row it holds; backups keep it until their rotation.

export function createBuiltinKnowledgeBackend(
  runtime: DataStoreRuntime,
  embedding: KnowledgeEmbedding
): KnowledgeBackend<BuiltinKnowledgeTarget> {
  const { clientInstanceId, server, limits } = runtime;

  /**
   * The record of the store the Knowledge Base owns, written where it is missing, and the job
   * that brings the store to the published revision queued, in `stores`' transaction. Throws
   * while the store of a deleted Knowledge Base of the same id is still being dropped: a
   * Knowledge Base brought back keeps its asset id, and its old store is not handed back.
   */
  async function ensureOwnedStore(
    stores: KnowledgeBackendStores,
    target: BuiltinKnowledgeTarget
  ): Promise<DataStoreRecord> {
    const name = ownedStoreName(target.name);
    const held = await stores.dataStores.findDataStoreByName({ clientInstanceId, name });
    const current = await stores.dataStores.getDataStore({
      clientInstanceId,
      id: target.assetId,
      lock: true
    });
    if ((held && held.id !== target.assetId) || current?.status === "retired") {
      throw new AppError(
        "CONFLICT",
        `The store of a deleted Knowledge Base with the id '${target.name}' is still being dropped. Publish again once it is gone.`,
        { reason: "knowledge_store_dropping" },
        { exposeMessage: true }
      );
    }
    if (current) {
      await enqueueStoreJob(stores, current);
      return current;
    }
    const now = new Date().toISOString();
    const names = server.namesOf(target.assetId);
    const record: DataStoreRecord = {
      id: target.assetId,
      clientInstanceId,
      name,
      status: "provisioning",
      location: { ...server.location, database: names.database },
      roles: { app: names.app, migration: names.migration },
      level: 0,
      migrations: [],
      // The store has no revision of its own: its tables are the release's.
      targetRevision: 0,
      sizeLimitBytes: limits.sizeLimitBytes,
      conditions: [],
      createdAt: now,
      updatedAt: now,
      ownerKnowledgeBaseId: target.name
    };
    await stores.dataStores.putDataStore(record);
    await enqueueStoreJob(stores, record);
    return record;
  }

  function refuseSemantic(target: BuiltinKnowledgeTarget): void {
    const issue = semanticSearchIssue(target, embedding);
    if (issue !== undefined) {
      throw new AppError(
        "VALIDATION_FAILED",
        issue,
        { reason: "semantic_search_unavailable" },
        { exposeMessage: true }
      );
    }
  }

  return {
    async publish(stores, { target }) {
      refuseSemantic(target);
      return ownedStoreCheck(await ensureOwnedStore(stores, target));
    },

    async check(target) {
      const issue = semanticSearchIssue(target, embedding);
      if (issue !== undefined) return { status: "needs_attention", tables: [], problem: issue };
      return ownedStoreCheck(
        await runtime.stores.dataStores.getDataStore({ clientInstanceId, id: target.assetId })
      );
    },

    async grant(stores, target) {
      refuseSemantic(target);
      await ensureOwnedStore(stores, target);
    },

    async retire(stores, target) {
      const record = await stores.dataStores.getDataStore({
        clientInstanceId,
        id: target.assetId,
        lock: true
      });
      if (!record || record.ownerKnowledgeBaseId === undefined) return;
      if (record.status !== "retired") {
        const now = new Date().toISOString();
        await stores.dataStores.putDataStore({
          ...record,
          status: "retired",
          retiredAt: now,
          updatedAt: now
        });
      }
      await enqueueStoreDrop(stores, record);
    },

    addDocuments(target, input, signal) {
      return addKnowledgeDocuments(runtime, target, input, signal);
    },

    documentFileIds(target, fileIds, signal) {
      return knowledgeDocumentFileIds(runtime, target, fileIds, signal);
    },

    query(target) {
      return Promise.reject(
        new AppError(
          "VALIDATION_FAILED",
          `Knowledge Base '${target.name}' keeps documents and answers no SQL: only a Knowledge Base on a Data Store answers the method 'structured'.`,
          { reason: "method_not_offered" },
          { exposeMessage: true }
        )
      );
    }
  };
}
