import type { HttpRuntime } from "@vivd-catalyst/core";

/**
 * What the runtime needs from the server it wraps. A service hands its web framework's server
 * in; the framework's own types stay out of every public declaration.
 */
export interface InProcessHttpServer {
  inject(request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload?: Buffer;
    signal?: AbortSignal;
    payloadAsStream: true;
  }): Promise<{
    statusCode: number;
    headers: Record<string, number | string | string[] | undefined>;
    stream(): AsyncIterable<Uint8Array>;
  }>;
  listen(input: { host: string; port: number }): Promise<string>;
  close(): Promise<unknown>;
}

const BODILESS_STATUS = new Set([101, 204, 205, 304]);

/** The public face of an HTTP service: answer in process, listen, close. */
export function createHttpRuntime(server: InProcessHttpServer): HttpRuntime {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
      const response = await server.inject({
        method: request.method,
        url: `${url.pathname}${url.search}`,
        headers: { host: url.host, ...Object.fromEntries(request.headers) },
        ...(body ? { payload: body } : {}),
        signal: request.signal,
        payloadAsStream: true
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
          headers.append(name, String(item));
        }
      }
      const bodiless = request.method === "HEAD" || BODILESS_STATUS.has(response.statusCode);
      const stream = response.stream();
      if (bodiless) {
        for await (const _chunk of stream) {
          // Drained so the framework can finish the reply.
        }
      }
      return new Response(bodiless ? null : toWebStream(stream), {
        status: response.statusCode,
        headers
      });
    },
    listen(input = {}) {
      return server.listen({ host: input.host ?? "127.0.0.1", port: input.port ?? 0 });
    },
    async close() {
      await server.close();
    }
  };
}

function toWebStream(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
    async cancel() {
      await iterator.return?.();
    }
  });
}
