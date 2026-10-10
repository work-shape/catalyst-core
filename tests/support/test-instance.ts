import { createClientInstanceExecutionAssembly } from "../../packages/client-assembly/src/app";
import { afterAll, afterEach, beforeEach } from "vitest";
import {
  createClientInstanceApp,
  createJobWorker,
  createLogger,
  type CreateClientInstanceAppInput
} from "@vivd-catalyst/client-assembly";
import {
  createChatServer,
  createChatServerJobs,
  type ChatServerJobOptions,
  type ChatServerOptions
} from "@vivd-catalyst/chat-server";
import { frameworkBehind } from "../../packages/chat-server/src/http/framework";
import { buildApiPath, operationPathParamNames } from "@vivd-catalyst/api-contract";
import {
  asClientInstanceId,
  NoopAuditRecorder,
  SecretNotResolvedError,
  type HttpRuntime,
  type JobWorker,
  type PlatformStores
} from "@vivd-catalyst/core";
import { createStaticConfigAssetSource } from "./static-config-asset-source";
import { createPostgresStores, type PostgresStores } from "@vivd-catalyst/postgres-store";
import { fileTestDatabaseUrl, closeFileTestDatabase, resetFileTestDatabase } from "./test-database";
import { addTestStoreHelpers, type TestStore } from "./test-store";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { testOperations, type TestOperationName, type TestCallInput } from "./operations";
import { createTestConfig, seedTestAssets } from "./fixtures";
import { createScriptedInstanceModelGateway, type ScriptedModelProvider } from "./model-gateway";

type TestHttpServer = NonNullable<ReturnType<typeof frameworkBehind>>["app"];
type TestResponse = Awaited<ReturnType<TestHttpServer["inject"]>>;

/** The product's route helper, as a test registers fixture operations through it. */
export type TestRoute = NonNullable<ReturnType<typeof frameworkBehind>>["route"];

/** The framework behind a server, which test support alone reaches past the public boundary. */
function testFramework(runtime: Pick<HttpRuntime, "fetch">) {
  const framework = frameworkBehind(runtime);
  if (!framework) throw new Error("This runtime is not a chat server");
  return framework;
}
type TestRouteHandler = NonNullable<Parameters<TestHttpServer["route"]>[0]["handler"]>;

