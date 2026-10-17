import type { DataStoreRecord, KnowledgeCheckResult } from "@work-shape/catalyst-core";
import { KNOWLEDGE_STORE_LEVEL } from "./store-schema";

// The store a Knowledge Base on the built-in backend owns: its name, and whether it can hold
// the Knowledge Base's documents now.

/**
 * The name of the store a Knowledge Base owns. A colon is in no id of a Data Store, so no store
 * of its own asset takes the name, and no operation `data_store.<id>.<verb>` reaches it.
 */
export function ownedStoreName(knowledgeBase: string): string {
  return `knowledge-base:${knowledgeBase}`;
}

/** What a check of the Knowledge Base says of the store it owns. It reads no row of the store. */
export function ownedStoreCheck(record: DataStoreRecord | undefined): KnowledgeCheckResult {
  const problem =
    !record || record.status === "retired"
      ? "The Knowledge Base has no store for its documents yet: publishing it makes one."
      : record.failure
        ? record.failure.message
        : record.status === "provisioning" || record.level < KNOWLEDGE_STORE_LEVEL
          ? "The store for the Knowledge Base's documents is being made."
          : undefined;
  return problem === undefined
    ? { status: "ok", tables: [] }
    : { status: "needs_attention", tables: [], problem };
}
