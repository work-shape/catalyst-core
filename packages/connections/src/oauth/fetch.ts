import type { IncomingMessage } from "node:http";
import {
  connectionCallError,
  connectionCallReasonOf,
  type EgressChecker,
  type EgressGrant
} from "@work-shape/catalyst-core";
import { egressTargetOfUrl } from "../egress";
import { hostHeaderOf, oneRequestAgent, sendPinnedRequest } from "../pinned-request";

// The one way a request of the OAuth flow leaves the instance: metadata reads, registration,
// code exchange, refresh and revocation. Each request is checked by the egress checker before
// anything is sent, so a host the list does not admit is refused before a code or any client
// data leaves, and the refusal names the host. The request goes to the address the check
// pinned, with an agent of its own. No redirect is followed: the answer carries no
// `Location`, so the SDK's same-origin follower has nothing to follow either.

/** The headers of a request of the flow that travel on. Everything else is dropped. */
const FORWARDED_HEADERS = ["accept", "authorization", "content-type", "mcp-protocol-version"];

/** The largest answer of an authorization server the flow reads: metadata, token, registration. */
export const OAUTH_RESPONSE_MAX_BYTES = 64 * 1024;
/** How long one request of the flow may take. */
export const OAUTH_REQUEST_TIMEOUT_MS = 10_000;

/** A `fetch` of the flow: what the SDK's auth functions are handed. */
export type OAuthFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** One request as it left, for a caller that keeps count. Never a header value or a body. */
export interface OAuthRequestRecord {
  method: "GET" | "POST";
  host: string;
  path: string;
}

export interface OAuthFetchOptions {
  /** Only its check is asked: a Connector's context hands that alone. */
  egress: Pick<EgressChecker, "check">;
  /** Ends every request of the flow: the caller's deadline or cancellation. */
  signal: AbortSignal;
  maxResponseBytes?: number;
  timeoutMs?: number;
  /** Told each request after its target passed the check and before it is sent. */
  onRequest?(request: OAuthRequestRecord): void;
}

function bodyOf(body: RequestInit["body"]): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  // The flow sends text and form bodies only.
  throw connectionCallError("upstream_error", "the flow sends no body of this kind");
}

function headerOf(response: IncomingMessage, name: string): string | undefined {
  const value = response.headers[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * The body of an answer as a stream that stops at `maxBytes`. A server that sends more is cut
 * off, and the reader fails with `output_invalid`.
 */
function boundedBody(
  response: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal
): ReadableStream<Uint8Array> {
  const chunks = response[Symbol.asyncIterator]();
  let remaining = maxBytes;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const step = await chunks.next();
        if (step.done === true) {
          controller.close();
          return;
        }
        const chunk: unknown = step.value;
        if (!(chunk instanceof Uint8Array)) {
          response.destroy();
          controller.error(connectionCallError("upstream_error"));
          return;
        }
        remaining -= chunk.byteLength;
        if (remaining < 0) {
          response.destroy();
          controller.error(
            connectionCallError(
              "output_invalid",
              "the authorization server's answer is larger than the flow reads"
            )
          );
          return;
        }
        controller.enqueue(chunk);
      } catch {
        controller.error(
          connectionCallError(signal.aborted ? "upstream_timeout" : "connection_unavailable")
        );
      }
    },
    cancel() {
      response.destroy();
    }
  });
}

/**
 * Makes the `fetch` of one step of the flow. Every request is checked, pinned, bounded and
 * ends with the step's signal or after `timeoutMs`. A refusal of the egress checker leaves as
 * it is, `egress_denied` with the host; every other failure leaves as one reason.
 */
export function createOAuthFetch(options: OAuthFetchOptions): OAuthFetch {
  const maxBytes = options.maxResponseBytes ?? OAUTH_RESPONSE_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? OAUTH_REQUEST_TIMEOUT_MS;
  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      throw connectionCallError("upstream_error", "the flow sends GET and POST only");
    }
    const url = new URL(input);
    const body = bodyOf(init?.body);
    // Checked before anything of the request is written: a refused host is sent nothing.
    const grant: EgressGrant = await options.egress.check(egressTargetOfUrl(url.href));
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
    if (signal.aborted) throw connectionCallError("upstream_timeout");

    const sent = new Headers(init?.headers);
    const headers: Record<string, string> = { host: hostHeaderOf(grant) };
    for (const name of FORWARDED_HEADERS) {
      const value = sent.get(name);
      if (value !== null) headers[name] = value;
    }
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    options.onRequest?.({ method, host: grant.host, path: url.pathname });

    const agent = oneRequestAgent(grant);
    let response: IncomingMessage;
    try {
      response = await sendPinnedRequest({
        url,
        grant,
        method,
        headers,
        body,
        agent,
        signal
      });
    } catch (error) {
      agent.destroy();
      if (connectionCallReasonOf(error) !== undefined) throw error;
      throw connectionCallError(signal.aborted ? "upstream_timeout" : "connection_unavailable");
    }
    response.once("close", () => agent.destroy());

    const status = response.statusCode ?? 0;
    const answered = new Headers();
    const contentType = headerOf(response, "content-type");
    if (contentType !== undefined) answered.set("content-type", contentType);
    if (status < 200 || status > 599) {
      response.destroy();
      return new Response(null, { status: 502, headers: answered });
    }
    // A redirect is answered as its status alone: nothing names where it points.
    if ((status >= 300 && status < 400) || status === 204 || status === 205) {
      response.destroy();
      return new Response(null, { status, headers: answered });
    }
    return new Response(boundedBody(response, maxBytes, signal), { status, headers: answered });
  };
}
