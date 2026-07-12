import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ApiKeyAccessTokenExchange,
  CompositeAuthAdapter,
  HmacServiceAccessTokenAuthAdapter,
  HmacSessionTokenAuthAdapter,
  HmacSessionTokenIssuer,
  IdentityResolvingAuthAdapter
} from "@vivd-catalyst/auth";
import { createChatServer } from "@vivd-catalyst/chat-server";
import {
  AppError,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  type AgentRuntime,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ModelProvider } from "@vivd-catalyst/model-provider";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import {
  STATE_FILENAME,
  canonicalBundleFiles,
  canonicalizeAgentConfig,
  createConfigApi,
  createUnifiedDiff,
  parseAgentYaml,
  parseManifest,
  parseSkillFile,
  readStateFile,
  resolveInstance,
  runCli,
  runConfigCommand,
  serializeAgentYaml,
  serializeSkillMarkdown,
  writeStateFile
} from "../packages/config-cli/src/index";

const servers: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("config CLI serialization", () => {
  it("deterministically round-trips agent YAML and ignores provenance comments", () => {
    const input = {
      ...agentConfig("First line\nSecond line"),
      reasoningEffort: "xhigh" as const
    };
    const serialized = serializeAgentYaml(input, { instance: "local", version: 12 });

    expect(serialized).toMatch(/^# Pulled from local \(config version 12\)\./u);
    expect(serialized).toMatch(/instructions: \|[-+]?\n/u);
    expect(parseAgentYaml(serialized)).toEqual(canonicalizeAgentConfig(input));
    expect(serializeAgentYaml(parseAgentYaml(serialized))).toBe(
      serializeAgentYaml(canonicalizeAgentConfig(input))
    );
    expect(Object.keys(canonicalizeAgentConfig(input))).toEqual([
      "name",
      "displayName",
      "instructions",
      "modelProviderId",
      "reasoningEffort",
      "toolNames",
      "skillNames",
      "initialPrompts"
    ]);
  });

  it("round-trips SKILL.md with provenance comments inside frontmatter", () => {
    const skill = {
      name: "review",
      title: "Review",
      description: "Review a workflow",
      content: "# Review\n\nCheck the workflow."
    };
    const serialized = serializeSkillMarkdown(skill, { instance: "staging", version: 4 });

    expect(serialized).toContain("---\n# Pulled from staging (config version 4).\n");
    expect(parseSkillFile(serialized)).toEqual(skill);
    expect(serializeSkillMarkdown(parseSkillFile(serialized))).toBe(
      serializeSkillMarkdown(skill)
    );
  });
});

describe("config CLI state and manifest", () => {
  it("reads and atomically writes state files", async () => {
    const directory = await createTemporaryDirectory();
    const path = resolve(directory, STATE_FILENAME);

    expect(await readStateFile(path)).toEqual({ instances: {} });
    await writeStateFile(path, {
      instances: {
        local: { lastPulledVersion: 12 },
        staging: { lastPulledVersion: 3 }
      }
    });

    expect(await readStateFile(path)).toEqual({
      instances: {
        local: { lastPulledVersion: 12 },
        staging: { lastPulledVersion: 3 }
      }
    });
    expect(await readFile(path, "utf8")).toContain('"lastPulledVersion": 12');
  });

  it("resolves named, default, and direct URL instances", () => {
    const manifest = parseManifest(`instances:
  local:
    url: http://127.0.0.1:4100/
defaultInstance: local
defaultAgentName: workflow_assistant
agents:
  - agents/*.agent.yaml
skills:
  - skills/*/SKILL.md
`);

    expect(resolveInstance(manifest)).toEqual({ key: "local", url: "http://127.0.0.1:4100" });
    expect(resolveInstance(manifest, "local")).toEqual({
      key: "local",
      url: "http://127.0.0.1:4100"
    });
    expect(resolveInstance(manifest, "https://catalyst.example.test/")).toEqual({
      key: "https://catalyst.example.test/",
      url: "https://catalyst.example.test"
    });
  });
});

describe("config CLI diff", () => {
  it("prints a unified diff for a changed agent", () => {
    const remote = canonicalBundleFiles({
      defaultAgentName: "assistant",
      agents: [agentConfig("Remote instructions")],
      skills: []
    });
    const local = canonicalBundleFiles({
      defaultAgentName: "assistant",
      agents: [agentConfig("Local instructions")],
      skills: []
    });
    const path = "agents/assistant.agent.yaml";
    const output = createUnifiedDiff(
      { path, contents: remote.get(path) },
      { path, contents: local.get(path) }
    );

    expect(output).toContain(`diff --git a/${path} b/${path}`);
    expect(output).toContain("-instructions: Remote instructions");
    expect(output).toContain("+instructions: Local instructions");
  });
});

describe("config CLI command flows", () => {
  it("prefers API-key exchange, then pulls, pushes, and reports a stale-version conflict", async () => {
    const fixture = await createFixture();
    await fixture.store.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "assistant",
          config: agentConfig("Remote instructions")
        },
        { type: "setDefaultAgent", agentName: "assistant" }
      ]
    });
    const url = "https://catalyst.test";
    const directory = await createTemporaryDirectory();
    await writeFile(
      resolve(directory, "catalyst.yaml"),
      `# Keep this manifest comment
instances:
  local:
    url: ${url}
defaultInstance: local
defaultAgentName: stale_default
agents:
  - agents/*.agent.yaml
skills:
  - skills/*/SKILL.md
`,
      "utf8"
    );
    const obsoleteAgentPath = resolve(directory, "agents", "obsolete.agent.yaml");
    await mkdir(resolve(directory, "agents"), { recursive: true });
    await writeFile(
      obsoleteAgentPath,
      serializeAgentYaml(agentConfig("Obsolete", { name: "obsolete" })),
      "utf8"
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const commandOptions = {
      cwd: directory,
      env: {
        CATALYST_API_KEY: fixture.apiKey,
        CATALYST_SERVER_CREDENTIAL: "server-credential"
      },
      fetchImpl: recordFetch(createFastifyFetch(fixture.server), requests),
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text)
    };

    expect(await runConfigCommand("pull", commandOptions)).toBe(0);
    expect(requests[0]?.url).toBe(`${url}/api/auth/access-token`);
    expect(requests[0]?.init?.method).toBe("POST");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      `Bearer ${fixture.apiKey}`
    );
    expect(requests[0]?.init?.body).toBeUndefined();
    expect(requests[1]?.url).toBe(`${url}/api/admin/config/export`);
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toMatch(/^Bearer /u);
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).not.toBe(
      `Bearer ${fixture.apiKey}`
    );
    expect(requests.some((request) => request.url.includes("session-tokens"))).toBe(false);
    expect(stderr.join("")).not.toContain("Deprecation warning");
    const agentPath = resolve(directory, "agents", "assistant.agent.yaml");
    const pulledAgent = parseAgentYaml(await readFile(agentPath, "utf8"));
    expect(pulledAgent.instructions).toBe("Remote instructions");
    await expect(readFile(obsoleteAgentPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readStateFile(resolve(directory, STATE_FILENAME))).toEqual({
      instances: { local: { lastPulledVersion: 1 } }
    });
    expect(await readFile(resolve(directory, "catalyst.yaml"), "utf8")).toContain(
      "# Keep this manifest comment"
    );
    expect(await readFile(resolve(directory, "catalyst.yaml"), "utf8")).toContain(
      "defaultAgentName: assistant"
    );
    expect(stdout.join("")).toContain("Pulled 1 agent, 0 skills, version 1.");

    await writeFile(
      agentPath,
      serializeAgentYaml({ ...pulledAgent, instructions: "Local instructions" }),
      "utf8"
    );
    stdout.length = 0;
    expect(await runConfigCommand("push", commandOptions)).toBe(0);
    expect(stdout.join("")).toContain("Pushed 1 agent, 0 skills, version 2.");
    expect(
      await fixture.store.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "agent",
        name: "assistant"
      })
    ).toMatchObject({ config: { instructions: "Local instructions" } });

    await fixture.store.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      baseVersion: 2,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "assistant",
          config: agentConfig("New remote instructions")
        }
      ]
    });
    await writeFile(
      agentPath,
      serializeAgentYaml({ ...pulledAgent, instructions: "Stale local instructions" }),
      "utf8"
    );
    stderr.length = 0;
    expect(await runConfigCommand("push", commandOptions)).toBe(1);
    expect(stderr.join("")).toContain("remote is at version 3; you last pulled 2");
    expect(stderr.join("")).toContain("catalyst config diff");
    expect(stderr.join("")).toContain("--force");
  });

  it("rejects noncanonical pull globs before writing or deleting assets", async () => {
    const fixture = await createFixture();
    await fixture.store.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "assistant",
          config: agentConfig("Remote instructions")
        },
        { type: "setDefaultAgent", agentName: "assistant" }
      ]
    });
    const directory = await createTemporaryDirectory();
    await writeFile(
      resolve(directory, "catalyst.yaml"),
      `instances:
  local:
    url: http://catalyst.test
defaultInstance: local
defaultAgentName: unchanged
agents:
  - config/agents/*.yaml
skills:
  - skills/*/SKILL.md
`,
      "utf8"
    );
    const existingPath = resolve(directory, "config", "agents", "existing.yaml");
    await mkdir(resolve(directory, "config", "agents"), { recursive: true });
    await writeFile(existingPath, "existing contents\n", "utf8");
    const stderr: string[] = [];

    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: { CATALYST_SERVER_CREDENTIAL: "server-credential" },
        fetchImpl: createFastifyFetch(fixture.server),
        stderr: (text: string) => stderr.push(text)
      })
    ).toBe(1);
    expect(stderr.join("")).toContain("Deprecation warning");
    expect(stderr.join("")).toContain("CATALYST_API_KEY");
    expect(stderr.join("")).toContain("canonical layout");
    expect(stderr.join("")).toContain("adjust the manifest globs");
    await expect(readFile(existingPath, "utf8")).resolves.toBe("existing contents\n");
    await expect(
      readFile(resolve(directory, "agents", "assistant.agent.yaml"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolve(directory, STATE_FILENAME), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await readFile(resolve(directory, "catalyst.yaml"), "utf8")).toContain(
      "defaultAgentName: unchanged"
    );
  });

  it("reports missing credentials separately from exchange and API failures", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    const missingStderr: string[] = [];

    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: {},
        stderr: (text) => missingStderr.push(text)
      })
    ).toBe(1);
    expect(missingStderr.join("")).toContain("Missing CLI credentials");
    expect(missingStderr.join("")).toContain("CATALYST_API_KEY");

    const apiKey = "cat_test_secret-never-print-this";
    const exchangeStderr: string[] = [];
    const exchangeRequests: string[] = [];
    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: {
          CATALYST_API_KEY: apiKey,
          CATALYST_SERVER_CREDENTIAL: "must-not-be-used"
        },
        fetchImpl: async (input) => {
          exchangeRequests.push(input instanceof Request ? input.url : String(input));
          return jsonResponse(
            401,
            { error: { code: "UNAUTHENTICATED", message: `Invalid API key ${apiKey}` } }
          );
        },
        stderr: (text) => exchangeStderr.push(text)
      })
    ).toBe(1);
    expect(exchangeStderr.join("")).toContain("API key exchange failed (HTTP 401)");
    expect(exchangeStderr.join("")).not.toContain(apiKey);
    expect(exchangeRequests).toEqual(["https://catalyst.test/api/auth/access-token"]);

    const apiStderr: string[] = [];
    let requestCount = 0;
    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: { CATALYST_API_KEY: apiKey },
        fetchImpl: async () => {
          requestCount += 1;
          return requestCount === 1
            ? jsonResponse(200, {
                accessToken: "short-lived-access-token",
                expiresAt: "2030-01-01T00:00:00.000Z"
              })
            : jsonResponse(503, {
                error: { code: "UNAVAILABLE", message: "Config API unavailable" }
              });
        },
        stderr: (text) => apiStderr.push(text)
      })
    ).toBe(1);
    expect(apiStderr.join("")).toContain("UNAVAILABLE: Config API unavailable");
    expect(apiStderr.join("")).not.toContain("API key exchange failed");
    expect(apiStderr.join("")).not.toContain(apiKey);
  });

  it("uses API-key auth with a direct --instance URL", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "http://manifest-instance.test");
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      return url.endsWith("/api/auth/access-token")
        ? jsonResponse(200, {
            accessToken: "direct-url-access-token",
            expiresAt: "2030-01-01T00:00:00.000Z"
          })
        : jsonResponse(200, { version: 0, agents: [], skills: [] });
    };

    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        instance: "https://direct-instance.example.test/base/",
        env: { CATALYST_API_KEY: "cat_direct_key" },
        fetchImpl
      })
    ).toBe(0);
    expect(requests.map((request) => request.url)).toEqual([
      "https://direct-instance.example.test/base/api/auth/access-token",
      "https://direct-instance.example.test/base/api/admin/config/export"
    ]);
  });

  it("refuses API-key exchange over remote plain HTTP before fetching", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "http://remote.example.test");
    const stderr: string[] = [];
    let fetchCount = 0;
    const apiKey = "cat_remote_secret";

    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: { CATALYST_API_KEY: apiKey },
        fetchImpl: async () => {
          fetchCount += 1;
          return jsonResponse(500, {});
        },
        stderr: (text) => stderr.push(text)
      })
    ).toBe(1);
    expect(fetchCount).toBe(0);
    expect(stderr.join("")).toContain("Refusing to send CATALYST_API_KEY over plain HTTP");
    expect(stderr.join("")).toContain("Use HTTPS");
    expect(stderr.join("")).not.toContain(apiKey);
  });

  it.each([
    "http://localhost:4100/",
    "http://127.42.0.8:4100/",
    "http://[::1]:4100/"
  ])("allows API-key exchange for loopback direct URL %s", async (instance) => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://manifest-instance.test");
    const requests: string[] = [];

    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        instance,
        env: { CATALYST_API_KEY: "cat_loopback_key" },
        fetchImpl: async (input) => {
          const url = input instanceof Request ? input.url : String(input);
          requests.push(url);
          return url.endsWith("/api/auth/access-token")
            ? jsonResponse(200, {
                accessToken: "loopback-access-token",
                expiresAt: "2030-01-01T00:00:00.000Z"
              })
            : jsonResponse(200, { version: 0, agents: [], skills: [] });
        }
      })
    ).toBe(0);
    const baseUrl = instance.replace(/\/$/u, "");
    expect(requests).toEqual([
      `${baseUrl}/api/auth/access-token`,
      `${baseUrl}/api/admin/config/export`
    ]);
  });
});

