import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  EGRESS_DENIED,
  connectionCallError,
  connectionCallReasonOf,
  isAppError,
  type ConnectionCallReason,
  type ConnectionCredential,
  type ConnectorContext,
  type EgressGrant,
  type JsonObject
} from "@vivd-catalyst/core";
import { z } from "zod";
import { egressTargetOfUrl, isSameEgressOrigin, pinnedLookup } from "../egress";

// The one file that speaks to a remote MCP server, and the one file that knows the MCP SDK.
// Everything the SDK sends leaves through `pinnedFetch` below, and nothing else in this
// package opens a connection for an MCP Connection.
//
// What is decided here:
// - Transport is Streamable HTTP. A session is opened for one test, discovery or call and
//   ended with it. Nothing is connected before the first of those: building the type opens
//   no socket.
// - A request to the Connection's own origin goes to `context.target`, the target the call
//   was checked and opened with. Every other target, which only a redirect can name, asks
//   `context.checkEgress` first. Either way the request connects to the address the check
//   pinned, with the host name unchanged as `Host` header and TLS name. The request is
//   built from the checked target, and the agents are this file's own: the process's
//   agent and a proxy of the environment are never used.
// - No redirect is followed by the HTTP layer. A 307 or 308 is followed here, after a fresh
//   egress check of where it points. Any other redirect is a failure.
// - The credential is read from `context.credentialFor` for each request and put on that one
//   request. `credentialFor` refuses every origin but the Connection's own, and a refused
//   target is sent no credential and no session id.
// - What the server answers is untrusted and bounded while it is read: a session reads no
//   more bytes than its budget, whatever the server sends.
// - No error leaves this file with text of the server. A failure is one reason.

/** How many redirects one request follows before it fails. */
const MCP_MAX_REDIRECTS = 3;
/**
 * How many sockets one Connection keeps to its server in one process. Calls beyond it wait
 * for a socket. It equals the calls of one Connection that run side by side.
 */
export const MCP_SOCKETS_PER_CONNECTION = 8;
/** How long an unused socket stays open for the next call before it is closed. */
const MCP_IDLE_SOCKET_TIMEOUT_MS = 30_000;
/**
 * For how many Connections one process keeps sockets for reuse. Beyond it the Connection
 * that was used longest ago opens new sockets at its next call.
 */
const MCP_POOLED_CONNECTIONS_MAX = 256;
/** The longest session id a server may hand out. A longer one fails the session. */
const MCP_SESSION_ID_MAX_CHARS = 256;
/**
 * What a session may read beside its result: the answer to the handshake and the frame
 * around a result.
 */
export const MCP_RESPONSE_ENVELOPE_BYTES = 64 * 1024;
/**
 * The longest body of an answer nobody reads that is still read to its end, so that its
 * socket can be used again. A longer one closes the socket.
 */
const MCP_DISCARD_MAX_BYTES = 16 * 1024;
/**
 * How long the end of a session may take beyond its work: telling the server the session is
 * over, and reading an answer nobody reads to its end. A server that stays silent then loses
 * its socket, and the call goes on without it. The caller's signal ends both at once.
 */
export const MCP_CLEANUP_TIMEOUT_MS = 3_000;

const CLIENT_INFO = { name: "workshape-catalyst", version: "1" } as const;
const SESSION_ID_PATTERN = /^[\x21-\x7e]+$/u;

type PooledAgent = HttpAgent | HttpsAgent;

/** The sockets one process keeps to MCP servers, by Connection. It holds no credential. */
interface McpSocketPool {
  agentFor(connectionId: string, grant: EgressGrant): PooledAgent;
}

