import type {
  KnowledgeFiles,
  KnowledgeSyncResult,
  KnowledgeSyncJobPayload,
  KnowledgeSourcesOutput,
  KnowledgeSourceItemsInput,
  KnowledgeSourceItemsOutput,
  KnowledgeLocateOutput,
  KnowledgeRetryInput
} from "@work-shape/catalyst-core";
export type KnowledgeListingMode = KnowledgeSyncResult["mode"];

/** The source engine port used by operations, on the owned database's pools. */
export interface KnowledgeSources {
  start(
    payload: KnowledgeSyncJobPayload,
    mode: KnowledgeListingMode,
    signal: AbortSignal
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
  retry(
    id: string,
    input: KnowledgeRetryInput,
    payload: KnowledgeSyncJobPayload,
    signal: AbortSignal,
    files: KnowledgeFiles
  ): Promise<number>;
}
