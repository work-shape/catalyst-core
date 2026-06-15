import { z } from "zod";
import { AppError } from "@vivd-catalyst/core";
import { defineTool, toolFailed, toolSuccess, type AnyToolDefinition } from "@vivd-catalyst/tool-sdk";
import type { DocumentReader } from "./document-read-service";

const readDocumentInputSchema = z.object({
  fileId: z.string().min(1)
});

const readDocumentOutputSchema = z.object({
  fileId: z.string(),
  preparedDocumentId: z.string(),
  text: z.string(),
  metadata: z.object({
    fileId: z.string(),
    filename: z.string(),
    mimeType: z.string().optional(),
    byteSize: z.number(),
    format: z.enum(["pdf", "docx", "txt", "md"]).optional(),
    characterCount: z.number().optional(),
    wordCount: z.number().optional(),
    pageCount: z.number().optional(),
    warnings: z.array(
      z.object({
        code: z.string(),
        message: z.string()
      })
    ),
    preprocessingVersion: z.string().optional()
  })
});

export function createReadDocumentTool(reader: DocumentReader): AnyToolDefinition {
  return defineTool({
    name: "read_document",
    description:
      "Read the full prepared text for a document attached to the current conversation. The input fileId must come from the attachment manifest shown in the conversation context. Returns raw extracted text plus structured metadata.",
    inputSchema: readDocumentInputSchema,
    outputSchema: readDocumentOutputSchema,
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["fileId"],
      properties: {
        fileId: {
          type: "string",
          description: "The fileId from the current conversation attachment manifest."
        }
      }
    },
    async execute(input, context) {
      const conversationId = context.toolRequest?.conversationId;
      if (!conversationId) {
        return toolFailed("handler_failed", "read_document requires an active conversation");
      }
      try {
        const result = await reader.readDocument({
          conversationId,
          fileId: input.fileId
        });
        return toolSuccess(result, {
          artifacts: [
            {
              artifactId: result.preparedDocumentId,
              kind: "document.prepared_text",
              filename: result.metadata.filename,
              mimeType: "text/plain"
            }
          ],
          auditSummary: {
            action: "read_document",
            subject: result.fileId,
            metadata: removeUndefinedValues({
              filename: result.metadata.filename,
              byteSize: result.metadata.byteSize,
              characterCount: result.metadata.characterCount,
              wordCount: result.metadata.wordCount,
              pageCount: result.metadata.pageCount
            })
          }
        });
      } catch (error) {
        if (error instanceof AppError) {
          return toolFailed(error.code === "NOT_FOUND" ? "validation_failed" : "handler_failed", error.message);
        }
        return toolFailed(
          "handler_failed",
          error instanceof Error ? error.message : "Failed to read document"
        );
      }
    }
  });
}

function removeUndefinedValues(input: Record<string, string | number | undefined>) {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string | number] => entry[1] !== undefined)
  );
}
