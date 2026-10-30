import {
  AppError,
  asManagedFileId,
  type KnowledgeFiles,
  type ConfigAssetRecord
} from "@work-shape/catalyst-core";
import { knowledgeBaseDefinitionSchema, knowledgeTargetOf } from "./definition";
import { openCachedPage, type KnowledgePageReader } from "./page-cache";
import type { KnowledgeRuntime } from "./runtime";

// Use the accepted document format, never the caller-supplied MIME type, for a browser view.
const CONTENT_TYPES = {
  txt: "text/plain; charset=utf-8",
  markdown: "text/plain; charset=utf-8",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

/**
 * Read only a live document of the authorized Knowledge Base, never an arbitrary file id. A
 * document added by hand, or a synced one still waiting for extraction, is read from its copy.
 * A synced one whose original was released after extraction is read from the page cache, or
 * fetched through its source into it (KB-13b).
 */
export async function openKnowledgeDocument(
  runtime: KnowledgeRuntime,
  files: KnowledgeFiles | undefined,
  asset: ConfigAssetRecord | undefined,
  documentId: string,
  signal?: AbortSignal,
  reader?: KnowledgePageReader
) {
  const definition = knowledgeBaseDefinitionSchema.safeParse(asset?.publishedConfig);
  if (
    !files ||
    !asset ||
    asset.status !== "active" ||
    !asset.publishedRevision ||
    !definition.success
  )
    throw unavailable();
  const target = knowledgeTargetOf(definition.data, asset.id);
  const store = runtime.backend.documentStore(target);
  const document = await store?.fieldExtraction?.document(documentId, signal);
  if (!store || !document) throw unavailable();
  const file = await runtime.stores.files.getManagedFile({
    clientInstanceId: runtime.clientInstanceId,
    fileId: asManagedFileId(document.fileId)
  });
  if (file?.owner?.kind !== "knowledge_base" || file.owner.id !== asset.id) throw unavailable();
  signal?.throwIfAborted();
  if (file.status === "released") {
    const body = await openCachedPage(
      runtime,
      files,
      {
        knowledgeBaseId: asset.id,
        knowledgeBase: asset.name,
        definition: definition.data,
        store,
        documentId,
        ...(reader ? { reader } : {})
      },
      signal
    );
    return {
      inline: true,
      filename: file.filename,
      contentType: CONTENT_TYPES[document.format],
      body
    };
  }
  if (file.status !== "available") throw unavailable();
  const object = await files.objects.get(file.objectKey);
  return {
    inline: true,
    filename: file.filename,
    contentType: CONTENT_TYPES[document.format],
    body: object.body
  };
}

function unavailable(): AppError {
  return new AppError("NOT_FOUND", "The source document is no longer available.", undefined, {
    exposeMessage: true
  });
}