export interface TestInstance<S extends PlatformStores = PlatformStores> {
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
export type { TestStore } from "./test-store";
export type TestPostgresStore = PostgresStores;
export type TestServerOptions = Omit<
  ChatServerOptions,
  "configAssets" | "logger" | "modelGateway"
> &
  Partial<Pick<ChatServerOptions, "logger">> & {
    configAssets?: Omit<ChatServerOptions["configAssets"], "source"> &
      Partial<Pick<ChatServerOptions["configAssets"], "source">>;
    /**
     * What answers the server's own model calls, such as a conversation title. It stands
     * behind the gateway for every model entry of the config. Left out, such a call fails.
     */
    modelProvider?: ScriptedModelProvider;
  };

type TestAppInput = CreateClientInstanceAppInput & { seedAssets?: boolean; fixtureFile?: string };
type TestPostgresOptions = {
  logger?: Parameters<typeof createPostgresStores>[0]["logger"];
  applicationName?: string;
  fixtureFile?: string;
};

type Metadata = {
  execution?: Awaited<ReturnType<typeof createClientInstanceExecutionAssembly>>;
  server?: TestHttpServer;
  /** The service's public boundary. */
  runtime?: HttpRuntime;
  config?: ClientInstanceConfig;
  /** The options of a server built here, from which its job worker is made on first use. */
  serverOptions?: ChatServerOptions;
  jobs?: JobWorker;
  closed: boolean;
  cleanup(): Promise<void>;
};
const metadata = new WeakMap<TestInstance, Metadata>();
const instances = new Set<TestInstance>();
let retained = new Set<TestInstance>();
let preserveSuiteState = false;
let testActive = false;
beforeEach(() => {
  testActive = true;
  retained = new Set(instances);
});
afterAll(async () => {
  const results = await Promise.allSettled([...instances].map((instance) => instance.close()));
  await closeFileTestDatabase();
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      "Test instance cleanup failed"
    );
});
afterEach(async () => {
  testActive = false;
  const closing = [...instances]
    .filter((instance) => !retained.has(instance))
    .map((instance) => instance.close());
  const results = await Promise.allSettled(closing);
  if (!preserveSuiteState) await resetFileTestDatabase();
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
export function createTestInstance(): Promise<TestInstance<TestStore>>;
export function createTestInstance(input: {
  postgres: TestPostgresOptions;
}): Promise<TestInstance<PostgresStores>>;
export function createTestInstance(input: { server: TestServerOptions }): Promise<TestInstance>;
export function createTestInstance(input: TestAppInput): Promise<TestInstance>;
export function createTestInstance(
  input?:
    | TestAppInput
    | { execution: Parameters<typeof createClientInstanceExecutionAssembly>[0] }
    | { postgres: TestPostgresOptions }
    | { server: TestServerOptions }
): Promise<TestInstance> {
  if (!testActive) preserveSuiteState = true;
  if (!input) return createDefaultInstance();
  return createConfiguredInstance(input);
}

/**
 * The default Postgres instance with some server options replaced: its sign-in, or the
 * optional parts a default instance runs without.
 */
export function createTestInstanceWith(
  replace: (stores: TestStore) => Partial<TestServerOptions>,
  /** Registers fixture operations through the product's route helper, beside the product's. */
  register?: (route: TestRoute) => void
): Promise<TestInstance<TestStore>> {
  if (!testActive) preserveSuiteState = true;
  return createDefaultInstance(replace, register);
}

async function createDefaultInstance(
  replace: (stores: TestStore) => Partial<TestServerOptions> = () => ({}),
  register?: (route: TestRoute) => void
): Promise<TestInstance<TestStore>> {
  const stores = addTestStoreHelpers(
    await createPostgresStores({ databaseUrl: await fileTestDatabaseUrl() })
  );
  const config = createTestConfig();
  const state: Metadata = {
    config,
    closed: false,
    async cleanup() {
      try {
        await state.server?.close();
      } finally {
        await stores.close();
      }
    }
  };
  return bindInstance(stores, state, async () => {
    const clientInstanceId = asClientInstanceId(config.clientInstance.id);
    const options = completeServerOptions(
      {
        config,
        clientInstanceId,
        stores: stores,
        authAdapter: {
          id: "test",
          credentialMode: "ambient",
          async authenticate(request) {
            const actor = request.headers["x-dev-user-id"];
            const externalUserId = typeof actor === "string" ? actor : "user-1";
            return {
              ...(await stores.users.resolveUserIdentity({
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
          store: stores.usage,
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
        ...replace(stores)
      },
      stores
    );
    state.serverOptions = options;
    const server = await createChatServer(options);
    try {
      const framework = testFramework(server);
      register?.(framework.route);
      state.runtime = server;
      return framework.app;
    } catch (error) {
      await server.close();
      throw error;
    }
  });
}

async function createConfiguredInstance(
  input:
    | TestAppInput
    | { execution: Parameters<typeof createClientInstanceExecutionAssembly>[0] }
    | { postgres: TestPostgresOptions }
    | { server: TestServerOptions }
): Promise<TestInstance> {
  if ("execution" in input) {
    const assembly = await createClientInstanceExecutionAssembly({
      ...input.execution,
      env: {
        ...input.execution.env,
        DATABASE_URL: await fileTestDatabaseUrl()
      }
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
    const url = new URL(await fileTestDatabaseUrl(input.postgres.fixtureFile));
    if (input.postgres.applicationName)
      url.searchParams.set("application_name", input.postgres.applicationName);
    const stores = await createPostgresStores({
      logger: input.postgres.logger,
      databaseUrl: url.toString()
    });
    const cleanup = stores.close.bind(stores);
    const instance = bindInstance(stores, { closed: false, cleanup });
    stores.close = instance.close;
    return instance;
  }
  if ("server" in input) {
    const options = input.server;
    const stores = options.stores;
    const serverOptions = completeServerOptions(options, stores);
    const server = await createChatServer(serverOptions);
    return bindInstance(stores, {
      server: testFramework(server).app,
      runtime: server,
      serverOptions,
      config: options.config,
      closed: false,
      async cleanup() {
        await server.close();
      }
    });
  }
  const app = await createClientInstanceApp({
    ...input,
    env: {
      ...input.env,
      DATABASE_URL: await fileTestDatabaseUrl(input.fixtureFile)
    }
  });
  try {
    if (input.seedAssets !== false) await seedTestAssets(app);
    return bindInstance(app.store, {
      server: testFramework(app).app,
      runtime: app,
      jobs: app.jobs,
      config: app.config,
      closed: false,
      cleanup: () => app.close()
    });
  } catch (error) {
    await app.close();
    throw error;
  }
}

const providerOfNoAnswers: ScriptedModelProvider = {
  async complete() {
    throw new Error("No provider configured");
  }
};

export function completeServerOptions(
  options: TestServerOptions,
  stores: PlatformStores
): ChatServerOptions {
  const { modelProvider = providerOfNoAnswers, ...serverOptions } = options;
  return {
    ...serverOptions,
    logger: options.logger ?? createLogger(),
    modelGateway: createScriptedInstanceModelGateway({
      config: options.config,
      modelProvider,
      usageGovernance: options.usageGovernance
    }),
    stores: options.stores,
    configAssets: options.configAssets
      ? {
          ...options.configAssets,
          source: options.configAssets.source ?? createStaticConfigAssetSource({})
        }
      : {
          store: stores.configAssets,
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

function bindInstance<S extends PlatformStores>(
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
      const descriptor = testOperations[operation];
      const { params, query, method, payload, ...request } = input;
      const identity = typeof as === "string" ? { headers: { "x-dev-user-id": as } } : as;
      if (!server) throw new Error("This store fixture has no HTTP transport");
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
          // A start that failed was already answered to the call that began it.
          await starting?.catch(() => undefined);
          if (state.serverOptions) await state.jobs?.stop();
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

/**
 * The job worker of the instance's API process. No test instance starts it: a test runs what is
 * due with `runDue()`, or starts the loop itself. An instance built from server options gets
 * its worker here, with the handlers the product registers.
 */
export function getTestJobs(instance: TestInstance, jobOptions?: ChatServerJobOptions): JobWorker {
  const state = metadata.get(instance);
  if (!state || state.closed) throw new Error("Test instance is closed");
  if (!state.jobs) {
    const options = state.serverOptions;
    if (!options) throw new Error("This fixture has no API process to serve jobs");
    state.jobs = createJobWorker({
      stores: options.stores,
      clientInstanceId: options.clientInstanceId,
      logger: options.logger,
      ...createChatServerJobs(options, jobOptions)
    });
  }
  return state.jobs;
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

/** The public runtime of the instance's server, for tests of that boundary itself. */
export async function getTestRuntime(instance: TestInstance): Promise<HttpRuntime> {
  // The default instance starts its server on the first call.
  await instance.call("health.get");
  const runtime = metadata.get(instance)?.runtime;
  if (!runtime) throw new Error("No test HTTP runtime");
  return runtime;
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
  await instance.call("health.get");
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

/**
 * Calls a path that is deliberately not an operation, such as one the API retired. Operations
 * are called by name through `instance.call`.
 */
export async function callTestPath(
  instance: TestInstance,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  headers: Record<string, string> = {}
): Promise<TestResponse> {
  // The default instance starts its server on the first call.
  await instance.call("health.get");
  return getTestServer(instance).inject({
    method,
    url: buildApiPath(path, {
      params: Object.fromEntries(operationPathParamNames(path).map((name) => [name, "any"]))
    }),
    headers,
    ...(method === "GET" || method === "DELETE" ? {} : { payload: {} })
  });
}

export function addTestRoute(
  instance: TestInstance,
  path: string,
  handler: TestRouteHandler
): void {
  getTestServer(instance).get(path, handler);
}

/** Adapts a worker or a focused framework fixture without exposing injection to callers. */
export async function bindTestTransport(
  server: TestHttpServer,
  close: () => Promise<void>,
  runtime?: HttpRuntime
): Promise<TestInstance<TestStore>> {
  const stores = addTestStoreHelpers(
    await createPostgresStores({ databaseUrl: await fileTestDatabaseUrl() })
  );
  return bindInstance(stores, {
    server,
    runtime,
    closed: false,
    async cleanup() {
      try {
        await close();
      } finally {
        await stores.close();
      }
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
    await Reflect.apply(createTestInstance, undefined, [
      { config: createTestConfig(), tools: [], allowedOrigins }
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

/**
 * Starts the app with an empty environment. Everything it takes from outside comes from the
 * resolver over `values`, and `resolved` records every name the app asked for. A name in
 * `unusable` is configured and broken, as a mounted secret file that cannot be read is.
 */
export async function createTestInstanceOnSecrets(
  input: Omit<TestAppInput, "env" | "secrets">,
  values: Record<string, string> = {},
  unusable: readonly string[] = []
): Promise<{ instance: TestInstance; resolved: Set<string> }> {
  if (!testActive) preserveSuiteState = true;
  const known: Record<string, string> = {
    ...values,
    DATABASE_URL: await fileTestDatabaseUrl(input.fixtureFile)
  };
  const resolved = new Set<string>();
  const app = await createClientInstanceApp({
    ...input,
    env: {},
    secrets: {
      async resolve(name) {
        resolved.add(name);
        const value = known[name];
        if (unusable.includes(name)) {
          throw new SecretNotResolvedError(
            name,
            `could not be read from the file named by '${name}_FILE'`,
            "unusable"
          );
        }
        if (value === undefined) {
          throw new SecretNotResolvedError(name, "is not set in the test resolver");
        }
        return value;
      }
    }
  });
  const instance = bindInstance(app.store, {
    runtime: app,
    config: app.config,
    closed: false,
    cleanup: () => app.close()
  });
  return { instance, resolved };
}

/** Exercises the production missing-configuration guard before any persistence is created. */
export async function rejectStartupWithoutDatabase(
  input: Pick<CreateClientInstanceAppInput, "config" | "tools">
): Promise<void> {
  const app = await createClientInstanceApp({ ...input, env: {} });
  await app.close();
}
