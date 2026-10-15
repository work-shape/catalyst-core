import {
  connectionCallError,
  isJsonObject,
  unknownToJsonValue,
  type JsonObject,
  type JsonValue
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { McpRawToolResult } from "./client";

// What a tool call of an MCP Connection answers, and the schema that describes it. The
// server's answer is untrusted data: it is read into a fixed shape, bounded, and refused
// where it holds the credential the call carried. Nothing of it becomes an instruction.

/** How many content blocks one result may hold. A longer result is `output_invalid`. */
const MCP_RESULT_MAX_CONTENT_BLOCKS = 256;

/** The `$id` of a tool's own output schema inside the result schema. See `mcpOutputSchema`. */
const TOOL_OUTPUT_SCHEMA_ID = "urn:catalyst:mcp-tool-output";

const text = z.string();
const optionalText = z.string().optional();

/**
 * The content blocks of the protocol, each with the members the protocol names and no
 * others. Annotations and `_meta` of the server are not passed on.
 */
const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text }),
  z.object({ type: z.literal("image"), data: text, mimeType: text }),
  z.object({ type: z.literal("audio"), data: text, mimeType: text }),
  z.object({
    type: z.literal("resource_link"),
    uri: text,
    name: optionalText,
    title: optionalText,
    description: optionalText,
    mimeType: optionalText
  }),
  z.object({
    type: z.literal("resource"),
    resource: z.object({
      uri: text,
      mimeType: optionalText,
      text: optionalText,
      blob: optionalText
    })
  })
]);

/**
 * The result of a call as the Connection answers it: `{ content, structuredContent }`. A
 * tool that reported a failure throws `upstream_error`, and its text is not passed on. A
 * block the protocol does not name, or a result that is larger than the bound, is
 * `output_invalid`.
 */
export function mcpToolResult(raw: McpRawToolResult, resultMaxBytes: number): JsonObject {
  if (raw.isError) throw connectionCallError("upstream_error");
  if (raw.content.length > MCP_RESULT_MAX_CONTENT_BLOCKS) {
    throw connectionCallError(
      "output_invalid",
      "the result holds more content blocks than MCP_RESULT_MAX_CONTENT_BLOCKS"
    );
  }
  const content: JsonValue[] = [];
  for (const block of raw.content) {
    const read = contentBlockSchema.safeParse(block);
    if (!read.success) {
      throw connectionCallError(
        "output_invalid",
        "the result holds a content block of no known kind"
      );
    }
    content.push(unknownToJsonValue(read.data));
  }
  const result: JsonObject = { content };
  if (raw.structuredContent !== undefined) {
    const structured = unknownToJsonValue(raw.structuredContent);
    if (!isJsonObject(structured)) {
      throw connectionCallError("output_invalid", "the structured content is not an object");
    }
    result.structuredContent = structured;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > resultMaxBytes) {
    throw connectionCallError("output_invalid", "the result is larger than MCP_RESULT_MAX_BYTES");
  }
  return result;
}

/**
 * The schema of what `mcpToolResult` answers, around the tool's own output schema. A tool
 * without one gets the bounded content alone.
 *
 * The tool's schema stands under `structuredContent` with an `$id`, so a reference inside it
 * (`#/$defs/...`) still points into the tool's schema and not into this one. Its dialect is
 * named at the top, where the validator reads it.
 */
export function mcpOutputSchema(toolOutputSchema: JsonObject | undefined): JsonObject {
  const content: JsonObject = {
    type: "array",
    maxItems: MCP_RESULT_MAX_CONTENT_BLOCKS,
    items: {
      type: "object",
      properties: { type: { type: "string" } },
      required: ["type"]
    }
  };
  if (toolOutputSchema === undefined) {
    return {
      type: "object",
      properties: { content, structuredContent: { type: "object" } },
      required: ["content"],
      additionalProperties: false
    };
  }
  const { $schema: dialect, ...own } = toolOutputSchema;
  return {
    ...(dialect === undefined ? {} : { $schema: dialect }),
    type: "object",
    properties: { content, structuredContent: { $id: TOOL_OUTPUT_SCHEMA_ID, ...own } },
    required: ["content", "structuredContent"],
    additionalProperties: false
  };
}
