import {
  defineJobHandler,
  knowledgeSyncJob,
  knowledgeFetchJob,
  type ConnectorContext,
  type DocumentSourceCapability,
  type KnowledgeFiles,
  type KnowledgeDocumentFormat,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import type { DataStoreRuntime } from "../../runtime";

/** The source calls of the serving process, opened afresh for each outside request. */
export interface KnowledgeSourceJobsInput {
  files: KnowledgeFiles;
  documentFormats: readonly KnowledgeDocumentFormat[];
  maxDocuments: number;
  openSource(
    connection: string,
    signal: AbortSignal
  ): Promise<{ capability: DocumentSourceCapability; context: ConnectorContext }>;
}

export function createKnowledgeSourceJobs(
  _runtime: DataStoreRuntime,
  _input: KnowledgeSourceJobsInput
): RegisteredJobHandler[] {
  return [
    defineJobHandler({ kind: knowledgeSyncJob, slots: 1, async run() {} }),
    defineJobHandler({ kind: knowledgeFetchJob, slots: 4, async run() {} })
  ];
}
