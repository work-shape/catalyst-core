import { createClientInstanceExecutionAssembly } from "../../packages/client-assembly/src/app";
import { afterAll, afterEach, beforeEach } from "vitest";
import {
  createClientInstanceApp,
  createLogger,
  type CreateClientInstanceAppInput
} from "@vivd-catalyst/client-assembly";
import {
  createChatServer,
  createRoute,
  type ChatServerOptions,
  type Route
} from "@vivd-catalyst/chat-server";
import { asClientInstanceId, NoopAuditRecorder, type PlatformStore } from "@vivd-catalyst/core";
import { InMemoryPlatformStore, createStaticConfigAssetSource } from "@vivd-catalyst/core/testing";
import { PostgresPlatformStore } from "@vivd-catalyst/postgres-store";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { testOperations, type TestOperationName, type TestCallInput } from "./operations";
import { createTestConfig, seedTestAssets } from "./fixtures";

type TestHttpServer = Awaited<ReturnType<typeof createChatServer>>;
type TestResponse = Awaited<ReturnType<TestHttpServer["inject"]>>;
type TestRouteHandler = NonNullable<Parameters<TestHttpServer["route"]>[0]["handler"]>;

export interface TestInstance<S extends PlatformStore = PlatformStore> {
  call(
    operation: TestOperationName,
    input?: TestCallInput,
    as?: TestIdentity
  ): Promise<TestResponse>;
  stores: S;
  signIn(identity: TestIdentity): TestIdentity;
  close(): Promise<void>;
}

type TestIdentity = string | { headers: TestCallInput["headers"] };
export type TestMemoryStore = InMemoryPlatformStore;
export type TestPostgresStore = PostgresPlatformStore;
export type TestServerOptions = Omit<
  ChatServerOptions,
  "apiAccessStore" | "configAssets" | "logger"
> &
  Partial<Pick<ChatServerOptions, "apiAccessStore" | "logger">> & {
    configAssets?: Omit<ChatServerOptions["configAssets"], "source"> &
      Partial<Pick<ChatServerOptions["configAssets"], "source">>;
  };

type TestAppInput = CreateClientInstanceAppInput & { seedAssets?: boolean };

type Metadata = {
  execution?: Awaited<ReturnType<typeof createClientInstanceExecutionAssembly>>;
  server?: TestHttpServer;
  config?: ClientInstanceConfig;
  closed: boolean;
  cleanup(): Promise<void>;
};
const metadata = new WeakMap<TestInstance, Metadata>();
const instances = new Set<TestInstance>();
let retained = new Set<TestInstance>();
beforeEach(() => {
  retained = new Set(instances);
});
afterAll(async () => {
  await Promise.all([...instances].map((instance) => instance.close()));
});
afterEach(async () => {
  const closing = [...instances]
    .filter((instance) => !retained.has(instance))
    .map((instance) => instance.close());
  const results = await Promise.allSettled(closing);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Test instance cleanup failed"
    );
});

export function createTestInstance(input: {
  execution: Parameters<typeof createClientInstanceExecutionAssembly>[0];
}): Promise<TestInstance>;
export function createTestInstance(): TestInstance<InMemoryPlatformStore>;
export function createTestInstance(input: {
  postgres: Parameters<typeof PostgresPlatformStore.connect>[0];
}): Promise<TestInstance<PostgresPlatformStore>>;
export function createTestInstance(input: { server: TestServerOptions }): Promise<TestInstance>;
export function createTestInstance(input: TestAppInput): Promise<TestInstance>;
export function createTestInstance(
  input?:
    | TestAppInput
    | { execution: Parameters<typeof createClientInstanceExecutionAssembly>[0] }
    | { postgres: Parameters<typeof PostgresPlatformStore.connect>[0] }
    | { server: TestServerOptions }
): TestInstance<InMemoryPlatformStore> | Promise<TestInstance> {
  if (!input) return createDefaultInstance();
  return createConfiguredInstance(input);
}

/**
 * The default in-memory instance with some server options replaced: its sign-in, or the
 * optional parts a default instance runs without.
 */
