import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { materializeModelTools } from "@vivd-catalyst/agent-runtime";
import { createClientInstanceApp } from "@vivd-catalyst/client-assembly";
import { AppError } from "@vivd-catalyst/core";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  createWebFetchTool,
  DirectWebFetcher,
  nodeWebFetchHttpRequest,
  type WebFetchAddressResolver,
  type WebFetchHttpRequest,
  validateWebFetchUrl
} from "../packages/web-access/src/index";

describe("web access direct fetch", () => {
  it("extracts bounded text and source metadata from allowed HTML pages", async () => {
    const requests: Parameters<WebFetchHttpRequest>[0][] = [];
    const fetcher = new DirectWebFetcher({
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      resolver: resolvePublicExample,
      request: async (input) => {
        requests.push(input);
        return {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8"
          },
          body: Buffer.from(
            "<!doctype html><title>Example</title><h1>Hello&nbsp;world</h1><script>ignored()</script>"
          ),
          bytesRead: 92,
          truncatedByBytes: false
        };
      }
    });

    const output = await fetcher.fetch({ url: "https://example.com/page" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.toString()).toBe("https://example.com/page");
    expect(requests[0]?.address.address).toBe("93.184.216.34");
    expect(output).toMatchObject({
      finalUrl: "https://example.com/page",
      title: "Example",
      contentType: "text/html; charset=utf-8",
      bytes: 92,
      text: "Example Hello world",
      truncated: false,
      redirectCount: 0,
      source: {
        url: "https://example.com/page",
        title: "Example",
        provider: "direct",
        retrievedAt: "2026-01-02T03:04:05.000Z"
      }
    });
    expect(output.source.id).toMatch(/^web_[a-f0-9]{16}$/u);
  });

  it("blocks hosts that resolve to private network addresses", async () => {
    const fetcher = new DirectWebFetcher({
      resolver: async () => [{ address: "10.0.0.4", family: 4 }],
      request: async () => {
        throw new Error("request should not run for blocked addresses");
      }
    });

    await expect(fetcher.fetch({ url: "https://internal.example" })).rejects.toMatchObject({
      code: "validation_failed",
      metadata: expect.objectContaining({
        reason: "blocked_url"
      })
    });
  });

  it("validates redirect targets before following them", async () => {
    let requestCount = 0;
    const fetcher = new DirectWebFetcher({
      resolver: resolvePublicExample,
      request: async () => {
        requestCount += 1;
        return {
          status: 302,
          headers: {
            location: "http://localhost/admin"
          },
          body: new Uint8Array(),
          bytesRead: 0,
          truncatedByBytes: false
        };
      }
    });

    await expect(fetcher.fetch({ url: "https://example.com/start" })).rejects.toMatchObject({
      code: "validation_failed",
      metadata: expect.objectContaining({
        reason: "blocked_url",
        redirectCount: 1
      })
    });
    expect(requestCount).toBe(1);
  });

  it("caps response bytes and returned text characters", async () => {
    const requestMaxBytes: number[] = [];
    const fetcher = new DirectWebFetcher({
      config: {
        maxResponseBytes: 4,
        maxTextCharacters: 3
      },
      resolver: resolvePublicExample,
      request: async (input) => {
        requestMaxBytes.push(input.maxBytes);
        return {
          status: 200,
          headers: {
            "content-type": "text/plain"
          },
          body: Buffer.from("abcdef"),
          bytesRead: 4,
          truncatedByBytes: true
        };
      }
    });

    const output = await fetcher.fetch({
      url: "https://example.com/plain",
      maxCharacters: 20
    });

    expect(requestMaxBytes).toEqual([4]);
    expect(output.text).toBe("abc");
    expect(output.truncated).toBe(true);
    expect(output.bytes).toBe(4);
  });

  it("rejects encoded responses instead of trying to decompress them", async () => {
    const fetcher = new DirectWebFetcher({
      resolver: resolvePublicExample,
      request: async () => ({
        status: 200,
        headers: {
          "content-type": "text/html",
          "content-encoding": "gzip"
        },
        body: Buffer.from("compressed"),
        bytesRead: 10,
        truncatedByBytes: false
      })
    });

    await expect(fetcher.fetch({ url: "https://example.com/compressed" })).rejects.toMatchObject({
      code: "validation_failed",
      metadata: expect.objectContaining({
        reason: "unsupported_content_encoding"
      })
    });
  });

  it("bounds DNS resolution with the fetch timeout", async () => {
    const fetcher = new DirectWebFetcher({
      config: {
        timeoutMs: 1
      },
      resolver: async () => new Promise(() => undefined),
      request: async () => {
        throw new Error("request should not run while DNS is unresolved");
      }
    });

    await expect(fetcher.fetch({ url: "https://example.com/hangs" })).rejects.toMatchObject({
      resultStatus: "timed_out",
      code: "timed_out"
    });
  });
});

