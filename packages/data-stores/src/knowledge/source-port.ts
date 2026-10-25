import type {
  KnowledgeFiles,
  KnowledgeSyncResult,
  KnowledgeSyncJobPayload,
  KnowledgeSourcesOutput,
  KnowledgeSourceItemsInput,
  KnowledgeSourceItemsOutput,
  KnowledgeLocateOutput,
  KnowledgeRetryInput,
  KnowledgeWorkflowSourcesOutput,
  ActorAccess,
  WorkflowDatasetReference
} from "@work-shape/catalyst-core";
export type KnowledgeListingMode = Exclude<KnowledgeSyncResult["mode"], "ingest">;

/** One call of `knowledge.<id>.ingest`: who called, and what it hands in (KBW-1). */
/** A Workflow by the revision that created it, after its last delete, and when that was. */
export interface KnowledgeWorkflowIncarnation {
  workflowId: string;
  revision: number;
  createdAt: string;
}

export interface KnowledgeIngestCall {
  knowledgeBaseId: string;
  /**
   * The calling Workflow, by the revision that created it: its source is
   * `workflow:<workflowId>@<revision>` (KBW-2c).
   */
  workflow: KnowledgeWorkflowIncarnation;
  workflowRunId: string;
  stepRunId: string;
  operationRunId: string;
  /** The items as handed in, each checked on its own by the pass; or the dataset that holds them. */
  items: { inline: readonly unknown[] } | { dataset: WorkflowDatasetReference };
  complete: boolean;
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
    input: {
      knowledgeBaseId: string;
      workflow: KnowledgeWorkflowIncarnation;
      itemIds: readonly string[];
    },
    signal: AbortSignal
  ): Promise<number>;
  /**
   * Lifts the hold on items of a Workflow-fed source a person removed by hand: by their ids,
   * or every held item. Answers how many; the next pass that names one takes it (KBW-2b).
   */
  release(
    id: string,
    input: { source: string; sourceItemIds?: readonly string[] },
    signal: AbortSignal
  ): Promise<number>;
  /**
   * The delete question of a Workflow: the Knowledge Bases its live sources feed, each with its
   * documents there; one the reader may not open is counted, never named (KBW-2c).
   */
  workflowSources(
    workflow: string,
    access: ActorAccess,
    signal: AbortSignal
  ): Promise<KnowledgeWorkflowSourcesOutput>;
  retry(
    id: string,
    input: KnowledgeRetryInput,
    payload: KnowledgeSyncJobPayload,
    signal: AbortSignal,
    files: KnowledgeFiles,
    reprocess?: boolean
  ): Promise<number>;
}
