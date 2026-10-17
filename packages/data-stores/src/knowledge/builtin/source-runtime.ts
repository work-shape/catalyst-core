import {
  AppError,
  KNOWLEDGE_BASE_ASSET_KIND,
  type ConnectorContext,
  type DocumentSourceCapability,
  type KnowledgeFiles,
  type KnowledgeDocumentFormat,
  type KnowledgeSyncJobPayload
} from "@work-shape/catalyst-core";
import { requireSourceUse, type SourceAuthority } from "../source-principal";
import type { DataStoreRuntime } from "../../runtime";
import { knowledgeBaseDefinitionSchema } from "../definition";

// A deadline covers opening credentials and consuming the stream, not just its first byte.
const SOURCE_CALL_TIMEOUT_MS = 60_000;
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
export interface SourceJobRuntime {
  data: DataStoreRuntime;
  input: KnowledgeSourceJobsInput;
  authority?: SourceAuthority;
}
export async function sourceTarget(runtime: SourceJobRuntime, payload: KnowledgeSyncJobPayload) {
  const record = await runtime.data.stores.dataStores.getDataStore({
    clientInstanceId: runtime.data.clientInstanceId,
    id: payload.knowledgeBaseId
  });
  if (!record || record.status !== "ready" || !record.ownerKnowledgeBaseId) return undefined;
  const asset = await runtime.data.stores.configAssets.getConfigAsset({
    clientInstanceId: runtime.data.clientInstanceId,
    kind: KNOWLEDGE_BASE_ASSET_KIND,
    name: record.ownerKnowledgeBaseId
  });
  if (!asset || asset.id !== payload.knowledgeBaseId || asset.status !== "active") return undefined;
  const definition = knowledgeBaseDefinitionSchema.safeParse(asset.publishedConfig);
  if (!definition.success || "backend" in definition.data) return undefined;
  const source = definition.data.sources?.find((source) => source.id === payload.sourceId);
  return source && { source, name: asset.name };
}
export async function sourceCall<T>(
  runtime: SourceJobRuntime,
  connection: string,
  knowledgeBaseId: string,
  parent: AbortSignal,
  call: (opened: Awaited<ReturnType<KnowledgeSourceJobsInput["openSource"]>>) => Promise<T>
): Promise<T> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(SOURCE_CALL_TIMEOUT_MS)]);
  signal.throwIfAborted();
  // Race even a broken adapter against the deadline. Its context is aborted as well.
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () =>
      reject(new AppError("TIMEOUT", "The source call ended before it completed"));
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    const work = (async () => {
      const opened = await runtime.input.openSource(connection, signal);
      if (runtime.authority) await runtime.authority.require();
      else
        await requireSourceUse(
          runtime.data.stores,
          runtime.data.clientInstanceId,
          knowledgeBaseId,
          connection
        );
      signal.throwIfAborted();
      const result = await call(opened);
      signal.throwIfAborted();
      return result;
    })();
    return await Promise.race([work, aborted]);
  } finally {
    if (rejectAbort) signal.removeEventListener("abort", rejectAbort);
  }
}
