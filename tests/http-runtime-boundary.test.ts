import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { apiOperations } from "@vivd-catalyst/api-contract";
import type { Logger } from "@vivd-catalyst/core";
import { createTestConfig } from "./support/fixtures";
import {
  addTestRoute,
  createTestInstance,
  createTestInstanceWith,
  getTestRuntime,
  type TestInstance
} from "./support/test-instance";

describe("the public runtime boundary", () => {
  async function exerciseLifecycle(instance: TestInstance): Promise<void> {
    const runtime = await getTestRuntime(instance);
    const inProcess = await runtime.fetch(new Request("http://instance.test/health"));
    expect(inProcess.status).toBe(200);
    expect(await inProcess.json()).toMatchObject({ status: "ok" });
    const missing = await runtime.fetch(
      new Request("http://instance.test/api/v1/nothing", { method: "POST", body: "{}" })
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

    const url = await runtime.listen({ host: "127.0.0.1", port: 0 });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect((await fetch(`${url}/health`)).status).toBe(200);

    await instance.close();
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  }

  it("stops the producer of a streamed answer that is aborted or cancelled", async () => {
    const errors: unknown[] = [];
    const onError = (error: unknown): void => {
      errors.push(error);
    };
    process.on("uncaughtException", onError);
    process.on("unhandledRejection", onError);
    const instance = await createTestInstance({ config: createTestConfig(), tools: [] });
    let running = 0;
    addTestRoute(instance, "/stream", (_request, reply) =>
      reply.header("content-type", "text/plain").send(
        Readable.from(
          (async function* produce() {
            running += 1;
            try {
              for (;;) {
                yield "chunk\n";
                await delay(5);
              }
            } finally {
              running -= 1;
            }
          })()
        )
      )
    );
    const runtime = await getTestRuntime(instance);
    try {
      const abort = new AbortController();
      const aborted = await runtime.fetch(
        new Request("http://instance.test/stream", { signal: abort.signal })
      );
      const abortedReader = aborted.body?.getReader();
      expect(new TextDecoder().decode((await abortedReader?.read())?.value)).toContain("chunk");
      expect(running).toBe(1);
      abort.abort();
      await expect(abortedReader?.read()).rejects.toMatchObject({ name: "AbortError" });
      await expect.poll(() => running).toBe(0);

      const cancelled = await runtime.fetch(new Request("http://instance.test/stream"));
      const cancelledReader = cancelled.body?.getReader();
      await cancelledReader?.read();
      expect(running).toBe(1);
      await cancelledReader?.cancel();
      await expect.poll(() => running).toBe(0);

      // A request aborted before it is sent is not answered.
      await expect(
        runtime.fetch(new Request("http://instance.test/stream", { signal: AbortSignal.abort() }))
      ).rejects.toMatchObject({ name: "AbortError" });
      // The server is still there, and nothing was thrown past it.
      expect((await runtime.fetch(new Request("http://instance.test/health"))).status).toBe(200);
      expect(errors).toEqual([]);
    } finally {
      process.off("uncaughtException", onError);
      process.off("unhandledRejection", onError);
    }
  });

  it("closes an upload that is aborted before it is all sent", async () => {
    const completed: string[] = [];
    const logger: Logger = {
      debug() {},
      info(_input, message) {
        if (message === "request completed") {
          completed.push(message);
        }
      },
      warn() {},
      error() {},
      child: () => logger
    };
    const runtime = await getTestRuntime(await createTestInstanceWith(() => ({ logger })));
    const before = completed.length;
    let cancelled = false;
    // A body that sends its first part and then never goes on.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"token":"'));
      },
      cancel() {
        cancelled = true;
      }
    });
    const abort = new AbortController();
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
      signal: abort.signal
    };
    const answered = runtime.fetch(
      new Request(`http://instance.test${apiOperations["password_setup.complete"].path}`, init)
    );
    const outcome = answered.then(
      () => "answered",
      (error: unknown) => (error instanceof Error ? error.name : "failed")
    );
    await delay(20);
    abort.abort();
    expect(await outcome).toBe("AbortError");
    await expect.poll(() => cancelled).toBe(true);
    // The server has let go of the request too: it has finished it.
    await expect.poll(() => completed.length).toBe(before + 1);
  });

  it("stops reading a body at the server's limit", async () => {
    const runtime = await getTestRuntime(await createTestInstance());
    const chunk = new Uint8Array(64 * 1024);
    let pulled = 0;
    let cancelled = false;
    // Thirty megabytes, of which the server accepts one.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 480) {
          controller.close();
        } else {
          controller.enqueue(chunk);
        }
      },
      cancel() {
        cancelled = true;
      }
    });
    // A streamed request body needs `duplex`, which the DOM types lack.
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half"
    };
    const response = await runtime.fetch(
      new Request(`http://instance.test${apiOperations["password_setup.complete"].path}`, init)
    );
    expect(response.ok).toBe(false);
    expect(pulled).toBeLessThan(64);
    await expect.poll(() => cancelled).toBe(true);
  });

  it("answers in process, listens and closes as a chat server", async () => {
    await exerciseLifecycle(await createTestInstance());
  });

  it("answers in process, listens and closes as an assembled instance", async () => {
    await exerciseLifecycle(await createTestInstance({ config: createTestConfig(), tools: [] }));
  });

  it.each(["chat-server", "client-assembly", "core"])(
    "keeps the web framework out of the built declarations of %s",
    async (name) => {
      const declarations = await readFile(
        new URL(`../packages/${name}/dist/index.d.ts`, import.meta.url),
        "utf8"
      );
      expect(declarations).toContain("HttpRuntime");
      expect(declarations).not.toMatch(/fastify|light-my-request/iu);
    }
  );
});
