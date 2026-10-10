import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiErrorResponseSchema, infrastructureSchema } from "@vivd-catalyst/api-contract";
import {
  INFRASTRUCTURE_CHECK_NOW_MIN_INTERVAL_MS,
  InfrastructureWorkflow,
  type InfrastructureEntry
} from "@vivd-catalyst/chat-server";
import {
  createInstanceInfrastructure,
  createJobWorker,
  createSandbox,
  createSandboxCheckJobs,
  declaredSecretNames,
  infrastructureOverview
} from "@vivd-catalyst/client-assembly";
import { getClientInstanceId, parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  defineProvider,
  legacyPermissionFor,
  PROVIDER_CHECK_TIMEOUT_MS,
  runProviderCheck,
  type Logger,
  type SecretResolver
} from "@vivd-catalyst/core";
import { MailjetTransport } from "@vivd-catalyst/mail";
import type { ModelAdapterFactory } from "@vivd-catalyst/model-provider";
import { createFakeSecrets } from "./support/fixtures";
import { asCaller, createCallerAuthAdapter } from "./support/route-callers";
import { createTestInstanceWith, getTestJobs } from "./support/test-instance";

// Instance > Infrastructure over HTTP: what an operator reads of the providers, that a check
// always ends, and that neither a secret nor a provider's own words leave the instance.

const MARKER = "secret-marker-5d1e9c";
const administrator = asCaller({
  id: "usr_admin",
  roles: ["admin"],
  permissions: [legacyPermissionFor("users.manage")]
});
const member = asCaller({ id: "usr_member", roles: ["user"] });

/**
 * Every secret of the instance carries the marker. `SUMMER_2024` stands where a name belongs,
 * reads as one and resolves to nothing: a password typed into the field of a reference.
 */
const secretValues = {
  DATABASE_URL: `postgres://catalyst:${MARKER}@database.example.test:5432/catalyst`,
  MODEL_KEY: `${MARKER}-model-key`,
  MODEL_ORGANIZATION: `${MARKER}-organization`,
  MAIL_KEY: `${MARKER}-mail-key`,
  MAIL_SECRET: `${MARKER}-mail-secret`,
  STORE_ACCESS_KEY: `${MARKER}-access-key`,
  STORE_SECRET_KEY: `${MARKER}-secret-key`
};

/** A provider whose check throws what a vendor's client throws: text with the credential. */
const throwingModelProvider = defineProvider({
  port: "models",
  type: "throwing",
  configSchema: z.object({}),
  external: false,
  create: (): ModelAdapterFactory => () => {
    throw new Error("This provider is never called for a model");
  },
  check() {
    throw new Error(`401 from https://vendor.example.test: the key ${MARKER} is not valid`);
  },
  describe: () => ({})
});

/** A provider whose description holds what no page may show: an address with its signature. */
const oddlyDescribedModelProvider = defineProvider({
  port: "models",
  type: "oddly-described",
  configSchema: z.object({}),
  external: false,
  create: (): ModelAdapterFactory => () => {
    throw new Error("This provider is never called for a model");
  },
  check: async () => ({ ok: true }),
  describe: () => ({
    endpointHost: `https://user:${MARKER}@signed.example.test/path?X-Amz-Signature=${MARKER}`,
    bucket: `internal/path/${MARKER}`
  })
});

