import { ModelProviderError } from "../model-provider-error";
import type { ModelMessage } from "../types";
import type { BedrockContentBlock } from "./bedrock-wire";

// Protects a call from a request Bedrock refuses whole over one document. AWS states no size
// of one PDF for `InvokeModel`; 4.5 MB is what its Converse API takes for one document, the
// smallest limit AWS states for a document on Bedrock. A larger one is refused here.
export const BEDROCK_DOCUMENT_MAX_BYTES = 4_500_000;
// Protects a call from a request Bedrock refuses whole over its pages: Claude on Bedrock reads
// at most 100 PDF pages in one request.
export const BEDROCK_DOCUMENT_MAX_PAGES = 100;

type DocumentPart = Extract<Exclude<ModelMessage["content"], string>[number], { type: "document" }>;

/**
 * Refuses a request whose documents Bedrock would not take, before anything is sent. A document
 * is never left out: a caller that sent one asked about it, and an answer without it would look
 * like an answer about it. The refusal names its reason and the limit, never the document.
 */
export function assertBedrockDocuments(
  messages: readonly ModelMessage[],
  providerId: string
): void {
  const documents = messages
    .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
    .filter((part): part is DocumentPart => part.type === "document");
  if (documents.some((document) => document.data.byteLength > BEDROCK_DOCUMENT_MAX_BYTES)) {
    throw new ModelProviderError({
      kind: "invalid_request",
      message: "A document is too large for the model. Split it and send the parts.",
      details: { providerId, reason: "document_too_large", limit: "BEDROCK_DOCUMENT_MAX_BYTES" }
    });
  }
  const pages = documents.reduce((sum, document) => sum + countPdfPages(document.data), 0);
  if (pages > BEDROCK_DOCUMENT_MAX_PAGES) {
    throw new ModelProviderError({
      kind: "invalid_request",
      message: "The documents have too many pages for the model. Split them and send the parts.",
      details: {
        providerId,
        reason: "document_too_many_pages",
        limit: "BEDROCK_DOCUMENT_MAX_PAGES"
      }
    });
  }
}

/**
 * The pages of a PDF as its page objects state them. A PDF that keeps its page objects inside
 * compressed object streams shows none here and counts as zero: it is sent, and Bedrock judges
 * its pages. So this refuses what it can see, and never refuses a document for pages it has not.
 */
function countPdfPages(data: Uint8Array): number {
  return (
    Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      .toString("latin1")
      .match(/\/Type\s*\/Page(?![A-Za-z])/gu)?.length ?? 0
  );
}

export function toBedrockDocumentBlock(part: DocumentPart): BedrockContentBlock {
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: part.mimeType,
      data: Buffer.from(part.data).toString("base64")
    }
  };
}
