import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { z } from "zod";
import { infrastructureSchema } from "@work-shape/catalyst-api-contract";
import { InfrastructureWorkflow, type InfrastructureEntry } from "@work-shape/catalyst-server";
import {
  createInstanceInfrastructure,
  declaredSecretNames,
  infrastructureOverview
} from "@work-shape/catalyst-client-assembly";
import { getClientInstanceId, parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  defineProvider,
  legacyPermissionFor,
  type Logger,
  type SecretResolver
} from "@work-shape/catalyst-core";
import type { ModelAdapterFactory } from "@work-shape/catalyst-model-provider";
import { createFakeSecrets } from "./fixtures";
import { asCaller, createCallerAuthAdapter } from "./route-callers";
import { createTestInstanceWith } from "./test-instance";

// The instance the Infrastructure tests run against: its release config, its secrets and
// the API process with the workflow on a clock the test moves.

export const MARKER = "secret-marker-5d1e9c";
export const administrator = asCaller({
  id: "usr_admin",
  roles: ["admin"],
  permissions: [legacyPermissionFor("users.manage")]
});
export const member = asCaller({ id: "usr_member", roles: ["user"] });

/**
 * Every secret of the instance carries the marker. `SUMMER_2024` stands where a name belongs,
 * reads as one and resolves to nothing: a password typed into the field of a reference.
 */
export const secretValues = {
  DATABASE_URL: `postgres://catalyst:${MARKER}@database.example.test:5432/catalyst`,
  MODEL_KEY: `${MARKER}-model-key`,
  MODEL_ORGANIZATION: `${MARKER}-organization`,
  MAIL_KEY: `${MARKER}-mail-key`,
  MAIL_SECRET: `${MARKER}-mail-secret`,
  STORE_ACCESS_KEY: `${MARKER}-access-key`,
  STORE_SECRET_KEY: `${MARKER}-secret-key`
};

/** A provider whose check throws what a vendor's client throws: text with the credential. */
export const throwingModelProvider = defineProvider({
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

export function recordingLogger(): { logger: Logger; lines: unknown[] } {
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
export async function createServer(
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
      jobs: stores.jobs,
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
    },
    setNow(to: Date) {
      now = to;
    }
  };
}

/** The model endpoint refuses the key and says why; Mailjet's client fails with its header. */
export function stubProviders(): { requests: { url: string; headers: Record<string, string> }[] } {
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

export const read = (response: { json(): unknown }) => infrastructureSchema.parse(response.json());
export const byId = (infrastructure: z.infer<typeof infrastructureSchema>) =>
  Object.fromEntries(infrastructure.items.map((item) => [item.id, item]));