export function createMcpSocketPool(): McpSocketPool {
  // Insertion order is use order: an entry that is used moves to the end. An entry that is
  // dropped is not closed by force: calls on its sockets end as they would, and each socket
  // closes once it was unused for MCP_IDLE_SOCKET_TIMEOUT_MS.
  const agents = new Map<string, { key: string; agent: PooledAgent }>();
  return {
    agentFor(connectionId, grant) {
      // A socket is reused only towards the address that was checked for this call.
      const key = `${grant.protocol}|${grant.host}|${grant.port}|${grant.address}`;
      const held = agents.get(connectionId);
      if (held) {
        agents.delete(connectionId);
        if (held.key === key) {
          agents.set(connectionId, held);
          return held.agent;
        }
      }
      const options = {
        keepAlive: true,
        maxSockets: MCP_SOCKETS_PER_CONNECTION,
        maxFreeSockets: MCP_SOCKETS_PER_CONNECTION,
        timeout: MCP_IDLE_SOCKET_TIMEOUT_MS
      };
      const agent = grant.protocol === "https" ? new HttpsAgent(options) : new HttpAgent(options);
      agents.set(connectionId, { key, agent });
      if (agents.size > MCP_POOLED_CONNECTIONS_MAX) {
        const oldest = agents.keys().next();
        if (!oldest.done) agents.delete(oldest.value);
      }
      return agent;
    }
  };
}

/** What one session may take: time, and bytes read from the server over all its answers. */
interface McpSessionBounds {
  timeoutMs: number;
  maxResponseBytes: number;
  /** What a session that read more than `maxResponseBytes` is refused with. It names the bound. */
  tooLarge: string;
}

/** One page of the server's tool list. Each tool is as the server sent it: untrusted. */
interface McpToolsPage {
  tools: unknown[];
  nextCursor?: string;
}

/** The answer to one tool call, as the server sent it: untrusted. */
export interface McpRawToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError: boolean;
}

export interface McpSession {
  listTools(cursor?: string): Promise<McpToolsPage>;
  callTool(name: string, input: JsonObject): Promise<McpRawToolResult>;
}

const toolsPageSchema = z.object({
  tools: z.array(z.unknown()),
  nextCursor: z.string().optional()
});

const toolResultSchema = z.object({
  content: z.array(z.unknown()).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional()
});

/** What a session remembers of its failures. The first reason is the one that is told. */
interface SessionState {
  reason: ConnectionCallReason | undefined;
  /** A sentence of this package for the reason, where the default one says too little. */
  message: string | undefined;
  remainingBytes: number;
  tooLarge: string;
  /** Ends every pending request of the session. */
  abort: AbortController;
}

function fail(state: SessionState, reason: ConnectionCallReason, message?: string): Error {
  if (state.reason === undefined) {
    state.reason = reason;
    state.message = message;
  }
  return connectionCallError(state.reason, state.message);
}

function reasonOfStatus(status: number): ConnectionCallReason {
  if (status === 401 || status === 403) return "upstream_unauthorized";
  if (status === 429) return "upstream_rate_limited";
  if (status === 502 || status === 503 || status === 504) return "connection_unavailable";
  return "upstream_error";
}

/**
 * The credential for a checked target, or nothing where the Connection has none or the
 * target is not the Connection's own origin. `credentialFor` decides: its refusal of
 * another origin means that origin is sent no credential.
 */
function credentialOrNone(
  context: ConnectorContext,
  grant: EgressGrant
): ConnectionCredential | undefined {
  try {
    return context.credentialFor(grant);
  } catch (error) {
    if (connectionCallReasonOf(error) === EGRESS_DENIED) return undefined;
    throw error;
  }
}

interface Hop {
  url: URL;
  grant: EgressGrant;
  method: "POST" | "DELETE";
  headers: Record<string, string>;
  body: string | undefined;
  agent: PooledAgent;
  signal: AbortSignal;
}

const DEFAULT_PORTS = { https: 443, http: 80 } as const;

/** The `Host` of a request, written from the checked target and from nothing else. */
function hostHeaderOf(grant: EgressGrant): string {
  const host = isIP(grant.host) === 6 ? `[${grant.host}]` : grant.host;
  const usual = grant.protocol === "https" ? DEFAULT_PORTS.https : DEFAULT_PORTS.http;
  return grant.port === usual ? host : `${host}:${grant.port}`;
}

function oneRequestAgent(grant: EgressGrant): PooledAgent {
  return grant.protocol === "https" ? new HttpsAgent() : new HttpAgent();
}