describe("web access HTTP adapter", () => {
  it("rejects unsupported response headers before collecting body bytes", async () => {
    const server = createServer((_request, response) => {
      response.on("error", () => undefined);
      response.writeHead(200, {
        "content-type": "application/pdf"
      });
      response.flushHeaders();
      bodyWriteTimer = setTimeout(() => {
        bodyWriteAttempted = true;
        response.end(Buffer.alloc(1024 * 1024));
      }, 50);
    });
    let bodyWriteAttempted = false;
    let bodyWriteTimer: ReturnType<typeof setTimeout> | undefined;

    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected test server to listen on a TCP port");
      }

      const response = await nodeWebFetchHttpRequest({
        url: new URL(`http://example.com:${address.port}/file.pdf`),
        address: {
          address: "127.0.0.1",
          family: 4
        },
        maxBytes: 64,
        signal: new AbortController().signal
      });

      expect(response.bytesRead).toBe(0);
      expect(response.body).toHaveLength(0);
      expect(bodyWriteAttempted).toBe(false);
    } finally {
      if (bodyWriteTimer) {
        clearTimeout(bodyWriteTimer);
      }
      await close(server);
    }
  });
});

describe("web access tool", () => {
  it("redacts credential-bearing URLs from failure audit summaries", async () => {
    const tool = createWebFetchTool({ config: {} });

    const result = await tool.execute(
      {
        url: "https://user:secret@example.com/path"
      },
      {} as Parameters<typeof tool.execute>[1]
    );

    expect(result.status).toBe("failed");
    expect(result.auditSummary?.subject).toBe("https://example.com/path");
    expect(JSON.stringify(result.auditSummary)).not.toContain("user");
    expect(JSON.stringify(result.auditSummary)).not.toContain("secret");
  });
});

describe("web access URL safety", () => {
  it("allows only http and https URLs", async () => {
    await expect(validateWebFetchUrl("file:///etc/passwd")).rejects.toThrow(
      /Only http and https URLs are allowed/u
    );
  });

  it("allows only default web ports", async () => {
    await expect(validateWebFetchUrl("https://example.com:8443")).rejects.toThrow(
      /Only default http and https ports are allowed/u
    );
  });

  it("blocks metadata hostnames and literal local addresses", async () => {
    await expect(validateWebFetchUrl("http://metadata.google.internal/latest")).rejects.toThrow(
      /metadata host/u
    );
    await expect(validateWebFetchUrl("http://127.0.0.1")).rejects.toThrow(/blocked/u);
  });
});

describe("web access app assembly", () => {
  it("keeps web search disabled by default in release config", () => {
    const config = createTestConfig();

    expect(config.webAccess).toMatchObject({
      enabled: false,
      search: {
        enabled: false,
        mode: "native_or_managed"
      },
      fetch: {
        enabled: false
      }
    });
  });

  it("does not expose web_fetch unless web access fetch is enabled", async () => {
    await expectAppAssemblyInvalid(
      createTestConfig({
        toolNames: ["web_fetch"],
        tools: [{ name: "web_fetch", enabled: true }]
      }),
      "Agent 'test_agent' references tool 'web_fetch' with no registered implementation"
    );
  });

  it("does not expose web_fetch when the top-level web access gate is disabled", async () => {
    await expectAppAssemblyInvalid(
      createTestConfig({
        webAccess: {
          enabled: false,
          fetch: {
            enabled: true
          }
        },
        toolNames: ["web_fetch"],
        tools: [{ name: "web_fetch", enabled: true }]
      }),
      "Agent 'test_agent' references tool 'web_fetch' with no registered implementation"
    );
  });

  it("does not expose web_fetch when the fetch gate is disabled", async () => {
    await expectAppAssemblyInvalid(
      createTestConfig({
        webAccess: {
          enabled: true,
          fetch: {
            enabled: false
          }
        },
        toolNames: ["web_fetch"],
        tools: [{ name: "web_fetch", enabled: true }]
      }),
      "Agent 'test_agent' references tool 'web_fetch' with no registered implementation"
    );
  });

  it("registers web_fetch when enabled by app config", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        webAccess: {
          enabled: true,
          fetch: {
            enabled: true
          }
        },
        toolNames: ["web_fetch"],
        tools: [{ name: "web_fetch", enabled: true }]
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });

    await app.close();
  });

  it("does not expose web_search when the top-level web access gate is disabled", async () => {
    await expectAppAssemblyInvalid(
      createTestConfig({
        webAccess: {
          enabled: false,
          search: {
            enabled: true
          }
        },
        toolNames: ["web_search"],
        tools: [{ name: "web_search", enabled: true }]
      }),
      "Agent 'test_agent' references web_search but web access is disabled"
    );
  });

  it("does not expose web_search when search is disabled", async () => {
    await expectAppAssemblyInvalid(
      createTestConfig({
        webAccess: {
          enabled: true,
          search: {
            enabled: false
          }
        },
        toolNames: ["web_search"],
        tools: [{ name: "web_search", enabled: true }]
      }),
      "Agent 'test_agent' references web_search but webAccess.search is disabled"
    );
  });

  it("fails closed when native web_search is requested for an unsupported provider", async () => {
    await expectAppAssemblyInvalid(
      createTestConfig({
        webAccess: {
          enabled: true,
          search: {
            enabled: true,
            mode: "native_only"
          }
        },
        toolNames: ["web_search"],
        tools: [{ name: "web_search", enabled: true }]
      }),
      "Agent 'test_agent' references web_search but model provider 'local' does not support provider-native web search"
    );
  });

  it("fails closed when managed web_search is pinned before a managed provider exists", async () => {
    await expectAppAssemblyInvalid(
      createTestConfig({
        webAccess: {
          enabled: true,
          search: {
            enabled: true,
            mode: "native_or_managed",
            managedProvider: "serper"
          }
        },
        modelProviders: [
          {
            id: "openai",
            type: "openai-compatible",
            api: "responses",
            model: "gpt-test",
            baseUrl: "https://api.openai.com/v1",
            apiKeyEnvName: "OPENAI_API_KEY"
          }
        ],
        modelProviderId: "openai",
        toolNames: ["web_search"],
        tools: [{ name: "web_search", enabled: true }]
      }),
      "Agent 'test_agent' references web_search with managed provider 'serper', but managed web search providers are not implemented"
    );
  });

  it("accepts native web_search for OpenAI-compatible Responses providers without a local tool", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        webAccess: {
          enabled: true,
          search: {
            enabled: true,
            mode: "native_or_managed"
          }
        },
        modelProviders: [
          {
            id: "openai",
            type: "openai-compatible",
            api: "responses",
            model: "gpt-test",
            baseUrl: "https://api.openai.com/v1",
            apiKeyEnvName: "OPENAI_API_KEY"
          }
        ],
        modelProviderId: "openai",
        toolNames: ["web_search"],
        tools: [{ name: "web_search", enabled: true }]
      }),
      env: { OPENAI_API_KEY: "test-key" },
      storeMode: "memory",
      tools: []
    });

    await app.close();
  });
});

