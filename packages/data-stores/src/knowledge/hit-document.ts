import {
  AppError,
  asManagedFileId,
  type AccessResource,
  type KnowledgeFiles,
  type KnowledgeHitDocument,
  type KnowledgeHitPage
} from "@work-shape/catalyst-core";
import { decodeKnowledgeText, normalizeKnowledgeText } from "./builtin/chunking";
import { isExtracted, readCopy, readExtraction } from "./index-extraction";
import { indexTargetOf } from "./index-job";
import type { KnowledgeRuntime } from "./runtime";
import { assetResource } from "../store-audience";

/**
 * The document a search hit names by its file id (KB-7c): the copy a published Knowledge Base
 * owns, of a document not withdrawn whose content was indexed, with the resource on which the
 * caller checks `knowledge_base.use`. Its text is the one the index read.
 */
export async function knowledgeHitDocument(
  runtime: KnowledgeRuntime,
  files: KnowledgeFiles | undefined,
  fileId: string,
  signal?: AbortSignal
): Promise<{ resource: AccessResource; document: KnowledgeHitDocument } | undefined> {
  if (!files) return undefined;
  const file = await runtime.stores.files.getManagedFile({
    clientInstanceId: runtime.clientInstanceId,
    fileId: asManagedFileId(fileId)
  });
  if (
    file?.owner?.kind !== "knowledge_base" ||
    (file.status !== "available" && file.status !== "released")
  )
    return undefined;
  const knowledgeBaseId = file.owner.id;
  const found = await indexTargetOf(runtime, knowledgeBaseId);
  const document = await found?.store.documentOfFile(file.id, signal);
  if (!found || !document) return undefined;
  const content = { knowledgeBaseId, contentSha256: document.contentSha256 };
  return {
    resource: assetResource(found.asset),
    document: {
      fileId: file.id,
      filename: file.filename,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      byteSize: file.byteSize,
      checksum: file.checksum,
      knowledgeBase: found.asset.name,
      format: document.format,
      ...(document.pageCount === undefined ? {} : { pageCount: document.pageCount }),
      original: file.status,
      async pages(): Promise<KnowledgeHitPage[]> {
        if (isExtracted(document.format) || document.synced) {
          const stored = await readExtraction(files, content);
          if (stored === undefined || stored === "invalid" || stored.status !== "extracted")
            throw unavailable();
          return stored.pages.map((page) => ({
            page: page.page,
            text: normalizeKnowledgeText(page.text)
          }));
        }
        const bytes = await readCopy(runtime, files, knowledgeBaseId, file.id);
        const text = bytes && decodeKnowledgeText(bytes);
        if (text === undefined) throw unavailable();
        return [{ page: 1, text: normalizeKnowledgeText(text) }];
      }
    }
  };
}

function unavailable(): AppError {
  return new AppError("NOT_FOUND", "The source document is no longer available.", undefined, {
    exposeMessage: true
  });
}
