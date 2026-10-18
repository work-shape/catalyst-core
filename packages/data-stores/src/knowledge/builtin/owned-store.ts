import type { DataStoreRecord, KnowledgeCheckResult } from "@work-shape/catalyst-core";
import { knowledgeStoreNeedsMigration } from "./store-schema";

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
  if (!record || record.status === "retired") {
    return {
      status: "needs_attention",
      tables: [],
      problem: "The Knowledge Base has no store for its documents yet: publishing it makes one."
    };
  }
  if (record.failure) {
    return { status: "needs_attention", tables: [], problem: record.failure.message };
  }
  // Being made is no fault: it takes no files yet, and says why to a caller who sends some.
  if (record.status === "provisioning" || knowledgeStoreNeedsMigration(record)) {
    return {
      status: "preparing",
      tables: [],
      problem: "The store for the Knowledge Base's documents is being made."
    };
  }
  return { status: "ok", tables: [] };
}
