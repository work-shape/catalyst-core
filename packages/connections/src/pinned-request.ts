import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { EgressGrant } from "@vivd-catalyst/core";
import { pinnedLookup } from "./egress";

// One HTTP request of a Connector type to a target the egress checker granted. Where it goes
// is read from the grant alone: protocol, host, port and the checked address. Of the address
// the request was made for, only path and query are used. The agent is the caller's own, so
// the process's agent and a proxy of the environment are never used. No redirect is followed
// here: the caller reads the status and decides.

/** The agent a request travels with: kept by its type, or one of this request alone. */
export type ConnectorAgent = HttpAgent | HttpsAgent;

export interface PinnedRequest {
  url: URL;
  grant: EgressGrant;
  method: "GET" | "POST" | "DELETE";
  headers: Record<string, string>;
  body: string | undefined;
  agent: ConnectorAgent;
  /** Ends the request, and the answer while it is read. */
  signal: AbortSignal;
}

const DEFAULT_PORTS = { https: 443, http: 80 } as const;

/** The `Host` of a request, written from the checked target and from nothing else. */
export function hostHeaderOf(grant: EgressGrant): string {
  const host = isIP(grant.host) === 6 ? `[${grant.host}]` : grant.host;
  const usual = grant.protocol === "https" ? DEFAULT_PORTS.https : DEFAULT_PORTS.http;
  return grant.port === usual ? host : `${host}:${grant.port}`;
}

/** An agent for one request. Whoever makes it destroys it when the request is over. */
export function oneRequestAgent(grant: EgressGrant): ConnectorAgent {
  return grant.protocol === "https" ? new HttpsAgent() : new HttpAgent();
}

/**
 * Sends one request to the pinned address and answers once the status line arrived. Where
 * it goes is read from the checked target alone: protocol, host, port and address. Of the
 * address the server was configured or redirected with, only path and query are used.
 */
export function sendPinnedRequest(hop: PinnedRequest): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (hop.signal.aborted) {
      reject(new Error("The request ended"));
      return;
    }
    const literal = isIP(hop.grant.host) !== 0;
    const options = {
      protocol: `${hop.grant.protocol}:`,
      // A name is resolved by the pinned lookup only. A literal address is the pinned one.
      host: literal ? hop.grant.address : hop.grant.host,
      port: hop.grant.port,
      path: `${hop.url.pathname}${hop.url.search}`,
      method: hop.method,
      headers: hop.headers,
      lookup: pinnedLookup(hop.grant),
      agent: hop.agent
    };
    // The name the server's certificate is verified against is the checked host, said here
    // and derived from no header. A literal address names itself: no name is sent, and the
    // certificate is verified against the address.
    const request =
      hop.grant.protocol === "https"
        ? httpsRequest({ ...options, servername: literal ? "" : hop.grant.host })
        : httpRequest(options);
    // The signal is watched here and not handed to the request: a request that is ended
    // through its own signal reports that on streams nobody listens to any more, and an
    // error without a listener ends the process.
    let response: IncomingMessage | undefined;
    const onAbort = () => {
      response?.destroy();
      request.destroy(new Error("The request ended"));
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