export function createTestInstanceWith(
  replace: (stores: InMemoryPlatformStore) => Partial<TestServerOptions>,
  /** Registers fixture operations through the product's route helper, beside the product's. */
  register?: (route: Route) => void
): TestInstance<InMemoryPlatformStore> {
  return createDefaultInstance(replace, register);
}

function createDefaultInstance(
  replace: (stores: InMemoryPlatformStore) => Partial<TestServerOptions> = () => ({}),
  register?: (route: Route) => void
): TestInstance<InMemoryPlatformStore> {
  const stores = new InMemoryPlatformStore();
  const config = createTestConfig();
  const state: Metadata = {
    config,
    closed: false,
    async cleanup() {
      await state.server?.close();
    }
  };
  return bindInstance(stores, state, async () => {
    const clientInstanceId = asClientInstanceId(config.clientInstance.id);
    const options = completeServerOptions(
      {
        config,
        clientInstanceId,
        conversationStore: stores,
        auditEventStore: stores,
        userStore: stores,
        authAdapter: {
          id: "test",
          credentialMode: "ambient",
          async authenticate(request) {
            const actor = request.headers["x-dev-user-id"];
            const externalUserId = typeof actor === "string" ? actor : "user-1";
            return {
              ...(await stores.resolveUserIdentity({
                clientInstanceId,
                authSource: "test",
                externalUserId,
                displayLabel: externalUserId,
                roles: ["user", "admin", "superadmin"],
                permissionRefs: ["demo-tools"],
                permissions: [],
                correlationId: "test"
              })),
              scopes: ["*"]
            };
          }
        },
        auditRecorder: new NoopAuditRecorder(),
        usageGovernance: new ModelUsageGovernance({
          store: stores,
          budget: config.usage.budget,
          safeguards: config.usage.safeguards,
          costs: config.usage.costs
        }),
        agentRuntime: {
          async start() {
            throw new Error("No runtime configured");
          },
          async *observe() {
            throw new Error("No runtime configured");
          },
          async getStatus() {
            throw new Error("No runtime configured");
          },
          async resume() {
            throw new Error("No runtime configured");
          },
          async cancel() {
            throw new Error("No runtime configured");
          }
        },
        modelProvider: {
          id: "unused",
          async complete() {
            throw new Error("No provider configured");
          }
        },
        ...replace(stores)
      },
      stores
    );
    const server = await createChatServer(options);
    register?.(createRoute(server, options));
    return server;
  });
}

async function createConfiguredInstance(
  input:
    | TestAppInput
    | { execution: Parameters<typeof createClientInstanceExecutionAssembly>[0] }
    | { postgres: Parameters<typeof PostgresPlatformStore.connect>[0] }
    | { server: TestServerOptions }
): Promise<TestInstance> {
  if ("execution" in input) {
    const assembly = await createClientInstanceExecutionAssembly({
      ...input.execution,
      storeMode: input.execution.storeMode ?? "memory",
      env: input.execution.env ?? {}
    });
    const cleanup = assembly.close.bind(assembly);
    const instance = bindInstance(assembly.store, {
      execution: assembly,
      config: assembly.config,
      closed: false,
      cleanup
    });
    assembly.close = instance.close;
    return instance;
  }
  if ("postgres" in input) {
    const stores = await PostgresPlatformStore.connect(input.postgres);
    const cleanup = stores.close.bind(stores);
    const instance = bindInstance(stores, { closed: false, cleanup });
    stores.close = instance.close;
    return instance;
  }
  if ("server" in input) {
    const options = input.server;
    const stores =
      options.conversationStore instanceof InMemoryPlatformStore ||
      options.conversationStore instanceof PostgresPlatformStore
        ? options.conversationStore
        : new InMemoryPlatformStore();
    const server = await createChatServer(completeServerOptions(options, stores));
    return bindInstance(stores, {
      server,
      config: options.config,
      closed: false,
      async cleanup() {
        await server.close();
      }
    });
  }
  const app = await createClientInstanceApp({
    ...input,
    env: input.env ?? {},
    storeMode: input.storeMode ?? "memory"
  });
  try {
    if (input.seedAssets !== false) await seedTestAssets(app);
    return bindInstance(app.store, {
      server: app.server,
      config: app.config,
      closed: false,
      cleanup: () => app.close()
    });
  } catch (error) {
    await app.close();
    throw error;
  }
}