/**
 * Sends one request to the pinned address and answers once the status line arrived. Where
 * it goes is read from the checked target alone: protocol, host, port and address. Of the
 * address the server was configured or redirected with, only path and query are used.
 */
function sendHop(hop: Hop): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (hop.signal.aborted) {
      reject(new Error("The session ended"));
      return;
    }
    const literal = isIP(hop.grant.host) !== 0;
    const send = hop.grant.protocol === "https" ? httpsRequest : httpRequest;
    const request = send({
      protocol: `${hop.grant.protocol}:`,
      // A name is resolved by the pinned lookup only. A literal address is the pinned one.
      host: literal ? hop.grant.address : hop.grant.host,
      port: hop.grant.port,
      path: `${hop.url.pathname}${hop.url.search}`,
      method: hop.method,
      headers: hop.headers,
      lookup: pinnedLookup(hop.grant),
      agent: hop.agent
    });
    // The signal is watched here and not handed to the request: a request that is ended
    // through its own signal reports that on streams nobody listens to any more, and an
    // error without a listener ends the process.
    let response: IncomingMessage | undefined;
    const onAbort = () => {
      response?.destroy();
      request.destroy(new Error("The session ended"));
    };
    const settle = () => hop.signal.removeEventListener("abort", onAbort);
    hop.signal.addEventListener("abort", onAbort, { once: true });
    request.on("error", (error) => {
      if (response === undefined) settle();
      reject(error);
    });
    request.once("response", (arrived) => {
      response = arrived;
      arrived.on("error", () => undefined);
      arrived.once("close", settle);
      resolve(arrived);
    });
    request.end(hop.body);
  });
}

/**
 * The body of an answer as a stream that stops at the session's byte budget. Nothing is
 * buffered here: a server that sends without end is cut off when the budget is spent.
 */
function boundedBody(response: IncomingMessage, state: SessionState): ReadableStream<Uint8Array> {
  const chunks = response[Symbol.asyncIterator]();
  const stop = (reason: ConnectionCallReason, message?: string): Error => {
    const error = fail(state, reason, message);
    response.destroy();
    state.abort.abort();
    return error;
  };
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const step = await chunks.next();
        // The reader let go while this chunk was on its way: it belongs to nobody.
        if (cancelled) return;
        if (step.done === true) {
          controller.close();
          return;
        }
        const chunk: unknown = step.value;
        if (!(chunk instanceof Uint8Array)) {
          controller.error(stop("upstream_error"));
          return;
        }
        state.remainingBytes -= chunk.byteLength;
        if (state.remainingBytes < 0) {
          controller.error(stop("output_invalid", state.tooLarge));
          return;
        }
        controller.enqueue(chunk);
      } catch {
        if (cancelled) return;
        controller.error(
          stop(state.abort.signal.aborted ? "upstream_timeout" : "connection_unavailable")
        );
      }
    },
    async cancel() {
      cancelled = true;
      // What is left is read to its end and thrown away before the reader goes on, so the
      // socket serves its next request, unless it is more than a short rest or takes longer
      // than a short while. The end of the session ends the wait too.
      const late = setTimeout(() => response.destroy(), MCP_CLEANUP_TIMEOUT_MS);
      try {
        for (let read = 0; read <= MCP_DISCARD_MAX_BYTES;) {
          const step = await chunks.next();
          if (step.done === true) return;
          const chunk: unknown = step.value;
          read += chunk instanceof Uint8Array ? chunk.byteLength : MCP_DISCARD_MAX_BYTES + 1;
        }
      } catch {
        // The response ended with an error. Its socket goes with it.
      } finally {
        clearTimeout(late);
      }
      response.destroy();
    }
  });
}

