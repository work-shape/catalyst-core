import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "@work-shape/catalyst-core";
import {
  ModelProviderError,
  modelProviderDefinitions,
  type ModelAdapterFactory
} from "@work-shape/catalyst-model-provider";
import { conformanceAdapters } from "./support/model-adapter-recordings";
import { silentTestLogger } from "./support/model-gateway";

/**
 * No model adapter follows a redirect: the credential and the conversation go to the configured
 * endpoint and to no host that endpoint names. The answer with status 3xx fails the call as a
 * request the provider refused, which is not sent again.
 */

const ELSEWHERE = "https://elsewhere.example.test/collect";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const request = { messages: [{ role: "user" as const, content: "Say hello." }], tools: [] };

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A `fetch` that answers every model request with a redirect and behaves as `fetch` does: it
 * follows the redirect unless the request forbids it. Returns the hosts that were asked.
 */
function redirectingFetch(redirectTokenRequest = false): string[] {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === TOKEN_URL && !redirectTokenRequest) {
      return Response.json({ access_token: "token", expires_in: 3600, token_type: "Bearer" });
    }
    asked.push(new URL(url).host);
    if (init?.redirect === "error") throw new TypeError("fetch failed");
    if (init?.redirect !== "manual") {
      asked.push(new URL(ELSEWHERE).host);
      return Response.json({ followed: true });
    }
    return new Response(null, { status: 307, headers: { location: ELSEWHERE } });
  });
  return asked;
}

describe.each(conformanceAdapters)("$type adapter and a redirect", (adapter) => {
  it("fails a request that is answered with a redirect, and asks no other host", async () => {
    const asked = redirectingFetch();
    const created = await adapter.create();
    const model = adapter.provider.model;

    const failures = [
      await created.complete({ model, ...request }).catch((error: unknown) => error),
      await (async () => {
        for await (const _event of created.stream({ model, ...request })) void _event;
      })().catch((error: unknown) => error)
    ];

    for (const failure of failures) {
      expect(failure).toBeInstanceOf(ModelProviderError);
      expect(failure).toMatchObject({ kind: "invalid_request", status: 307, retryable: false });
    }
    expect(asked).toHaveLength(2);
    expect(new Set(asked).size).toBe(1);
    expect(asked).not.toContain("elsewhere.example.test");
  });

  it("does not follow a redirect of the provider check", async () => {
    const asked = redirectingFetch(true);

    const result = await adapter.check();

    expect(result).toMatchObject({ ok: false });
    expect(asked).not.toContain("elsewhere.example.test");
  });
});

describe("google-vertex adapter and a redirect of the token request", () => {
  it("does not send the signed assertion to another host", async () => {
    const asked = redirectingFetch(true);
    const vertex = conformanceAdapters.find((adapter) => adapter.type === "google-vertex");
    if (!vertex) throw new Error("No Vertex adapter");
    const created = await vertex.create();

    const failure = await created
      .complete({ model: vertex.provider.model, ...request })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(asked).toEqual([new URL(TOKEN_URL).host]);
  });
});

describe("openai-compatible adapter and a redirect on the wire", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  });
  const listen = async (handler: Parameters<typeof createServer>[1]): Promise<string> => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("The server has no address");
    }
    return `http://127.0.0.1:${address.port}`;
  };

  it("keeps the key from the host a real redirect names", async () => {
    const received: (string | undefined)[] = [];
    const elsewhere = await listen((incoming, response) => {
      received.push(incoming.headers.authorization);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const endpoint = await listen((_incoming, response) => {
      // 307 keeps the method and the body, so a client that follows it sends the conversation on.
      response.writeHead(307, { location: `${elsewhere}/v1/chat/completions` }).end();
    });
    const factory = await createProvider<"models", ModelAdapterFactory>(
      modelProviderDefinitions,
      "models",
      {
        path: "infrastructure.models.main",
        entry: {
          provider: "openai-compatible",
          region: "eu",
          model: "local-model",
          baseUrl: `${endpoint}/v1`,
          credentialSecret: "MODEL_KEY"
        }
      },
      { secrets: { resolve: async () => "test-model-key" }, logger: silentTestLogger }
    );
    const adapter = factory({
      id: "main",
      type: "openai-compatible",
      region: "eu",
      model: "local-model"
    });

    const failure = await adapter
      .complete({ model: "local-model", ...request })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ kind: "invalid_request", status: 307, retryable: false });
    expect(received).toEqual([]);
  });
});
