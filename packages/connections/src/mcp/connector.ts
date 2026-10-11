import {
  connectionCallError,
  connectionCallReasonOf,
  isJsonObject,
  unknownToJsonValue,
  type ConnectorContext,
  type ConnectorTestStatus,
  type ConnectorTypeDefinition,
  type JsonObject,
  type JsonValue,
  type Logger
} from "@vivd-catalyst/core";
import { z } from "zod";
import { egressTargetOfUrl } from "../egress";
import {
  MCP_RESPONSE_ENVELOPE_BYTES,
  MCP_SOCKETS_PER_CONNECTION,
  createMcpSocketPool,
  withMcpSession
} from "./client";
import { MCP_DISCOVERY_MAX_BYTES, MCP_DISCOVERY_TIMEOUT_MS, discoverMcpTools } from "./discovery";
import { holdsCredential, mcpToolResult } from "./result";

// The Connector type `mcp`: a remote MCP server over Streamable HTTP. It has no stdio, no
// SSE-only transport and no OAuth. Its auth schemes send nothing, a bearer key, or the key
// in one named header. The tools of the server are read by discovery and never callable by
// that alone: the Connection's accepted list decides.

/** The id a Connection names as its `connectorType`. */
export const MCP_CONNECTOR_TYPE = "mcp";
/** How long one tool call may take, handshake included. Reached: `upstream_timeout`. */
export const MCP_CALL_TIMEOUT_MS = 30_000;
/** The largest result of one tool call. Reached: `output_invalid`. */
export const MCP_RESULT_MAX_BYTES = 2 * 1024 * 1024;
/** Calls of one Connection that run side by side in one process. Each holds one socket. */
export const MCP_MAX_PARALLEL_CALLS = MCP_SOCKETS_PER_CONNECTION;
/** How long a test of a Connection may take. */
export const MCP_TEST_TIMEOUT_MS = 10_000;
/** The longest address of a server. */
export const MCP_URL_MAX_CHARS = 2_048;

/**
 * The address of the server: `https`, or `http` for a target the operator's egress list
 * marks as private. It holds no user name, no password, no query and no fragment: a key in
 * an address ends up in the logs of the other side.
 */
const serverUrl = z
  .string()
  .max(MCP_URL_MAX_CHARS)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  }, "must be an http or https address without user name, password, query or fragment");

/** `headerName` is the header the key goes into under the auth scheme `header`. */
const settingsSchema = z
  .object({
    url: serverUrl,
    headerName: z
      .string()
      .regex(
        /^[A-Za-z][A-Za-z0-9-]{0,63}$/u,
        "must be a header name of letters, digits and hyphens"
      )
      .optional()
  })
  .strict();

function settingsOf(settings: JsonObject): z.infer<typeof settingsSchema> {
  const read = settingsSchema.safeParse(settings);
  // The platform hands a type only settings its schema accepted.
  if (!read.success) throw connectionCallError("connection_not_configured");
  return read.data;
}

function testStatusOf(error: unknown): ConnectorTestStatus {
  const reason = connectionCallReasonOf(error);
  if (reason === "upstream_unauthorized") return "unauthorized";
  if (reason === "egress_denied") return "network_denied";
  return "unavailable";
}

/**
 * Runs the work of a discovery or a call so that only a reason leaves it. What the server
 * sent is read after the session too, and data that breaks that reading, such as a document
 * nested deeper than the runtime follows, is a failure of the server like any other.
 */
async function reasoned<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    throw connectionCallReasonOf(error) === undefined
      ? connectionCallError("upstream_error")
      : error;
  }
}

export interface McpConnectorOptions {
  /** Told how many tools a discovery left out, by reason. Never a name, a schema or a value. */
  logger?: Logger;
}

/**
 * The Connector type `mcp` of one process. Building it opens no connection: the first
 * request leaves with the first test, discovery or call.
 */
export function createMcpConnectorType(options: McpConnectorOptions = {}): ConnectorTypeDefinition {
  const sockets = createMcpSocketPool();
  const session = (context: ConnectorContext) => ({
    context,
    sockets,
    url: settingsOf(context.connection.settings).url
  });

  return {
    type: MCP_CONNECTOR_TYPE,
    description: "A remote MCP server over Streamable HTTP.",
    settingsSchema,
    authSchemes: ["none", "bearer", "header"],
    secretFields: ["key"],
    target: (settings) => egressTargetOfUrl(settingsOf(settings).url),
    credentialHeaderName: (settings) => settingsOf(settings).headerName,
    limits: {
      callTimeoutMs: MCP_CALL_TIMEOUT_MS,
      resultMaxBytes: MCP_RESULT_MAX_BYTES,
      maxParallelCalls: MCP_MAX_PARALLEL_CALLS
    },

    async test(context) {
      try {
        // The handshake and one page of the tool list: the server is there, speaks the
        // protocol and takes the credential. Nothing of what it answers is kept.
        await withMcpSession(
          {
            ...session(context),
            bounds: {
              timeoutMs: MCP_TEST_TIMEOUT_MS,
              maxResponseBytes: MCP_DISCOVERY_MAX_BYTES,
              tooLarge: "the server's answer is larger than MCP_DISCOVERY_MAX_BYTES"
            }
          },
          async (opened) => {
            await opened.listTools();
          }
        );
        return { status: "ready" };
      } catch (error) {
        return { status: testStatusOf(error) };
      }
    },

    discover: (context) =>
      reasoned(async () => {
        const found = await withMcpSession(
          {
            ...session(context),
            bounds: {
              timeoutMs: MCP_DISCOVERY_TIMEOUT_MS,
              maxResponseBytes: MCP_DISCOVERY_MAX_BYTES,
              tooLarge: "the server's tool list is larger than MCP_DISCOVERY_MAX_BYTES"
            }
          },
          discoverMcpTools
        );
        const credential = context.credentialFor(context.target);
        for (const descriptor of found.descriptors) {
          if (holdsCredential(unknownToJsonValue(descriptor), credential)) {
            throw connectionCallError("output_rejected");
          }
        }
        const omitted = found.omitted.malformed + found.omitted.name + found.omitted.schemaTooLarge;
        if (omitted > 0) {
          options.logger?.warn(
            { connection: context.connection.name, omitted: found.omitted },
            "A discovery left out tools of an MCP server"
          );
        }
        return found.descriptors;
      }),

    execute: (operation, input: JsonValue, context) =>
      reasoned(async () => {
        if (!isJsonObject(input)) {
          throw connectionCallError("input_invalid", "the input of an MCP tool is an object");
        }
        const raw = await withMcpSession(
          {
            ...session(context),
            bounds: {
              timeoutMs: MCP_CALL_TIMEOUT_MS,
              maxResponseBytes: MCP_RESULT_MAX_BYTES + MCP_RESPONSE_ENVELOPE_BYTES,
              tooLarge: "the result is larger than MCP_RESULT_MAX_BYTES"
            }
          },
          (opened) => opened.callTool(operation, input)
        );
        const result = mcpToolResult(raw, MCP_RESULT_MAX_BYTES);
        if (holdsCredential(result, context.credentialFor(context.target))) {
          throw connectionCallError("output_rejected");
        }
        return result;
      })
  };
}