export function completeServerOptions(
  options: TestServerOptions,
  stores: PlatformStore
): ChatServerOptions {
  return {
    ...options,
    logger: options.logger ?? createLogger(),
    apiAccessStore: options.apiAccessStore ?? stores,
    configAssets: options.configAssets
      ? {
          ...options.configAssets,
          source: options.configAssets.source ?? createStaticConfigAssetSource({})
        }
      : {
          store: stores,
          source: createStaticConfigAssetSource({}),
          validationRefs: {
            modelProviderIds: [],
            modelBindingIds: [],
            modelBindings: [],
            fastModeModelBindingIds: [],
            reasoningEfforts: [],
            enabledToolNames: []
          }
        }
  };
}

function bindInstance<S extends PlatformStore>(
  stores: S,
  state: Metadata,
  start?: () => Promise<TestHttpServer>
): TestInstance<S> {
  let starting: Promise<TestHttpServer> | undefined;
  let closing: Promise<void> | undefined;
  const instance: TestInstance<S> = {
    stores,
    signIn(identity) {
      if (state.closed) throw new Error("Test instance is closed");
      return typeof identity === "string" ? { headers: { "x-dev-user-id": identity } } : identity;
    },
    async call(operation, input = {}, as) {
      if (state.closed) throw new Error("Test instance is closed");
      if (!state.server && start) {
        starting ??= start();
        state.server = await starting;
      }
      const server = state.server;
      if (!server) throw new Error("This store fixture has no HTTP transport");
      const descriptor = testOperations[operation];
      const { params, query, method, payload, ...request } = input;
      const identity = typeof as === "string" ? { headers: { "x-dev-user-id": as } } : as;
      const requestPayload =
        typeof payload === "string" || (payload !== null && typeof payload === "object")
          ? payload
          : JSON.stringify(payload);
      return server.inject({
        ...request,
        ...(payload === undefined ? {} : { payload: requestPayload }),
        method: method ?? descriptor.method,
        url: descriptor.buildPath({ params, query }),
        headers: { ...request.headers, ...identity?.headers }
      });
    },
    close() {
      closing ??= (async () => {
        state.closed = true;
        instances.delete(instance);
        try {
          await starting;
        } finally {
          await state.cleanup();
        }
      })();
      return closing;
    }
  };
  metadata.set(instance, state);
  instances.add(instance);
  return instance;
}

export function getTestConfig(instance: TestInstance): ClientInstanceConfig {
  const config = metadata.get(instance)?.config;
  if (!config) throw new Error("No instance configuration");
  return config;
}

function getTestServer(instance: TestInstance): TestHttpServer {
  const server = metadata.get(instance)?.server;
  if (!server) throw new Error("No test HTTP transport");
  return server;
}

