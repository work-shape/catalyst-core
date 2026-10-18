import type { JsonObject } from "./json";
import type { KnowledgeDocumentFormat } from "./knowledge-formats";

/** Approved extraction route supplied by a capability, never chosen by document content. */
export interface KnowledgeFieldExtractor {
  currency: string;
  /** Refused only when publishing a monthly field budget; unbudgeted extraction needs no price. */
  assertBudgetPriced?(): void;
  /** An adapter may provide its tokenizer; otherwise UTF-8 bytes / 4 is used. */
  countInputTokens?(input: { pages: { page: number; text: string }[]; schema: JsonObject }): number;
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
  pause(
    documentId: string,
    reason: KnowledgeFieldsPendingReason,
    signal?: AbortSignal
  ): Promise<void>;
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

/** Why field extraction is paused, without retaining any document payload. */
export type KnowledgeFieldsPendingReason =
  | { reason: "monthly_budget" }
  | {
      reason: "token_budget";
      estimatedTokens: number;
      reservedOutputTokens: number;
      maxTokensPerDocument: number;
    };