describe("config CLI API transport", () => {
  it("rejects unsupported API-key URL schemes before fetching", async () => {
    let fetchCount = 0;

    await expect(
      createConfigApi({
        baseUrl: "ftp://catalyst.example.test",
        apiKey: "cat_unsupported_scheme_secret",
        fetchImpl: async () => {
          fetchCount += 1;
          return jsonResponse(500, {});
        }
      })
    ).rejects.toThrow("unsupported URL scheme 'ftp:'");
    expect(fetchCount).toBe(0);
  });
});

describe("config CLI help", () => {
  it("documents API-key preference and the legacy environment fallback", async () => {
    const stdout: string[] = [];
    expect(await runCli(["--help"], { stdout: (text) => stdout.push(text) })).toBe(0);
    const help = stdout.join("");
    expect(help).toContain("CATALYST_API_KEY");
    expect(help).toContain("preferred");
    expect(help).toContain("CATALYST_SERVER_CREDENTIAL");
    expect(help).toContain("deprecated compatibility fallback");
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "catalyst-config-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFixture() {
  const clientInstanceId = asClientInstanceId("config-cli-test");
  const store = new InMemoryPlatformStore();
  const config = parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: clientInstanceId,
      displayName: "Config CLI test",
      environment: "development"
    },
    auth: {},
    modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
    tools: [{ name: "known.tool", enabled: true }]
  });
  const authOptions = {
    secret: "a-development-session-token-secret",
    clientInstanceId,
    issuer: "config-cli-test",
    ttlSeconds: 900
  };
  const issuer = new HmacSessionTokenIssuer(authOptions);
  const serviceAccessOptions = {
    secret: "a-development-service-access-secret-with-enough-length",
    clientInstanceId,
    apiAccessStore: store
  };
  const servicePrincipal = await store.createServicePrincipal({
    clientInstanceId,
    displayLabel: "Catalyst CLI",
    permissions: ["config_assets.read", "config_assets.release"]
  });
  const createdCredential = await store.createApiCredential({
    clientInstanceId,
    servicePrincipalId: servicePrincipal.id,
    name: "config CLI test",
    scopes: ["config_assets:read", "config_assets:release"]
  });
  const auditRecorder = new StoreBackedAuditRecorder({ clientInstanceId, store });
  const server = await createChatServer({
    config,
    clientInstanceId,
    authAdapter: new IdentityResolvingAuthAdapter(
      new CompositeAuthAdapter([
        new HmacServiceAccessTokenAuthAdapter(serviceAccessOptions),
        new HmacSessionTokenAuthAdapter(authOptions)
      ]),
      store
    ),
    conversationStore: store,
    auditEventStore: store,
    userStore: store,
    usageGovernance: new ModelUsageGovernance({
      store,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      pricing: config.usage.pricing
    }),
    auditRecorder,
    configAssets: {
      store,
      validationRefs: {
        modelProviderIds: ["local"],
        modelBindingIds: [],
        modelBindings: [],
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
        enabledToolNames: ["known.tool"]
      }
    },
    agentRuntime: createUnusedAgentRuntime(),
    modelProvider: createUnusedModelProvider(),
    sessionToken: { issuer, serverCredential: "server-credential" },
    serviceAccessToken: {
      exchange: new ApiKeyAccessTokenExchange(serviceAccessOptions)
    }
  });
  servers.push(server);
  return { clientInstanceId, server, store, apiKey: createdCredential.secret };
}