function recordingLogger(): { logger: Logger; lines: unknown[] } {
  const lines: unknown[] = [];
  const record = (level: string) => (input: unknown, message?: string) => {
    lines.push({ level, input, message });
  };
  const logger: Logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: () => logger
  };
  return { logger, lines };
}

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** An API on a full `infrastructure` section, with every provider's secrets in a fake resolver. */
async function createServer(
  options: {
    extraEntries?: InfrastructureEntry[];
    /** Replaces the resolver in which every secret of the instance is set. */
    secrets?: SecretResolver;
    /** The instance of another server of this file: both then are API processes of it. */
    instanceId?: string;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "infrastructure-test-"));
  roots.push(root);
  const config = parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      // Every test file has one database: an instance of its own keeps a test's results and
      // its minute of "Check now" apart from the others'.
      id: options.instanceId ?? `infrastructure-test-${randomUUID()}`,
      displayName: "Infrastructure Test",
      environment: "staging"
    },
    auth: { standalone: { enabled: true } },
    infrastructure: {
      models: {
        main: {
          provider: "openai-compatible",
          region: "eu",
          model: "test-model",
          // A credential pasted into the address: only the host of it is ever shown.
          baseUrl: `https://user:${MARKER}@models.example.test/v1`,
          credentialSecret: "MODEL_KEY",
          organizationSecret: "MODEL_ORGANIZATION"
        },
        unset: {
          provider: "openai-compatible",
          region: "global",
          model: "test-model",
          baseUrl: "https://other-models.example.test/v1",
          credentialSecret: "SUMMER_2024"
        },
        throws: { provider: "throwing", model: "test-model" },
        odd: { provider: "oddly-described", model: "test-model" }
      },
      mail: {
        provider: "mailjet",
        region: "eu",
        apiKeySecret: "MAIL_KEY",
        apiSecretSecret: "MAIL_SECRET",
        appUrl: "https://chat.example.test",
        sender: { fromAddress: "noreply@example.test" }
      },
      objectStorage: {
        files: {
          provider: "s3",
          region: "eu",
          // Nothing listens here: the connection is refused at once.
          endpoint: "http://127.0.0.1:9",
          bucket: "documents-eu",
          bucketRegion: "eu-central-1",
          accessKeySecret: "STORE_ACCESS_KEY",
          secretKeySecret: "STORE_SECRET_KEY"
        },
        workspaces: { provider: "filesystem", root }
      },
      sandbox: { provider: "local" }
    }
  });
  const { logger, lines } = recordingLogger();
  const secrets = options.secrets ?? createFakeSecrets(secretValues);
  const infrastructure = await createInstanceInfrastructure({
    config,
    env: {},
    logger,
    secrets,
    providers: [throwingModelProvider, oddlyDescribedModelProvider]
  });
  let now = new Date("2026-10-10T08:00:00.000Z");
  let workflow: InfrastructureWorkflow | undefined;
  let overview: InfrastructureEntry[] = [];
  const server = await createTestInstanceWith((stores) => {
    overview = infrastructureOverview({ config, infrastructure, stores });
    workflow = new InfrastructureWorkflow({
      entries: [...overview, ...(options.extraEntries ?? [])],
      declaredSecretNames: declaredSecretNames(config, infrastructure.registry),
      secrets,
      store: stores.infrastructureChecks,
      clientInstanceId: getClientInstanceId(config),
      logger,
      now: () => now
    });
    return { authAdapter: createCallerAuthAdapter(), infrastructure: workflow };
  });
  return {
    server,
    config,
    infrastructure,
    instanceId: config.clientInstance.id,
    /** The entry of the release config with this id, once the API process has started. */
    entry(id: string): InfrastructureEntry {
      const found = overview.find((entry) => entry.id === id);
      if (!found) throw new Error(`No entry ${id}`);
      return found;
    },
    /** What the scheduled job calls. */
    runChecks(): Promise<void> {
      if (!workflow) throw new Error("The API process has not started");
      return workflow.runChecks();
    },
    lines,
    root,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    }
  };
}

/** The model endpoint refuses the key and says why; Mailjet's client fails with its header. */
function stubProviders(): { requests: { url: string; headers: Record<string, string> }[] } {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = Object.fromEntries(new Headers(init?.headers));
    requests.push({ url, headers });
    if (url.includes("models.example.test")) {
      return new Response(
        JSON.stringify({ error: { message: `Incorrect API key provided: ${MARKER}-model-key` } }),
        { status: 401 }
      );
    }
    throw new TypeError(`fetch failed with authorization ${headers.authorization ?? ""}`);
  });
  return { requests };
}

const read = (response: { json(): unknown }) => infrastructureSchema.parse(response.json());
const byId = (infrastructure: z.infer<typeof infrastructureSchema>) =>
  Object.fromEntries(infrastructure.items.map((item) => [item.id, item]));