function headerOf(response: IncomingMessage, name: string): string | undefined {
  const value = response.headers[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Lets go of an answer whose body nobody reads. A short body is read to its end and thrown
 * away, so the socket serves the next request. A longer one ends with its socket, and so
 * does one that is not over after MCP_CLEANUP_TIMEOUT_MS or when the session ends.
 */
function discard(response: IncomingMessage): void {
  let read = 0;
  const late = setTimeout(() => response.destroy(), MCP_CLEANUP_TIMEOUT_MS);
  response.once("close", () => clearTimeout(late));
  response.on("data", (chunk: unknown) => {
    read += chunk instanceof Uint8Array ? chunk.byteLength : MCP_DISCARD_MAX_BYTES + 1;
    if (read > MCP_DISCARD_MAX_BYTES) response.destroy();
  });
  response.resume();
}

/** The headers of the SDK's request that travel on: the protocol's own and nothing else. */
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "mcp-protocol-version"] as const;

/**
 * The `fetch` the SDK is given. It is the only way a request of a session leaves: egress
 * check, pinned address, credential for the Connection's origin only, redirects by hand.
 */
function pinnedFetch(
  context: ConnectorContext,
  sockets: McpSocketPool,
  state: SessionState
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    // The standalone stream of server messages is not opened. The answer the protocol has
    // for a server without one is given here, and no request leaves.
    if (method === "GET") return new Response(null, { status: 405 });
    if (method !== "POST" && method !== "DELETE") throw fail(state, "upstream_error");
    const body = init?.body ?? undefined;
    if (body !== undefined && typeof body !== "string") throw fail(state, "upstream_error");
    const sent = new Headers(init?.headers);

    let url = new URL(input);
    for (let redirects = 0; ; redirects += 1) {
      let grant: EgressGrant;
      let credential: ConnectionCredential | undefined;
      try {
        const target = egressTargetOfUrl(url.href);
        // The Connection's own origin is the target this call was opened with: it was
        // checked then, and the address the credential was resolved for is the address it
        // is sent to. A second check could answer another address of the same name. Every
        // other target is checked now.
        grant = isSameEgressOrigin(target, context.target)
          ? context.target
          : await context.checkEgress(target);
        // Asked for every hop anew. Nothing of the hop before is carried over.
        credential = credentialOrNone(context, grant);
      } catch (error) {
        throw fail(state, connectionCallReasonOf(error) ?? "connection_unavailable");
      }
      const own = grant === context.target;
      const headers: Record<string, string> = { host: hostHeaderOf(grant) };
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = sent.get(name);
        if (value !== null) headers[name] = value;
      }
      const sessionId = sent.get("mcp-session-id");
      if (own && sessionId !== null) headers["mcp-session-id"] = sessionId;
      if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
      // Last, so that nothing above stands in the place of a credential header.
      Object.assign(headers, credential?.headers);

      let response: IncomingMessage;
      try {
        response = await sendHop({
          url,
          grant,
          method,
          headers,
          body,
          // Another origin gets a socket for this one request. It is an agent of this file
          // either way, never the process's own, so no proxy of the environment is used.
          agent: own ? sockets.agentFor(context.connection.id, grant) : oneRequestAgent(grant),
          signal: state.abort.signal
        });
      } catch {
        throw fail(
          state,
          state.abort.signal.aborted ? "upstream_timeout" : "connection_unavailable"
        );
      }

      const status = response.statusCode ?? 0;
      if (status === 307 || status === 308) {
        const location = headerOf(response, "location");
        discard(response);
        if (location === undefined || redirects >= MCP_MAX_REDIRECTS) {
          throw fail(state, "upstream_error");
        }
        try {
          url = new URL(location, url);
        } catch {
          throw fail(state, "upstream_error");
        }
        continue;
      }
      if (status < 200 || status > 299) {
        // The body of a refusal is not kept. Its status is all that is taken from it.
        discard(response);
        // Ending a session is a courtesy. A server that refuses it fails nothing.
        if (method === "DELETE") return new Response(null, { status: 405 });
        throw fail(state, reasonOfStatus(status));
      }

      const answered = new Headers();
      const contentType = headerOf(response, "content-type");
      if (contentType !== undefined) answered.set("content-type", contentType);
      const newSession = headerOf(response, "mcp-session-id");
      if (newSession !== undefined) {
        if (newSession.length > MCP_SESSION_ID_MAX_CHARS || !SESSION_ID_PATTERN.test(newSession)) {
          response.destroy();
          throw fail(state, "upstream_error");
        }
        if (own) answered.set("mcp-session-id", newSession);
      }
      if (status === 204 || status === 205) {
        discard(response);
        return new Response(null, { status, headers: answered });
      }
      return new Response(boundedBody(response, state), { status, headers: answered });
    }
  };
}

