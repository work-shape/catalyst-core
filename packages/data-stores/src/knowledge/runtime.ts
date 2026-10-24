import type { KnowledgeSources } from "./source-port";
import type {
  ClientInstanceId,
  KnowledgeBackend,
  KnowledgeBaseState,
  KnowledgeCheckResult,
  KnowledgeDocumentFormat,
  KnowledgeFiles,
  KnowledgeQueryEmbedder,
  Logger,
  LocaleCode,
  PlatformStores
} from "@work-shape/catalyst-core";
import {
  knowledgeTargetOf,
  type KnowledgeBaseDefinition,
  type KnowledgeEmbedding
} from "./definition";

/** What everything that serves Knowledge Bases in one process is built on. */
export interface KnowledgeRuntime {
  /** Instance content locale until Knowledge Bases support a content-language setting. */
  defaultLocale: LocaleCode;
  clientInstanceId: ClientInstanceId;
  /** The platform's rows, outside of any transaction. */
  stores: PlatformStores;
  backend: KnowledgeBackend;
  sources?: KnowledgeSources;
  /** Where added files come from and their copies go. Absent where the process has none. */
  files?: KnowledgeFiles;
  /**
   * How the query of a search is embedded. Absent where the process has no model gateway: a
   * search there answers from full text and titles.
   */
  embedQuery?: KnowledgeQueryEmbedder;
  fieldExtractor?: import("@work-shape/catalyst-core").KnowledgeFieldExtractor;
  /** The embedding models release config approves, and the default. */
  embedding?: KnowledgeEmbedding;
  /** The formats a file added here may be in: text, and PDF and DOCX with document processing. */
  documentFormats: readonly KnowledgeDocumentFormat[];
  /** How many documents one Knowledge Base holds at most (`knowledge.maxDocuments`). */
  maxDocuments: number;
  maxPages?: number;
  logger: Logger;
  now(): Date;
}

/** What a check of one revision of a Knowledge Base found, kept or not. */
export type CheckedKnowledgeState = Omit<KnowledgeBaseState, "status"> &
  Pick<KnowledgeCheckResult, "status">;

/**
 * Keeps what a check of one revision of a Knowledge Base found, in `stores`. A check that finds
 * the store being made keeps nothing and drops what an earlier one kept: the state read looks
 * again until the store is ready.
 */
export async function keepKnowledgeCheck(
  runtime: KnowledgeRuntime,
  stores: Pick<PlatformStores, "knowledgeBases">,
  input: { assetId: string; revision: number },
  result: KnowledgeCheckResult
): Promise<CheckedKnowledgeState> {
  const checked: CheckedKnowledgeState = {
    ...result,
    assetId: input.assetId,
    clientInstanceId: runtime.clientInstanceId,
    revision: input.revision,
    checkedAt: runtime.now().toISOString()
  };
  const { status } = checked;
  if (status === "preparing") {
    await stores.knowledgeBases.deleteKnowledgeBaseState({
      clientInstanceId: runtime.clientInstanceId,
      assetId: input.assetId
    });
  } else {
    await stores.knowledgeBases.putKnowledgeBaseState({ ...checked, status });
  }
  return checked;
}

/** Checks one revision of a Knowledge Base against its backend and keeps what it found. */
export async function checkKnowledgeBase(
  runtime: KnowledgeRuntime,
  stores: Pick<PlatformStores, "knowledgeBases">,
  input: { assetId: string; revision: number; definition: KnowledgeBaseDefinition },
  signal?: AbortSignal
): Promise<CheckedKnowledgeState> {
  const result = await runtime.backend.check(
    knowledgeTargetOf(input.definition, input.assetId),
    signal
  );
  return keepKnowledgeCheck(runtime, stores, input, result);
}