describe("Instance > Infrastructure: what an operator reads", () => {
  it("lists every provider and the database, unchecked until the first run", async () => {
    stubProviders();
    const { server } = await createServer();

    const response = await server.call("instance.infrastructure.get", {}, administrator);

    expect(response.statusCode).toBe(200);
    const infrastructure = read(response);
    expect(infrastructure.checkIntervalSeconds).toBe(300);
    expect(infrastructure.items.map((item) => [item.id, item.class, item.type])).toEqual([
      ["database", "database", "postgres"],
      ["secrets", "secrets", "environment"],
      ["mail", "mail", "mailjet"],
      ["objectStorage.files", "objectStorage", "s3"],
      ["objectStorage.workspaces", "objectStorage", "filesystem"],
      ["sandbox", "sandbox", "local"],
      ["models.main", "models", "openai-compatible"],
      ["models.unset", "models", "openai-compatible"],
      ["models.throws", "models", "throwing"],
      ["models.odd", "models", "oddly-described"]
    ]);
    const items = byId(infrastructure);
    expect(items["models.main"]).toEqual({
      id: "models.main",
      class: "models",
      name: "main",
      type: "openai-compatible",
      origin: "operator",
      external: true,
      region: "eu",
      endpointHost: "models.example.test",
      secrets: [
        { name: "MODEL_KEY", state: "set" },
        { name: "MODEL_ORGANIZATION", state: "set" }
      ],
      check: { status: "pending" }
    });
    // What stands in the field resolves to nothing: the field is named, the text is not.
    expect(items["models.unset"]?.secrets).toEqual([
      { field: "credentialSecret", state: "missing" }
    ]);
    expect(response.body).not.toContain("SUMMER_2024");
    expect(items["objectStorage.files"]).toMatchObject({
      name: "files",
      region: "eu",
      bucket: "documents-eu",
      endpointHost: "127.0.0.1:9"
    });
    expect(items.database?.secrets).toEqual([{ name: "DATABASE_URL", state: "set" }]);
    // The sandbox runs in the command worker, which has reported no check.
    expect(items.sandbox?.check).toEqual({ status: "not_checked" });
    // A read asks no provider.
    expect(infrastructure.items.filter((item) => item.check.status === "pending")).toHaveLength(9);
  });

  it("withholds a host or a bucket that does not read as one and says so in the log", async () => {
    const { server, lines } = await createServer();

    const response = await server.call("instance.infrastructure.get", {}, administrator);

    expect(byId(read(response))["models.odd"]).toEqual({
      id: "models.odd",
      class: "models",
      name: "odd",
      type: "oddly-described",
      origin: "operator",
      external: false,
      withheld: ["endpointHost", "bucket"],
      secrets: [],
      check: { status: "pending" }
    });
    for (const field of ["endpointHost", "bucket"]) {
      expect(lines).toContainEqual({
        level: "warn",
        input: { provider: "models.odd", field },
        message: expect.stringContaining("is not shown")
      });
    }
    for (const output of [response.body, JSON.stringify(lines)]) {
      expect(output).not.toContain(MARKER);
      expect(output).not.toContain("signed.example.test");
      expect(output).not.toContain("internal/path");
    }
  });

  it("lists no secret reference that the release config does not declare", async () => {
    const undeclared: InfrastructureEntry = {
      id: "models.later",
      class: "models",
      name: "later",
      type: "openai-compatible",
      origin: "instance",
      external: true,
      region: "eu",
      // Both resolve. The second is no reference of the release config.
      secrets: [
        { name: "MODEL_KEY", field: "credentialSecret" },
        { name: "STORE_SECRET_OTHER", field: "organizationSecret" }
      ]
    };
    const { server } = await createServer({
      extraEntries: [undeclared],
      secrets: createFakeSecrets({ ...secretValues, STORE_SECRET_OTHER: MARKER })
    });

    const response = await server.call("instance.infrastructure.get", {}, administrator);

    expect(byId(read(response))["models.later"]?.secrets).toEqual([
      { name: "MODEL_KEY", state: "set" }
    ]);
    expect(response.body).not.toContain("STORE_SECRET_OTHER");
  });

  it("refuses a caller without the right to administer the instance", async () => {
    const { server } = await createServer();

    for (const operation of [
      "instance.infrastructure.get",
      "instance.infrastructure.check"
    ] as const) {
      const response = await server.call(operation, {}, member);
      expect(response.statusCode).toBe(403);
    }
  });
});

