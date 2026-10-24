import type {
  KnowledgeFiles,
  KnowledgeSyncResult,
  KnowledgeSyncJobPayload,
  KnowledgeSourcesOutput,
  KnowledgeSourceItemsInput,
  KnowledgeSourceItemsOutput,
  KnowledgeLocateOutput,
  KnowledgeRetryInput,
  WorkflowDatasetReference
} from "@work-shape/catalyst-core";
export type KnowledgeListingMode = Exclude<KnowledgeSyncResult["mode"], "ingest">;

/** One call of `knowledge.<id>.ingest`: who called, and what it hands in (KBW-1). */
export interface KnowledgeIngestCall {
  knowledgeBaseId: string;
  /** The calling Workflow; its source is `workflow:<workflowId>`. */
  workflowId: string;
  workflowRunId: string;
  stepRunId: string;
  operationRunId: string;
  /** The items as handed in, each checked on its own by the pass; or the dataset that holds them. */
  items: { inline: readonly unknown[] } | { dataset: WorkflowDatasetReference };
  complete: boolean;
  /** The Connections the caller may use, for a `fetch` item's check. */
  connections: readonly string[];
}

/** The source engine port used by operations, on the owned database's pools. */
export interface KnowledgeSources {
  start(
    payload: KnowledgeSyncJobPayload,
    mode: KnowledgeListingMode,
    signal: AbortSignal,
    supersedePending?: boolean
  ): Promise<string>;
  sources(
    id: string,
    sources: readonly { id: string; connection: string }[],
    signal: AbortSignal
  ): Promise<KnowledgeSourcesOutput>;
  items(
    id: string,
    input: KnowledgeSourceItemsInput,
    signal: AbortSignal
  ): Promise<KnowledgeSourceItemsOutput>;
  locate(id: string, itemId: string, signal: AbortSignal): Promise<KnowledgeLocateOutput>;
  syncedDocumentIds(id: string, ids: string[], signal: AbortSignal): Promise<string[]>;
  /** Records the pass and queues it; its Operation Run ends when every item has ended. */
  ingest(call: KnowledgeIngestCall, signal: AbortSignal): Promise<void>;
  /** Withdraws items of a Workflow-fed source by their ids at the Workflow; answers how many. */
  withdraw(
    input: { knowledgeBaseId: string; workflowId: string; itemIds: readonly string[] },
    signal: AbortSignal
  ): Promise<number>;
  retry(
    id: string,
    input: KnowledgeRetryInput,
    payload: KnowledgeSyncJobPayload,
    signal: AbortSignal,
    files: KnowledgeFiles,
    reprocess?: boolean
  ): Promise<number>;
}
