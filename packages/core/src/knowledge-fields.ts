import type { JsonObject } from "./json";
import type { KnowledgeDocumentFormat } from "./knowledge-formats";

/** Approved extraction route supplied by a capability, never chosen by document content. */
export interface KnowledgeFieldExtractor {
  currency: string;
  /** Upper bound at admission; billed rates include input and output. */
  reserveCost(tokens: number): number;
  extract(input: {
    pages: { page: number; text: string }[];
    schema: JsonObject;
    maxTokens: number;
    reservedCost: number;
    correlationId: string;
    signal: AbortSignal;
    deadline: Date;
  }): Promise<{ text: string; cost: number }>;
}

/** Metadata only; page text is read from the retained extraction object. */
export interface KnowledgeFieldDocument {
  contentHash: string;
  fileId: string;
  format: KnowledgeDocumentFormat;
  path: string;
  type: string;
}

/** Atomic monthly admission in the Knowledge Base's own database. No provider call holds a lock. */
export interface KnowledgeFieldStore {
  document(id: string, signal?: AbortSignal): Promise<KnowledgeFieldDocument | undefined>;
  pause(documentId: string, signal?: AbortSignal): Promise<void>;
  reserve(
    input: { documentId: string; month: string; currency: string; cost: number; limit?: number },
    signal?: AbortSignal
  ): Promise<boolean>;
  settle(
    input: {
      documentId: string;
      contentHash: string;
      month: string;
      currency: string;
      reserved: number;
      cost: number;
    },
    signal?: AbortSignal
  ): Promise<boolean>;
}