describe("Instance > Infrastructure: the checks", () => {
  it("shows the class of each failure after the scheduled run, and no secret or provider text", async () => {
    const { requests } = stubProviders();
    const { server, lines, root } = await createServer();
    // The API is up before its worker runs what is due at the start.
    await server.call("instance.infrastructure.get", {}, administrator);

    await getTestJobs(server).runDue();
    const response = await server.call("instance.infrastructure.get", {}, administrator);

    const checkedAt = "2026-10-10T08:00:00.000Z";
    const items = byId(read(response));
    expect(items.database?.check).toEqual({ status: "ok", checkedAt });
    expect(items.secrets?.check).toEqual({ status: "ok", checkedAt });
    expect(items["objectStorage.workspaces"]?.check).toEqual({ status: "ok", checkedAt });
    // The endpoint answered 401 with a message: the class is kept, the message is not.
    expect(items["models.main"]?.check).toEqual({
      status: "failed",
      checkedAt,
      errorClass: "access_denied"
    });
    // Its secret is not set, so there is no provider to ask.
    expect(items["models.unset"]?.check).toEqual({
      status: "failed",
      checkedAt,
      errorClass: "failed"
    });
    // The check threw: the class says so and the thrown message is gone.
    expect(items["models.throws"]?.check).toEqual({
      status: "failed",
      checkedAt,
      errorClass: "failed"
    });
    expect(items.mail?.check).toEqual({ status: "failed", checkedAt, errorClass: "unreachable" });
    expect(items["objectStorage.files"]?.check).toEqual({
      status: "failed",
      checkedAt,
      errorClass: "unreachable"
    });

    // The checks did carry the secrets: the model's list call and Mailjet's account call.
    const modelCheck = requests.find((request) => request.url.includes("models.example.test"));
    expect(modelCheck?.url).toMatch(/\/v1\/models$/u);
    expect(modelCheck?.headers.authorization).toBe(`Bearer ${MARKER}-model-key`);
    const mailCheck = requests.find((request) => request.url.includes("api.mailjet.com"));
    expect(mailCheck?.headers.authorization).toContain("Basic ");

    // A provider that stopped answering is logged once, by its class.
    expect(lines).toContainEqual({
      level: "warn",
      input: { provider: "models.main", type: "openai-compatible", errorClass: "access_denied" },
      message: "A provider does not answer its check"
    });
    for (const output of [response.body, JSON.stringify(lines)]) {
      expect(output).not.toContain(MARKER);
      expect(output).not.toContain("postgres://");
      expect(output).not.toContain("database.example.test");
      expect(output).not.toContain("Incorrect API key");
      expect(output).not.toContain("vendor.example.test");
      expect(output).not.toContain(
        Buffer.from(`${MARKER}-mail-key`).toString("base64").slice(0, 16)
      );
      // A path on the host is no part of the answer either.
      expect(output).not.toContain(root);
    }
  });

  it("runs 'Check now' once a minute for the instance and says from when it runs again", async () => {
    stubProviders();
    const { server, advance } = await createServer();

    const first = await server.call("instance.infrastructure.check", {}, administrator);
    expect(first.statusCode).toBe(200);
    expect(byId(read(first)).database?.check).toEqual({
      status: "ok",
      checkedAt: "2026-10-10T08:00:00.000Z"
    });
    expect(read(first).checkAvailableAt).toBe("2026-10-10T08:01:00.000Z");

    advance(20_000);
    // Another person asks inside the minute: no provider is called again.
    const second = await server.call(
      "instance.infrastructure.check",
      {},
      asCaller({
        id: "usr_other",
        roles: ["admin"],
        permissions: [legacyPermissionFor("users.manage")]
      })
    );
    expect(second.statusCode).toBe(429);
    expect(apiErrorResponseSchema.parse(second.json()).error).toMatchObject({
      code: "RATE_LIMITED",
      details: { retryAfterSeconds: 40 }
    });
    const between = read(await server.call("instance.infrastructure.get", {}, administrator));
    expect(between.checkAvailableAt).toBe("2026-10-10T08:01:00.000Z");
    expect(byId(between).database?.check).toMatchObject({ checkedAt: "2026-10-10T08:00:00.000Z" });

    advance(INFRASTRUCTURE_CHECK_NOW_MIN_INTERVAL_MS - 20_000);
    const third = await server.call("instance.infrastructure.check", {}, administrator);
    expect(third.statusCode).toBe(200);
    expect(byId(read(third)).database?.check).toEqual({
      status: "ok",
      checkedAt: "2026-10-10T08:01:00.000Z"
    });
  });

  it("answers a read at once while a provider is still being asked", async () => {
    stubProviders();
    let answer: (() => void) | undefined;
    let asked = 0;
    const slow: InfrastructureEntry = {
      id: "models.slow",
      class: "models",
      name: "slow",
      type: "openai-compatible",
      origin: "operator",
      external: true,
      region: "eu",
      secrets: [],
      check: () => {
        asked += 1;
        return new Promise((resolve) => {
          answer = () => resolve({ ok: true });
        });
      }
    };
    const { server, runChecks } = await createServer({ extraEntries: [slow] });

    const checking = server.call("instance.infrastructure.check", {}, administrator);
    await vi.waitFor(() => expect(asked).toBe(1));
    // The run is under way and has not ended.
    const during = await server.call("instance.infrastructure.get", {}, administrator);
    expect(during.statusCode).toBe(200);
    expect(byId(read(during))["models.slow"]?.check).toEqual({ status: "pending" });
    // The scheduled run that falls into it joins it: the provider is not asked twice at once.
    const scheduled = runChecks();
    expect(asked).toBe(1);

    answer?.();
    await scheduled;
    expect(asked).toBe(1);
    expect(byId(read(await checking))["models.slow"]?.check.status).toBe("ok");
  });
});