/** The one reason a failed session is told as. Nothing of the error's text is kept. */
function reasonOf(
  error: unknown,
  state: SessionState,
  deadline: AbortSignal
): ConnectionCallReason {
  if (state.reason !== undefined) return state.reason;
  const own = connectionCallReasonOf(error);
  if (own !== undefined) return own;
  if (deadline.aborted) return "upstream_timeout";
  if (error instanceof McpError && error.code === Number(ErrorCode.RequestTimeout)) {
    return "upstream_timeout";
  }
  return "upstream_error";
}

/**
 * Opens a session with the Connection's server, runs `work` in it and ends it. Every failure
 * leaves as `connectionCallError(reason)`: of the egress check, of the network, of the
 * server, of a bound.
 */
export async function withMcpSession<Result>(
  input: {
    context: ConnectorContext;
    sockets: McpSocketPool;
    bounds: McpSessionBounds;
    /** The address of the server, from the Connection's settings. */
    url: string;
  },
  work: (session: McpSession) => Promise<Result>
): Promise<Result> {
  const { context, sockets, bounds } = input;
  const state: SessionState = {
    reason: undefined,
    message: undefined,
    remainingBytes: bounds.maxResponseBytes,
    tooLarge: bounds.tooLarge,
    abort: new AbortController()
  };
  const deadline = AbortSignal.any([context.signal, AbortSignal.timeout(bounds.timeoutMs)]);
  const onDeadline = () => state.abort.abort();
  deadline.addEventListener("abort", onDeadline, { once: true });
  if (deadline.aborted) onDeadline();

  const transport = new StreamableHTTPClientTransport(new URL(input.url), {
    fetch: pinnedFetch(context, sockets, state),
    // A stream that ends early is not resumed: the call fails within its own time.
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1
    }
  });
  const client = new Client(CLIENT_INFO, {
    capabilities: {},
    // The SDK compiles no schema of the server. Schemas are compiled by the platform's own
    // JSON Schema module, or not at all.
    jsonSchemaValidator: {
      getValidator() {
        throw new Error("The MCP client compiles no schema");
      }
    }
  });
  // What the SDK reports here can hold text of the server. It is not kept.
  client.onerror = () => undefined;
  const options = { signal: state.abort.signal, timeout: bounds.timeoutMs };

  try {
    await client.connect(transport, options);
    return await work({
      async listTools(cursor) {
        const page = await client.request(
          { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
          toolsPageSchema,
          options
        );
        return {
          tools: page.tools,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
        };
      },
      async callTool(name, toolInput) {
        const result = await client.request(
          { method: "tools/call", params: { name, arguments: toolInput } },
          toolResultSchema,
          options
        );
        return {
          content: result.content ?? [],
          structuredContent: result.structuredContent,
          isError: result.isError === true
        };
      }
    });
  } catch (error) {
    const reason = reasonOf(error, state, deadline);
    // An error of this package's own making keeps its sentence. Any other error is told as
    // its reason alone.
    if (state.reason === undefined && isAppError(error) && connectionCallReasonOf(error)) {
      throw error;
    }
    throw connectionCallError(reason, state.reason === reason ? state.message : undefined);
  } finally {
    // A server that keeps sessions is told this one is over, and its answer changes nothing.
    // The end has a short time of its own, inside the session's: a server that never answers
    // holds neither the call nor its socket, and the caller's signal ends the wait at once.
    const ending = AbortSignal.any([deadline, AbortSignal.timeout(MCP_CLEANUP_TIMEOUT_MS)]);
    ending.addEventListener("abort", onDeadline, { once: true });
    if (transport.sessionId !== undefined && !state.abort.signal.aborted) {
      await transport.terminateSession().catch(() => undefined);
    }
    await client.close().catch(() => undefined);
    ending.removeEventListener("abort", onDeadline);
    deadline.removeEventListener("abort", onDeadline);
    state.abort.abort();
  }
}
