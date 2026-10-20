import type { EgressGrant } from "@work-shape/catalyst-core";
import {
  hostHeaderOf,
  oneRequestAgent,
  sendPinnedRequest,
  type PinnedRequest
} from "../pinned-request";

/** HTTP boundary for binary sources. Reads never consume more than the requested byte count. */
export interface SourceHttpResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  read(maxBytes: number): Promise<Uint8Array | undefined>;
  close(): void;
}
export interface SourceHttpRequest {
  url: URL;
  grant: EgressGrant;
  method: PinnedRequest["method"];
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}
export type SourceHttpTransport = (input: SourceHttpRequest) => Promise<SourceHttpResponse>;

/** Pinned DNS, verified TLS, no automatic redirects and a fresh agent per request. */
export const sourceHttpTransport: SourceHttpTransport = async (input) => {
  const agent = oneRequestAgent(input.grant);
  try {
    const response = await sendPinnedRequest({
      ...input,
      body: input.body,
      agent,
      headers: { ...input.headers, host: hostHeaderOf(input.grant) }
    });
    const headers: Record<string, string | undefined> = {};
    for (const name of ["location", "content-length", "retry-after"]) {
      const value = response.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    return {
      status: response.statusCode ?? 0,
      headers,
      async read(maxBytes) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid read size");
        for (;;) {
          input.signal.throwIfAborted();
          const chunk: unknown = response.read(
            Math.min(maxBytes, response.readableLength || maxBytes)
          );
          if (chunk instanceof Uint8Array) return chunk;
          if (response.readableEnded) return undefined;
          if (response.destroyed) throw new Error("The source stream ended early");
          await new Promise<void>((resolve, reject) => {
            const clean = () => {
              response.off("readable", ready);
              response.off("end", ready);
              response.off("close", ready);
              response.off("error", failed);
            };
            const ready = () => {
              clean();
              resolve();
            };
            const failed = () => {
              clean();
              reject(new Error("The source stream failed"));
            };
            response.once("readable", ready);
            response.once("end", ready);
            response.once("close", ready);
            response.once("error", failed);
          });
        }
      },
      close() {
        response.destroy();
        agent.destroy();
      }
    };
  } catch (error) {
    agent.destroy();
    throw error;
  }
};