describe("Instance > Infrastructure: several processes of one instance", () => {
  it("shows in every API process what one of them found, and runs 'Check now' once a minute for all", async () => {
    stubProviders();
    const first = await createServer();
    const second = await createServer({ instanceId: first.instanceId });

    const checked = await first.server.call("instance.infrastructure.check", {}, administrator);
    expect(checked.statusCode).toBe(200);

    // The second process ran no check and reads the first one's results.
    const elsewhere = read(
      await second.server.call("instance.infrastructure.get", {}, administrator)
    );
    expect(elsewhere.items.map((item) => [item.id, item.check])).toEqual(
      read(checked).items.map((item) => [item.id, item.check])
    );
    expect(byId(elsewhere).database?.check).toEqual({
      status: "ok",
      checkedAt: "2026-10-10T08:00:00.000Z"
    });
    expect(elsewhere.checkAvailableAt).toBe("2026-10-10T08:01:00.000Z");
    // The minute is the instance's, not the process's.
    const refused = await second.server.call("instance.infrastructure.check", {}, administrator);
    expect(refused.statusCode).toBe(429);
    expect(apiErrorResponseSchema.parse(refused.json()).error).toMatchObject({
      code: "RATE_LIMITED",
      details: { retryAfterSeconds: 60 }
    });

    // Asked at the same moment after the minute, one of the two runs the check.
    first.advance(INFRASTRUCTURE_CHECK_NOW_MIN_INTERVAL_MS);
    second.advance(INFRASTRUCTURE_CHECK_NOW_MIN_INTERVAL_MS);
    const together = await Promise.all(
      [first, second].map(({ server }) =>
        server.call("instance.infrastructure.check", {}, administrator)
      )
    );
    expect(together.map((response) => response.statusCode).sort()).toEqual([200, 429]);
  });

  it("shows the sandbox as the worker that runs it found it", async () => {
    stubProviders();
    const { server, config, infrastructure, lines } = await createServer();
    await server.call("instance.infrastructure.check", {}, administrator);
    const before = byId(read(await server.call("instance.infrastructure.get", {}, administrator)));
    // The API has no way to ask it, also on "Check now".
    expect(before.sandbox?.check).toEqual({ status: "not_checked" });

    // The command worker's own job worker, with the check it registers beside its commands.
    const worker = createJobWorker({
      stores: server.stores,
      clientInstanceId: getClientInstanceId(config),
      logger: recordingLogger().logger,
      ...createSandboxCheckJobs({
        config,
        infrastructure,
        sandbox: await createSandbox(config, infrastructure),
        stores: server.stores,
        now: () => new Date("2026-10-10T08:03:00.000Z")
      })
    });
    await worker.runDue();

    const after = byId(read(await server.call("instance.infrastructure.get", {}, administrator)));
    expect(after.sandbox?.check).toEqual({ status: "ok", checkedAt: "2026-10-10T08:03:00.000Z" });
    // The worker wrote its own outcome and left the API's as they were.
    expect(after.database?.check).toEqual(before.database?.check);
    expect(after["models.main"]?.check).toEqual(before["models.main"]?.check);
    expect(JSON.stringify(lines)).not.toContain(MARKER);
  });
});

