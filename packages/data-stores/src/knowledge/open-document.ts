import {
  AppError,
  asManagedFileId,
  type KnowledgeFiles,
  type ConfigAssetRecord
} from "@work-shape/catalyst-core";
import { knowledgeBaseDefinitionSchema, knowledgeTargetOf } from "./definition";
import type { KnowledgeRuntime } from "./runtime";

// Use the accepted document format, never the caller-supplied MIME type, for a browser view.
const CONTENT_TYPES = {
  txt: "text/plain; charset=utf-8",
  markdown: "text/plain; charset=utf-8",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

/** Read only a live document of the authorized Knowledge Base, never an arbitrary file id. */
export async function openKnowledgeDocument(
  runtime: KnowledgeRuntime,
  files: KnowledgeFiles | undefined,
  asset: ConfigAssetRecord | undefined,
  documentId: string,
  signal?: AbortSignal
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
  const document = await runtime.backend
    .documentStore(target)
    ?.fieldExtraction?.document(documentId, signal);
  if (!document) throw unavailable();
  const file = await runtime.stores.files.getManagedFile({
    clientInstanceId: runtime.clientInstanceId,
    fileId: asManagedFileId(document.fileId)
  });
  if (
    file?.status !== "available" ||
    file.owner?.kind !== "knowledge_base" ||
    file.owner.id !== asset.id
  )
    throw unavailable();
  signal?.throwIfAborted();
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
