import type { KnowledgeBackend } from "@work-shape/catalyst-core";
import type { DataStoreRuntime } from "../runtime";
import { createDataStoreKnowledgeBackend } from "./backend";
import { createBuiltinKnowledgeBackend } from "./builtin/backend";
import type { KnowledgeEmbedding } from "./definition";

/**
 * The backend the kind `knowledge_base` is given: each call goes to the backend its target
 * names, a Data Store whose tables a Knowledge Base describes or the store a Knowledge Base
 * owns. Both work on the same server and pools as the stores' own reads.
 */
export function createKnowledgeBackend(
  runtime: DataStoreRuntime,
  embedding: KnowledgeEmbedding
): KnowledgeBackend {
  const dataStore = createDataStoreKnowledgeBackend(runtime);
  const builtin = createBuiltinKnowledgeBackend(runtime, embedding);
  return {
    publish(stores, input) {
      const { target } = input;
      return target.backend === "dataStore"
        ? dataStore.publish(stores, { ...input, target })
        : builtin.publish(stores, { ...input, target });
    },
    check: (target, signal) =>
      target.backend === "dataStore"
        ? dataStore.check(target, signal)
        : builtin.check(target, signal),
    grant: (stores, target, signal) =>
      target.backend === "dataStore"
        ? dataStore.grant(stores, target, signal)
        : builtin.grant(stores, target, signal),
    retire: (stores, target, signal) =>
      target.backend === "dataStore"
        ? dataStore.retire(stores, target, signal)
        : builtin.retire(stores, target, signal),
    query: (target, statement, signal) =>
      target.backend === "dataStore"
        ? dataStore.query(target, statement, signal)
        : builtin.query(target, statement, signal)
  };
}
