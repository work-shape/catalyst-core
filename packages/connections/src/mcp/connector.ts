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
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { egressTargetOfUrl } from "../egress";
import {
  MCP_RESPONSE_ENVELOPE_BYTES,
  MCP_SOCKETS_PER_CONNECTION,
  MCP_TRANSPORT_HEADER_NAMES,
  createMcpSocketPool,
  readMcpChallenge,
  withMcpSession
} from "./client";
import { MCP_DISCOVERY_MAX_BYTES, MCP_DISCOVERY_TIMEOUT_MS, discoverMcpTools } from "./discovery";
import { holdsCredential } from "../connector-context";
import type { BearerChallenge } from "../oauth/challenge";
import { resourceAllowed } from "../oauth/checks";
import { createOAuthFetch } from "../oauth/fetch";
import { createSdkOAuthPort } from "../oauth/sdk-adapter";
import { mcpToolResult } from "./result";

export { MCP_CLEANUP_TIMEOUT_MS, MCP_POOLED_CONNECTIONS_MAX } from "./client";

// The Connector type `mcp`: a remote MCP server over Streamable HTTP. It has no stdio and no
// SSE-only transport. Its auth schemes send nothing, a bearer key, the key in one named
// header, or the access token of a shared OAuth sign-in (CS-4b). The tools of the server are
// read by discovery and never callable by that alone: the Connection's accepted list decides.

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

/** The most scopes a Connection names for its sign-in. */
export const MCP_OAUTH_MAX_SCOPES = 64;

/**
 * The sign-in of the auth scheme `oauth`. `clientId` is a client the provider issued
 * (pre-registered); without it the platform registers one where the server offers that.
 * `scopes` are the scopes asked for; without them those the server names.
 */
const oauthSettingsSchema = z
  .object({
    clientId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[\x21-\x7e]+$/u, "must be printable characters without spaces")
      .optional(),
    scopes: z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/u, "must be a scope name without spaces or quotes")
      )
      .max(MCP_OAUTH_MAX_SCOPES)
      .optional()
  })
  .strict();

/**
 * `headerName` is the header the key goes into under the auth scheme `header`. `oauth` is the
 * sign-in of the auth scheme `oauth`.
 */
const settingsSchema = z
  .object({
    url: serverUrl,
    oauth: oauthSettingsSchema.optional(),
    headerName: z
      .string()
      .regex(
        /^[A-Za-z][A-Za-z0-9-]{0,63}$/u,
        "must be a header name of letters, digits and hyphens"
      )
      .refine(
        (value) => !MCP_TRANSPORT_HEADER_NAMES.has(value.toLowerCase()),
        "must not be a header the transport writes itself, such as Host or Content-Length"
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

/**
 * Whether a server that refused with a Bearer challenge describes an OAuth sign-in for this
 * Connection: the challenge names its metadata, or Protected Resource Metadata at the
 * well-known places of the server's address (RFC 9728) names this server and an
 * authorization server. A Bearer refusal without either is a refused key. The metadata is
 * asked for through the checked fetch of the flow, at the Connection's own origin.
 */
async function describesSignIn(
  challenge: BearerChallenge,
  url: string,
  context: ConnectorContext
): Promise<boolean> {
  if (challenge.resourceMetadataUrl !== undefined) return true;
  try {
    const fetch = createOAuthFetch({
      egress: { check: (target) => context.checkEgress(target) },
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(MCP_TEST_TIMEOUT_MS)])
    });
    const resource = await createSdkOAuthPort().discoverResource({ resourceUrl: url, fetch });
    return resourceAllowed(resource.resource, url) && resource.authorizationServers.length > 0;
  } catch {
    return false;
  }
}

async function testStatusOf(
  error: unknown,
  challenge: BearerChallenge | undefined,
  url: string,
  context: ConnectorContext
): Promise<ConnectorTestStatus> {
  const reason = connectionCallReasonOf(error);
  // A refusal that describes the server's sign-in asks for an OAuth sign-in, not for
  // another key.
  if (reason === "upstream_unauthorized") {
    const signIn = challenge !== undefined && (await describesSignIn(challenge, url, context));
    return signIn ? "oauth_required" : "unauthorized";
  }
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
    authSchemes: ["none", "bearer", "header", "oauth"],
    secretFields: ["key"],
    target: (settings) => egressTargetOfUrl(settingsOf(settings).url),
    credentialHeaderName: (settings) => settingsOf(settings).headerName,
    carriesIdempotencyKey: true,
    limits: {
      callTimeoutMs: MCP_CALL_TIMEOUT_MS,
      resultMaxBytes: MCP_RESULT_MAX_BYTES,
      maxParallelCalls: MCP_MAX_PARALLEL_CALLS
    },

    signIn: {
      resourceUrl: (settings) => settingsOf(settings).url,
      oauthSettings: (settings) => settingsOf(settings).oauth ?? {},
      challenge: ({ target, settings, signal }) =>
        readMcpChallenge({ target, url: settingsOf(settings).url, signal })
    },

    async test(context) {
      let challenged: BearerChallenge | undefined;
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
            },
            onChallenge: (challenge) => {
              challenged = challenge;
            }
          },
          async (opened) => {
            await opened.listTools();
          }
        );
        return { status: "ready" };
      } catch (error) {
        const { url } = settingsOf(context.connection.settings);
        return { status: await testStatusOf(error, challenged, url, context) };
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
