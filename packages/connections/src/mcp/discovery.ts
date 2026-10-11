import {
  CONNECTION_OPERATION_NAME_MAX_LENGTH,
  CONNECTION_OPERATION_NAME_PATTERN,
  connectionCallError,
  isJsonObject,
  unknownToJsonValue,
  type ConnectorOperationDescriptor,
  type JsonObject
} from "@vivd-catalyst/core";
import { z } from "zod";
import type { McpSession } from "./client";
import { mcpOutputSchema } from "./result";

// Reads the tool list of an MCP server into descriptors. Everything read is untrusted data
// and bounded: the whole list by pages, tools and bytes, each tool by its schemas and its
// description. A bound on the whole list fails the discovery, and what was stored before
// stays. A bound on one tool leaves that tool out and keeps the others.
//
// The values are those of ADR-0020.

/** How long one discovery may take, handshake and every page. */
export const MCP_DISCOVERY_TIMEOUT_MS = 30_000;
/** How many pages of `tools/list` one discovery reads. A server with more fails it. */
const MCP_DISCOVERY_MAX_PAGES = 20;
/** How many tools one discovery reads. A server with more fails it. */
const MCP_DISCOVERY_MAX_TOOLS = 500;
/** How many bytes one discovery reads from the server, over all pages. */
export const MCP_DISCOVERY_MAX_BYTES = 4 * 1024 * 1024;
/** The largest input schema and the largest output schema of one tool. */
const MCP_TOOL_SCHEMA_MAX_BYTES = 64 * 1024;
/** How much of a tool's description is kept. The rest is cut. */
const MCP_TOOL_DESCRIPTION_MAX_CHARS = 4_000;

/** One tool as the protocol lists it. Members this type does not read are dropped. */
const toolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.object({ readOnlyHint: z.boolean().optional() }).optional()
});

/** Why a listed tool is not among the descriptors, each with how many tools it left out. */
interface McpDiscoveryOmissions {
  /** Not a tool as the protocol describes one. */
  malformed: number;
  /** A name that cannot end an operation name. */
  name: number;
  /** An input or output schema over `MCP_TOOL_SCHEMA_MAX_BYTES`. */
  schemaTooLarge: number;
}

interface McpDiscovery {
  descriptors: ConnectorOperationDescriptor[];
  omitted: McpDiscoveryOmissions;
}

function schemaOf(value: Record<string, unknown>): JsonObject | "too_large" | undefined {
  const schema = unknownToJsonValue(value);
  if (!isJsonObject(schema)) return undefined;
  return Buffer.byteLength(JSON.stringify(schema)) > MCP_TOOL_SCHEMA_MAX_BYTES
    ? "too_large"
    : schema;
}

/**
 * One listed tool as a descriptor, or the reason it is left out. `readOnlyHint: true`
 * proposes `reading`; false or absent proposes `changing`. The hint proposes and decides
 * nothing.
 */
function describeTool(listed: unknown): ConnectorOperationDescriptor | keyof McpDiscoveryOmissions {
  const read = toolSchema.safeParse(listed);
  if (!read.success) return "malformed";
  const tool = read.data;
  if (
    tool.name.length > CONNECTION_OPERATION_NAME_MAX_LENGTH ||
    !CONNECTION_OPERATION_NAME_PATTERN.test(tool.name)
  ) {
    return "name";
  }
  const inputSchema = schemaOf(tool.inputSchema);
  const ownOutputSchema = tool.outputSchema === undefined ? undefined : schemaOf(tool.outputSchema);
  if (inputSchema === "too_large" || ownOutputSchema === "too_large") return "schemaTooLarge";
  if (inputSchema === undefined) return "malformed";
  return {
    name: tool.name,
    description: (tool.description ?? "").slice(0, MCP_TOOL_DESCRIPTION_MAX_CHARS),
    inputSchema,
    outputSchema: mcpOutputSchema(ownOutputSchema),
    proposedEffect: tool.annotations?.readOnlyHint === true ? "reading" : "changing"
  };
}

/**
 * Reads every page of the server's tool list. More pages or more tools than the bounds
 * allow fail the discovery, naming the bound. The bytes are bounded by the session.
 */
export async function discoverMcpTools(session: McpSession): Promise<McpDiscovery> {
  const descriptors: ConnectorOperationDescriptor[] = [];
  const omitted: McpDiscoveryOmissions = { malformed: 0, name: 0, schemaTooLarge: 0 };
  let listed = 0;
  let cursor: string | undefined;
  for (let page = 1; ; page += 1) {
    const { tools, nextCursor } = await session.listTools(cursor);
    listed += tools.length;
    if (listed > MCP_DISCOVERY_MAX_TOOLS) {
      throw connectionCallError(
        "output_invalid",
        "the server lists more tools than MCP_DISCOVERY_MAX_TOOLS"
      );
    }
    for (const tool of tools) {
      const described = describeTool(tool);
      if (typeof described === "string") omitted[described] += 1;
      else descriptors.push(described);
    }
    if (nextCursor === undefined || nextCursor === "") return { descriptors, omitted };
    if (page >= MCP_DISCOVERY_MAX_PAGES) {
      throw connectionCallError(
        "output_invalid",
        "the server's tool list has more pages than MCP_DISCOVERY_MAX_PAGES"
      );
    }
    cursor = nextCursor;
  }
}
