import type {
  ClientInstanceId,
  KnowledgeBackend,
  KnowledgeBaseState,
  Logger,
  PlatformStores
} from "@vivd-catalyst/core";
import { knowledgeTargetOf, type KnowledgeBaseDefinition } from "./definition";

/** What everything that serves Knowledge Bases in one process is built on. */
export interface KnowledgeRuntime {
  clientInstanceId: ClientInstanceId;
  /** The platform's rows, outside of any transaction. */
  stores: PlatformStores;
  backend: KnowledgeBackend;
  logger: Logger;
  now(): Date;
}

/**
 * Checks one revision of a Knowledge Base against its backend and keeps what the check found
 * in `stores`, which a publish binds to its transaction.
 */
export async function checkKnowledgeBase(
  runtime: KnowledgeRuntime,
  stores: Pick<PlatformStores, "knowledgeBases">,
  input: { assetId: string; revision: number; definition: KnowledgeBaseDefinition },
  signal?: AbortSignal
): Promise<KnowledgeBaseState> {
  const result = await runtime.backend.check(knowledgeTargetOf(input.definition), signal);
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
