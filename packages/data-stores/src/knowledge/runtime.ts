import type {
  ClientInstanceId,
  KnowledgeBackend,
  KnowledgeBaseState,
  KnowledgeCheckResult,
  KnowledgeDocumentFormat,
  KnowledgeFiles,
  Logger,
  PlatformStores
} from "@work-shape/catalyst-core";
import { knowledgeTargetOf, type KnowledgeBaseDefinition } from "./definition";

/** What everything that serves Knowledge Bases in one process is built on. */
export interface KnowledgeRuntime {
  clientInstanceId: ClientInstanceId;
  /** The platform's rows, outside of any transaction. */
  stores: PlatformStores;
  backend: KnowledgeBackend;
  /** Where added files come from and their copies go. Absent where the process has none. */
  files?: KnowledgeFiles;
  /** The formats a file added here may be in: text, and PDF and DOCX with document processing. */
  documentFormats: readonly KnowledgeDocumentFormat[];
  /** How many documents one Knowledge Base holds at most (`knowledge.maxDocuments`). */
  maxDocuments: number;
  logger: Logger;
  now(): Date;
}

/** Keeps what a check of one revision of a Knowledge Base found, in `stores`. */
export async function keepKnowledgeCheck(
  runtime: KnowledgeRuntime,
  stores: Pick<PlatformStores, "knowledgeBases">,
  input: { assetId: string; revision: number },
  result: KnowledgeCheckResult
): Promise<KnowledgeBaseState> {
  const state: KnowledgeBaseState = {
    ...result,
    assetId: input.assetId,
    clientInstanceId: runtime.clientInstanceId,
    revision: input.revision,
    checkedAt: runtime.now().toISOString()
  };
  await stores.knowledgeBases.putKnowledgeBaseState(state);
  return state;
}

/** Checks one revision of a Knowledge Base against its backend and keeps what it found. */
export async function checkKnowledgeBase(
  runtime: KnowledgeRuntime,
  stores: Pick<PlatformStores, "knowledgeBases">,
  input: { assetId: string; revision: number; definition: KnowledgeBaseDefinition },
  signal?: AbortSignal
): Promise<KnowledgeBaseState> {
  const result = await runtime.backend.check(
    knowledgeTargetOf(input.definition, input.assetId),
    signal
  );
  return keepKnowledgeCheck(runtime, stores, input, result);
}
