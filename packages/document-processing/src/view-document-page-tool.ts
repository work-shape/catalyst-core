import { z } from "zod";
import { AppError } from "@vivd-catalyst/core";
import { defineTool, toolFailed, toolSuccess, type AnyToolDefinition } from "@vivd-catalyst/tool-sdk";
import type { DocumentPageViewer } from "./page-render-service";

const viewDocumentPageInputSchema = z.object({
  fileId: z.string().min(1),
  pageNumber: z.number().int().positive(),
  dpi: z.union([
    z.literal(150),
    z.literal(160),
    z.literal(200),
    z.literal("150"),
    z.literal("160"),
    z.literal("200")
  ]).optional()
});

const viewDocumentPageOutputSchema = z.object({
  fileId: z.string(),
  pageNumber: z.number(),
  pageCount: z.number(),
  dpi: z.number(),
  image: z.object({
    artifactId: z.string(),
    mimeType: z.literal("image/png"),
    byteSize: z.number(),
    checksum: z.string()
  })
});

export function createViewDocumentPageTool(viewer: DocumentPageViewer): AnyToolDefinition {
  return defineTool({
    name: "view_document_page",
    description:
      "Visually inspect one page of a document attached to the current conversation. Render a single prepared PDF page to PNG and load that image into model visual context. Use this only for pages whose layout, signatures, tables, stamps, scans, or images need visual inspection.",
    inputSchema: viewDocumentPageInputSchema,
    outputSchema: viewDocumentPageOutputSchema,
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["fileId", "pageNumber"],
      properties: {
        fileId: {
          type: "string",
          description: "The fileId from the current conversation attachment manifest."
        },
        pageNumber: {
          type: "integer",
          minimum: 1,
          description: "The 1-based document page number to render."
        },
        dpi: {
          type: "integer",
          enum: [150, 160, 200],
          description: "Optional render resolution. Defaults to 160."
        }
      }
    },
    async execute(input, context) {
      const conversationId = context.toolRequest?.conversationId;
      if (!conversationId) {
        return toolFailed("handler_failed", "view_document_page requires an active conversation");
      }
      try {
        const result = await viewer.viewPage({
          conversationId,
          fileId: input.fileId,
          pageNumber: input.pageNumber,
          dpi: input.dpi ? Number(input.dpi) : undefined
        });
        const filename = `document-page-${result.pageNumber}.png`;
        return toolSuccess(result, {
          artifacts: [
            {
              artifactId: result.image.artifactId,
              kind: "document.page_image",
              filename,
              mimeType: result.image.mimeType,
              modelVisibility: {
                type: "image",
                mimeType: "image/png"
              },
              metadata: {
                fileId: result.fileId,
                pageNumber: result.pageNumber,
                pageCount: result.pageCount,
                dpi: result.dpi
              }
            }
          ],
          auditSummary: {
            action: "view_document_page",
            subject: result.fileId,
            metadata: {
              pageNumber: result.pageNumber,
              pageCount: result.pageCount,
              dpi: result.dpi,
              artifactId: result.image.artifactId
            }
          }
        });
      } catch (error) {
        if (error instanceof AppError) {
          return toolFailed(
            error.code === "NOT_FOUND" || error.code === "VALIDATION_FAILED"
              ? "validation_failed"
              : "handler_failed",
            error.message
          );
        }
        return toolFailed(
          "handler_failed",
          error instanceof Error ? error.message : "Failed to render document page"
        );
      }
    }
  });
}