export async function listenTestInstance(instance: TestInstance): Promise<string> {
  const server = getTestServer(instance);
  if (!server.server.listening) await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

/**
 * Every route the instance's HTTP server has registered, read from the framework's own
 * listing. A wildcard mount is listed by its method alone, with the path "*".
 */
export async function listTestRoutes(
  instance: TestInstance
): Promise<{ method: string; path: string }[]> {
  // The default instance starts its server on the first call.
  await instance.call("getHealth");
  const server = getTestServer(instance);
  const prefixes: string[] = [];
  const routes: { method: string; path: string }[] = [];
  for (const line of server.printRoutes({ commonPrefix: false }).split("\n")) {
    const match = /^((?:[│ ] {3})*)[├└]── (\S+)(?: \(([A-Z, ]+)\))?$/u.exec(line);
    if (!match) {
      if (line.trim().length > 0) throw new Error(`Unreadable route listing line: ${line}`);
      continue;
    }
    const depth = (match[1] ?? "").length / 4;
    const segment = match[2] ?? "";
    prefixes.length = depth;
    prefixes.push(segment);
    const path = segment === "*" ? "*" : prefixes.join("");
    for (const method of (match[3] ?? "").split(", ").filter(Boolean)) {
      // The framework answers HEAD for every GET route on its own.
      if (method !== "HEAD") routes.push({ method, path });
    }
  }
  return routes;
}

export function addTestRoute(
  instance: TestInstance,
  path: string,
  handler: TestRouteHandler
): void {
  getTestServer(instance).get(path, handler);
}

/** Adapts a worker or a focused framework fixture without exposing injection to callers. */
export function bindTestTransport(
  server: TestHttpServer,
  close: () => Promise<void>
): TestInstance<InMemoryPlatformStore> {
  const stores = new InMemoryPlatformStore();
  return bindInstance(stores, {
    server,
    closed: false,
    async cleanup() {
      await close();
    }
  });
}

/** API-client tests keep their real client and adapt its HTTP boundary here. */
export function createTestFetch(
  instance: TestInstance,
  headers: Record<string, string> = {}
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const descriptor = Object.entries(testOperations).find(
      ([, operation]) =>
        operation.method === request.method &&
        new RegExp(`^${operation.path.replaceAll(/:[A-Za-z][\w]*/gu, "([^/]+)")}$`, "u").test(
          url.pathname
        )
    );
    if (!descriptor) throw new Error(`Unknown test operation: ${request.method} ${url.pathname}`);
    const [name, operation] = descriptor;
    const operationName = Object.keys(testOperations).find(
      (key): key is TestOperationName => key === name
    );
    if (!operationName) throw new Error("Unknown catalog operation");
    const names = [...operation.path.matchAll(/:([A-Za-z][\w]*)/gu)].map((match) => match[1]);
    const values =
      url.pathname
        .match(new RegExp(`^${operation.path.replaceAll(/:[A-Za-z][\w]*/gu, "([^/]+)")}$`, "u"))
        ?.slice(1) ?? [];
    const params: Record<string, string> = {};
    for (const [index, param] of names.entries()) {
      const value = values[index];
      if (param && value !== undefined) params[param] = decodeURIComponent(value);
    }
    const body = request.body ? await request.text() : undefined;
    const response = await instance.call(operationName, {
      params,
      query: Object.fromEntries(url.searchParams),
      headers: { ...Object.fromEntries(request.headers), ...headers },
      ...(body === undefined ? {} : { payload: body })
    });
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined)
        responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : String(value));
    }
    return new Response(response.body, { status: response.statusCode, headers: responseHeaders });
  };
}

/** JavaScript callers can send malformed startup config; the unsafe value stays in support. */
export async function rejectInvalidOrigins(
  allowedOrigins: unknown,
  target: "server" | "assembly"
): Promise<void> {
  if (target === "server") await Reflect.apply(createChatServer, undefined, [{ allowedOrigins }]);
  else
    await Reflect.apply(createClientInstanceApp, undefined, [
      { config: createTestConfig(), env: {}, storeMode: "memory", tools: [], allowedOrigins }
    ]);
}

/** Uses a listening transport for tests that observe arrival, disconnects and stream cancellation. */
export function fetchTestOperation(
  baseUrl: string,
  operation: TestOperationName,
  input: import("@vivd-catalyst/api-contract").BuildApiPathOptions & RequestInit = {}
): Promise<Response> {
  const { params, query, ...request } = input;
  const descriptor = testOperations[operation];
  return fetch(`${baseUrl}${descriptor.buildPath({ params, query })}`, {
    ...request,
    method: request.method ?? descriptor.method
  });
}

export function getTestExecution(
  instance: TestInstance
): Awaited<ReturnType<typeof createClientInstanceExecutionAssembly>> {
  const assembly = metadata.get(instance)?.execution;
  if (!assembly) throw new Error("No execution assembly fixture");
  return assembly;
}