async function writeMinimalManifest(directory: string, url: string): Promise<void> {
  await writeFile(
    resolve(directory, "catalyst.yaml"),
    `instances:\n  local:\n    url: ${url}\ndefaultInstance: local\nagents:\n  - agents/*.agent.yaml\nskills:\n  - skills/*/SKILL.md\n`,
    "utf8"
  );
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function recordFetch(
  fetchImpl: typeof fetch,
  requests: Array<{ url: string; init?: RequestInit }>
): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({ url, ...(init === undefined ? {} : { init }) });
    return fetchImpl(input, init);
  };
}

function agentConfig(
  instructions: string,
  overrides: { name?: string } = {}
) {
  return {
    name: overrides.name ?? "assistant",
    displayName: "Assistant",
    instructions,
    modelProviderId: "local",
    toolNames: [],
    skillNames: [],
    initialPrompts: []
  };
}

function createUnusedAgentRuntime(): AgentRuntime {
  return {
    async start() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config CLI tests");
    },
    async *observe() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config CLI tests");
    },
    async getStatus() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config CLI tests");
    },
    async resume() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config CLI tests");
    },
    async cancel() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config CLI tests");
    }
  };
}

function createUnusedModelProvider(): ModelProvider {
  return {
    id: "unused",
    async complete(_request, _context: RuntimeCallContext) {
      throw new AppError("INTERNAL", "Model provider should not be used by config CLI tests");
    }
  };
}

function createFastifyFetch(server: FastifyInstance): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const headers = new Headers(request?.headers);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const body = init?.body;
    const response = await server.inject({
      method: (init?.method ?? request?.method ?? "GET") as "GET" | "POST" | "PUT",
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(headers),
      ...(typeof body === "string" ? { payload: body } : {})
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) {
        responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value));
      }
    }
    return new Response(response.body, {
      status: response.statusCode,
      headers: responseHeaders
    });
  };
}
