// The page cache of a Knowledge Base (KB-13b; spec: data-stores-and-knowledge-bases.md,
// "Originals stay in the DMS"). A synced document keeps no copy of its original once it is
// extracted. Opening a cited page fetches the original through the source's Connection, as
// the Knowledge Base's ingestion principal, into this cache: bounded in bytes per Knowledge
// Base (`knowledge.pageCacheBytes`), each entry for 7 days from its fetch, deleted with its
// document and with the Knowledge Base. A withdrawn document is never served from it.
//
// Sensitive data. An entry is the original's bytes. Its row names the document by id, never by
// file name or path, and no audit event, log line or error carries either.

/** How long a fetched original is kept: 7 days from the fetch, not extended by an open. */
export const KNOWLEDGE_PAGE_CACHE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** The size of one Knowledge Base's page cache unless release config sets another. */
export const KNOWLEDGE_PAGE_CACHE_BYTES_DEFAULT = 512 * 1024 * 1024;

/** The code an open answers when the source of a synced document cannot be reached. */
export const KNOWLEDGE_SOURCE_UNREACHABLE = "knowledge_source_unreachable";

/** Where the entries of a Knowledge Base's page cache are kept in the object store. */
export function knowledgePageCachePrefix(knowledgeBaseId: string, documentId?: string): string {
  const base = `knowledge-bases/${knowledgeBaseId}/page-cache/`;
  return documentId === undefined ? base : `${base}${encodeURIComponent(documentId)}/`;
}

/** What a page open needs of a live document of a connector source to fetch it again. */
export interface KnowledgePageSource {
  sourceId: string;
  itemId: string;
  version: string;
  contentSha256: string;
}

/** A cached original that has not expired. */
export interface KnowledgeCachedPage {
  objectKey: string;
  byteSize: number;
  expiresAt: string;
}

/** One entry, as an expiry or an eviction deletes it. */
export interface KnowledgePageCacheEntry {
  documentId: string;
  objectKey: string;
}

/**
 * The rows of the page cache in the Knowledge Base's own store. The objects are the caller's:
 * a row is deleted only once its object is gone, so the rows are never fewer than the bytes.
 */
export interface KnowledgePageCacheStore {
  /**
   * A live document of a synced source, with its entry where one is cached for its current
   * content and has not expired. Nothing where the document is withdrawn, removed, or was added
   * by hand.
   */
  read(
    documentId: string,
    signal?: AbortSignal
  ): Promise<{ source: KnowledgePageSource; cached?: KnowledgeCachedPage } | undefined>;
  /**
   * Keeps the entry of a document fetched for `contentSha256`, in place of an earlier one,
   * holding the document's row against a withdrawal while it does. Then evicts the oldest other
   * entries until the cache holds at most `limitBytes`. `remove` deletes objects and answers the
   * keys whose object stayed; their rows stay too. `kept` is false, and nothing is written,
   * where the document is no longer live or holds other content now.
   */
  put(
    input: {
      documentId: string;
      contentSha256: string;
      objectKey: string;
      byteSize: number;
      lifetimeMs: number;
      limitBytes: number;
    },
    remove: (objectKeys: string[]) => Promise<string[]>,
    signal?: AbortSignal
  ): Promise<{ kept: false } | { kept: true; expiresAt: string; evicted: number }>;
  /** At most `limit` entries whose time is over, oldest first. */
  expired(limit: number, signal?: AbortSignal): Promise<KnowledgePageCacheEntry[]>;
  /** Deletes the rows of these entries, each only while it still names that object. */
  forget(entries: readonly KnowledgePageCacheEntry[], signal?: AbortSignal): Promise<void>;
  /** Deletes the rows of these documents; answers how many. */
  forgetDocuments(documentIds: readonly string[], signal?: AbortSignal): Promise<number>;
  /** When the next entry expires; nothing where the cache is empty. */
  nextExpiry(signal?: AbortSignal): Promise<string | undefined>;
}
