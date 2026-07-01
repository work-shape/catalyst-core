import { z } from "zod";
import type { AnyToolDefinition } from "@vivd-catalyst/tool-sdk";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import {
  DirectWebFetcher,
  type WebFetchInput,
  type WebFetchOutput,
  type WebFetchRuntimeConfig,
  WebFetchFailure,
  WEB_FETCH_TOOL_NAME
} from "./direct-web-fetcher";

export const webFetchInputSchema = z
  .object({
    url: z.string().url(),
    maxCharacters: z.number().int().positive().max(200000).optional()
  })
  .strict();

export const webFetchOutputSchema = z
  .object({
    finalUrl: z.string().url(),
    title: z.string().min(1).optional(),
    contentType: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    text: z.string(),
    truncated: z.boolean(),
    source: z.object({
      id: z.string().min(1),
      url: z.string().url(),
      title: z.string().min(1).optional(),
      provider: z.literal("direct"),
      retrievedAt: z.string().datetime(),
      contentHash: z.string().min(1)
    })
  })
  .strict();

export interface CreateWebFetchToolInput {
  config: Partial<WebFetchRuntimeConfig>;
  fetcher?: DirectWebFetcher;
}

export function createWebFetchTool(input: CreateWebFetchToolInput): AnyToolDefinition {
  const fetcher = input.fetcher ?? new DirectWebFetcher({ config: input.config });

  return defineTool<WebFetchInput, WebFetchOutput>({
    name: WEB_FETCH_TOOL_NAME,
    description:
      "Fetch a public http or https HTML/text page by URL, extract conservative readable text, and return bounded source metadata. This tool cannot access localhost, private networks, cloud metadata hosts, authenticated browser sessions, files, or JavaScript-only pages.",
    inputSchema: webFetchInputSchema,
    outputSchema: webFetchOutputSchema,
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          format: "uri",
          description: "Public http or https URL to fetch."
        },
        maxCharacters: {
          type: "integer",
          minimum: 1,
          maximum: 200000,
          description:
            "Optional maximum characters of extracted text to return, capped by the client instance webAccess.fetch setting."
        }
      }
    },
    async execute(toolInput, context) {
      try {
        const { redirectCount, ...output } = await fetcher.fetch(toolInput, context);
        return toolSuccess(output, {
          auditSummary: {
            action: WEB_FETCH_TOOL_NAME,
            subject: output.finalUrl,
            metadata: {
              status: "success",
              contentType: output.contentType,
              bytes: output.bytes,
              redirectCount,
              truncated: output.truncated
            }
          }
        });
      } catch (error) {
        if (error instanceof WebFetchFailure) {
          return {
            status: error.resultStatus,
            error: {
              code: error.code,
              message: error.message
            },
            auditSummary: {
              action: WEB_FETCH_TOOL_NAME,
              subject: error.subject,
              metadata: error.metadata
            }
          };
        }
        throw error;
      }
    }
  });
}

export function createWebFetchToolDefinitions(input: {
  config: Partial<WebFetchRuntimeConfig>;
}): AnyToolDefinition[] {
  return [createWebFetchTool({ config: input.config })];
}