describe("web search model tool materialization", () => {
  it("materializes provider-native search without asking the local registry for web_search", () => {
    const config = createTestConfig({
      webAccess: {
        enabled: true,
        search: {
          enabled: true
        }
      },
      modelProviders: [
        {
          id: "openai",
          type: "openai-compatible",
          api: "responses",
          model: "gpt-test",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnvName: "OPENAI_API_KEY"
        }
      ],
      modelProviderId: "openai",
      toolNames: ["demo.echo", "web_search"],
      tools: [
        { name: "demo.echo", enabled: true },
        { name: "web_search", enabled: true }
      ]
    });
    const agent = config.agents[0]!;
    const requestedToolNames: string[][] = [];

    const tools = materializeModelTools({
      agent,
      modelProvider: config.modelProviders[0]!,
      webAccess: config.webAccess,
      toolRegistry: {
        listDescriptorsForAgent(toolNames) {
          requestedToolNames.push([...toolNames]);
          return toolNames.map((name) => ({
            name,
            description: `Tool ${name}`,
            inputJsonSchema: { type: "object", additionalProperties: true }
          }));
        }
      }
    });

    expect(requestedToolNames).toEqual([["demo.echo"]]);
    expect(tools).toEqual([
      expect.objectContaining({ kind: "function", name: "demo.echo" }),
      {
        kind: "provider",
        id: "openai.web_search",
        name: "web_search"
      }
    ]);
  });
});

const resolvePublicExample: WebFetchAddressResolver = async () => [
  {
    address: "93.184.216.34",
    family: 4
  }
];

async function expectAppAssemblyInvalid(config: ReturnType<typeof createTestConfig>, message: string) {
  try {
    const app = await createClientInstanceApp({
      config,
      env: {},
      storeMode: "memory",
      tools: []
    });
    await app.close();
    throw new Error("Expected app assembly to fail");
  } catch (error) {
    if (!(error instanceof AppError)) {
      throw error;
    }
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.details).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          message
        })
      ])
    });
  }
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function createTestConfig(input: {
  webAccess?: Record<string, unknown>;
  modelProviders?: Array<Record<string, unknown>>;
  modelProviderId?: string;
  toolNames?: string[];
  tools?: Array<{ name: string; enabled?: boolean }>;
} = {}) {
  return parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: "web-access-test",
      displayName: "Web Access Test",
      environment: "development"
    },
    auth: {
      development: {
        enabled: true,
        user: {
          id: "user-1",
          externalUserId: "user-1",
          displayLabel: "User",
          roles: ["user"],
          permissionRefs: []
        }
      }
    },
    ...(input.webAccess ? { webAccess: input.webAccess } : {}),
    defaultAgentName: "test_agent",
    agents: [
      {
        name: "test_agent",
        displayName: "Test Agent",
        instructions: "Test web access.",
        modelProviderId: input.modelProviderId ?? "local",
        toolNames: input.toolNames ?? []
      }
    ],
    modelProviders: input.modelProviders ?? [{ id: "local", type: "deterministic", model: "deterministic-local" }],
    tools: input.tools ?? []
  });
}