describe("a provider check", () => {
  it("ends as 'timeout' when the provider's secret never resolves, and creates the provider once", async () => {
    let asked = 0;
    const stalled: SecretResolver = {
      resolve(name) {
        if (name !== "MODEL_KEY") return createFakeSecrets(secretValues).resolve(name);
        asked += 1;
        return new Promise(() => {});
      }
    };
    const { server, entry } = await createServer({ secrets: stalled });
    await server.call("health.get");
    const check = entry("models.main").check;
    if (!check) throw new Error("The API checks its model providers");
    vi.useFakeTimers();

    const first = check();
    await vi.advanceTimersByTimeAsync(PROVIDER_CHECK_TIMEOUT_MS);
    await expect(first).resolves.toEqual({ ok: false, errorClass: "timeout" });
    const second = check();
    await vi.advanceTimersByTimeAsync(PROVIDER_CHECK_TIMEOUT_MS);
    await expect(second).resolves.toEqual({ ok: false, errorClass: "timeout" });

    // The creation that has not ended is waited for again: it is not started a second time.
    expect(asked).toBe(1);
  });

  it("ends as 'timeout' after the timeout and aborts what it started", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = runProviderCheck((context) => {
      signal = context.signal;
      return new Promise(() => {});
    });

    await vi.advanceTimersByTimeAsync(PROVIDER_CHECK_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({ ok: false, errorClass: "timeout" });
    expect(signal?.aborted).toBe(true);
  });

  it("turns whatever a definition's check throws into the class 'failed'", async () => {
    const instance = await throwingModelProvider.create(
      { path: "infrastructure.models.throws", entry: { provider: "throwing" } },
      { secrets: createFakeSecrets(), logger: recordingLogger().logger }
    );

    await expect(throwingModelProvider.check(instance)).resolves.toEqual({
      ok: false,
      errorClass: "failed"
    });
  });

  it("asks Mailjet for the account behind the key pair and sends no mail", async () => {
    const calls: { url: string; method: string | undefined; body: unknown }[] = [];
    const answering = (status: number) =>
      new MailjetTransport({
        apiKey: "key",
        apiSecret: "secret",
        fetch: async (input, init) => {
          calls.push({ url: String(input), method: init?.method, body: init?.body });
          return new Response(JSON.stringify({ ErrorMessage: `no access for ${MARKER}` }), {
            status
          });
        }
      });
    const context = { signal: new AbortController().signal };

    await expect(answering(200).check(context)).resolves.toEqual({ ok: true });
    await expect(answering(401).check(context)).resolves.toEqual({
      ok: false,
      errorClass: "access_denied"
    });
    await expect(answering(500).check(context)).resolves.toEqual({
      ok: false,
      errorClass: "rejected"
    });
    // A read of the account: no send, no body.
    expect(calls).toEqual(
      Array.from({ length: 3 }, () => ({
        url: "https://api.mailjet.com/v3/REST/user",
        method: undefined,
        body: undefined
      }))
    );
  });
});
