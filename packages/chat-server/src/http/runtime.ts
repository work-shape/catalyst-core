import { Readable } from "node:stream";
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
    payload?: Readable;
    payloadAsStream: true;
  }): Promise<{
    statusCode: number;
    headers: Record<string, number | string | string[] | undefined>;
    stream(): AsyncIterable<Uint8Array>;
    /** The reply the server is writing. Destroying it stops whatever produces the body. */
    raw: { res: { destroy(): unknown } };
  }>;
  listen(input: { host: string; port: number }): Promise<string>;
  close(): Promise<unknown>;
}

const BODILESS_STATUS = new Set([101, 204, 205, 304]);

/** The public face of an HTTP service: answer in process, listen, close. */
export function createHttpRuntime(server: InProcessHttpServer): HttpRuntime {
  return {
    async fetch(request) {
      const { signal } = request;
      signal.throwIfAborted();
      const url = new URL(request.url);
      // Handed on as a stream, so the server's own body limit stops an oversized body while
      // it is read.
      const body = request.body ? toNodeStream(request.body) : undefined;
      // Without a listener a body that fails after the server stopped reading would be an
      // uncaught error.
      body?.on("error", () => undefined);
      const injected = server.inject({
        method: request.method,
        url: `${url.pathname}${url.search}`,
        headers: {
          host: url.host,
          // A body of unknown length is announced, as it is on the wire.
          ...(body && !request.headers.has("content-length")
            ? { "transfer-encoding": "chunked" }
            : {}),
          ...Object.fromEntries(request.headers),
          // The request's own scheme. The server trusts it as it trusts a local proxy.
          "x-forwarded-proto": url.protocol.slice(0, -1)
        },
        ...(body ? { payload: body } : {}),
        payloadAsStream: true
      });
      // The server is not told of the abort through its injection: that fails the reply in
      // the middle of a write. The reply is destroyed instead, as a closed connection is.
      const aborted = new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signalReason(signal)), { once: true });
      });
      aborted.catch(() => undefined);
      let response: Awaited<typeof injected>;
      try {
        response = await Promise.race([injected, aborted]);
      } catch (error) {
        body?.destroy();
        void injected.then(
          (late) => late.raw.res.destroy(),
          () => undefined
        );
        throw error;
      }
      // What the server left unread of the body is not read for it.
      body?.destroy();
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
      return new Response(
        bodiless ? null : toWebStream(stream, () => response.raw.res.destroy(), signal),
        { status: response.statusCode, headers }
      );
    },
    listen(input = {}) {
      return server.listen({ host: input.host ?? "127.0.0.1", port: input.port ?? 0 });
    },
    async close() {
      await server.close();
    }
  };
}

/** The request's body, read as the server asks for it and cancelled when it stops asking. */
function toNodeStream(source: ReadableStream<Uint8Array>): Readable {
  const reader = source.getReader();
  return new Readable({
    read() {
      reader.read().then(
        (next) => this.push(next.done ? null : next.value),
        (error: unknown) => this.destroy(error instanceof Error ? error : new Error(String(error)))
      );
    },
    destroy(error, callback) {
      reader.cancel().then(
        () => callback(error),
        () => callback(error)
      );
    }
  });
}

function signalReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/**
 * The reply's body as a web stream. Cancelling it, or aborting the request, destroys the
 * reply, which stops the producer behind it.
 */
function toWebStream(
  source: AsyncIterable<Uint8Array>,
  destroyReply: () => void,
  signal: AbortSignal
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let stopped = false;
  function stop(): void {
    if (stopped) {
      return;
    }
    stopped = true;
    destroyReply();
    // The source ends with an error once the reply is gone. Nobody is left to read it.
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
  return new ReadableStream({
    start(controller) {
      const onAbort = (): void => {
        stop();
        controller.error(signalReason(signal));
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    },
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (stopped) {
          return;
        }
        if (next.done) {
          stopped = true;
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (!stopped) {
          stopped = true;
          controller.error(error);
        }
      }
    },
    cancel() {
      stop();
    }
  });
}
