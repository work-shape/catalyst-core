import type { AuthenticatedUser } from "./identity";
import type { ConversationId, ManagedFileId } from "./ids";
import type { KnowledgeDocumentFormat } from "./knowledge";

// The documents of Knowledge Bases that the document tools read on a search hit's file id
// (KB-7c, Data Stores And Knowledge Bases check 10). A hit names the copy its Knowledge Base
// owns; the person may read it where they may use that Knowledge Base, in the workspace of the
// conversation the agent answers in, as they may open the cited file there.

/** One page of a document's text, as the index read it. */
export interface KnowledgeHitPage {
  page: number;
  text: string;
}

/** A document of a Knowledge Base, found by the file id of a hit. */
export interface KnowledgeHitDocument {
  fileId: ManagedFileId;
  filename: string;
  mimeType?: string;
  byteSize: number;
  checksum: string;
  /** The name of the Knowledge Base that holds it. */
  knowledgeBase: string;
  format: KnowledgeDocumentFormat;
  pageCount?: number;
  /** `released`: the original's bytes stay in the source; only its text is kept (KB-13). */
  original: "available" | "released";
  /** The text of each page, as the Knowledge Base indexed it. */
  pages(signal?: AbortSignal): Promise<KnowledgeHitPage[]>;
  /**
   * Where a page view reads the original's bytes (KB-14): the copy `fileId` names, or for a
   * released original the entry of the page cache, fetched through its source for the person
   * who opened the hit where it was not cached (KB-13b). `correlationId` goes on that fetch's
   * audit event. Refuses a withdrawn document and an unreachable source.
   */
  openOriginal(input: {
    correlationId: string;
    signal?: AbortSignal;
  }): Promise<KnowledgeHitOriginal>;
}

/**
 * The original of a hit's document as a page view reads it: the copy its file id names, or an
 * object of the Knowledge Base's page cache (below `knowledgePageCachePrefix`) whose bytes hash
 * to the document's checksum.
 */
export type KnowledgeHitOriginal = { kind: "copy" } | { kind: "page_cache"; objectKey: string };

export interface KnowledgeHitDocuments {
  /**
   * The document whose copy `fileId` names, where `user` may use its Knowledge Base in the
   * conversation's workspace. None otherwise, and none for a file no Knowledge Base holds:
   * the answer never tells which.
   */
  open(input: {
    user: AuthenticatedUser;
    conversationId: ConversationId;
    fileId: string;
    signal?: AbortSignal;
  }): Promise<KnowledgeHitDocument | undefined>;
}
