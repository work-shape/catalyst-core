import { z } from "zod";
import { AppError } from "@vivd-catalyst/core";
import { defineTool, toolFailed, toolSuccess, type AnyToolDefinition } from "@vivd-catalyst/tool-sdk";
import type { DocumentReader } from "./document-read-service";

const readDocumentInputSchema = z.discriminatedUnion("mode", [
  z.object({
    fileId: z.string().min(1),
    mode: z.literal("full")
  }),
  z.object({
    fileId: z.string().min(1),
    mode: z.literal("pages"),
    pages: z.object({
      from: z.number().int().positive(),
      to: z.number().int().positive()
    })
  })
]);

const warningSchema = z.object({
  code: z.string(),
  message: z.string()
});

const metadataSchema = z.object({
  fileId: z.string(),
  filename: z.string(),
  mimeType: z.string().optional(),
  byteSize: z.number(),
  format: z.enum(["pdf", "docx", "txt", "md"]).optional(),
  characterCount: z.number().optional(),
  wordCount: z.number().optional(),
  pageCount: z.number().optional(),
  preparedTextArtifactId: z.string().optional(),
  preparedPagesArtifactId: z.string().optional(),
  warnings: z.array(warningSchema),
  preprocessingVersion: z.string().optional(),
  preprocessingEngine: z.string().optional()
});

const readDocumentOutputSchema = z.discriminatedUnion("mode", [
  z.object({
    fileId: z.string(),
    mode: z.literal("full"),
    artifactId: z.string(),
    text: z.string(),
    metadata: metadataSchema
  }),
  z.object({
    fileId: z.string(),
    mode: z.literal("pages"),
    artifactId: z.string(),
    pages: z.array(
      z.object({
        pageNumber: z.number(),
        text: z.string(),
        characterCount: z.number(),
        wordCount: z.number(),
        warnings: z.array(warningSchema)
      })
    ),
    text: z.string(),
    metadata: metadataSchema
  })
]);

export function createReadDocumentTool(reader: DocumentReader): AnyToolDefinition {
  return defineTool({
    name: "read_document",
    description:
      'Read prepared text for a document attached to the current conversation. Use mode "full" for one full-document text response; page-aware PDFs include page delimiters in full mode. Use mode "pages" to read a specific page range without loading the full document.',
    inputSchema: readDocumentInputSchema,
    outputSchema: readDocumentOutputSchema,
    inputJsonSchema: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["fileId", "mode"],
          properties: {
            fileId: {
              type: "string",
              description: "The fileId from the current conversation attachment manifest."
            },
            mode: {
              const: "full",
              description: "Return one full-document text representation."
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["fileId", "mode", "pages"],
          properties: {
            fileId: {
              type: "string",
              description: "The fileId from the current conversation attachment manifest."
            },
            mode: {
              const: "pages",
              description: "Return only the requested page range."
            },
            pages: {
              type: "object",
              additionalProperties: false,
              required: ["from", "to"],
              properties: {
                from: {
                  type: "integer",
                  minimum: 1
                },
                to: {
                  type: "integer",
                  minimum: 1
                }
              }
            }
          }
        }
      ]
    },
    async execute(input, context) {
      const conversationId = context.toolRequest?.conversationId;
      if (!conversationId) {
        return toolFailed("handler_failed", "read_document requires an active conversation");
      }
      try {
        const result = await reader.readDocument({
          conversationId,
          ...input
        });
        return toolSuccess(result, {
          artifacts: [
            {
              artifactId: result.artifactId,
              kind: result.mode === "pages" ? "document.pages_json" : "document.prepared_text",
              filename: result.metadata.filename,
              mimeType: result.mode === "pages" ? "application/json" : "text/plain"
            }
          ],
          auditSummary: {
            action: "read_document",
            subject: result.fileId,
            metadata: removeUndefinedValues({
              filename: result.metadata.filename,
              mode: result.mode,
              artifactId: result.artifactId,
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
