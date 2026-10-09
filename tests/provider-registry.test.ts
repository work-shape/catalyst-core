import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createEnvironmentSecrets } from "@vivd-catalyst/client-assembly";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  asClientInstanceId,
  createProvider,
  defineProvider,
  ProviderRegistry,
  resolveOptionalSecret,
  secretRef,
  SecretNotResolvedError
} from "@vivd-catalyst/core";
import { mailProviderDefinitions } from "@vivd-catalyst/mail";
import {
  createModelProviderRegistry,
  DeterministicModelProvider,
  modelProviderDefinitions,
  type ModelProviderFactory
} from "@vivd-catalyst/model-provider";
import { createFailingTestLogger, createFakeSecrets, createTestUser } from "./support/fixtures";
import { createTestInstanceOnSecrets } from "./support/test-instance";

const logger = createFailingTestLogger("A provider must not log an error in this test");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("instance startup on the secret resolver", () => {
  it("starts with an empty environment and takes every secret from the resolver", async () => {
    const config = parseClientInstanceConfig({
      version: 1,
      clientInstance: {
        id: "provider-registry-test",
        displayName: "Provider Registry Test",
        environment: "staging"
      },
      auth: {
        standalone: { enabled: true },
        serviceAccess: { enabled: true }
      },
      infrastructure: {
        models: {
          main: {
            provider: "openai-compatible",
            region: "eu",
            model: "test-model",
            baseUrl: "https://models.example.test/v1",
            credentialSecret: "MODEL_KEY",
            organizationSecret: "MODEL_ORGANIZATION"
          }
        },
        mail: {
          provider: "mailjet",
          region: "eu",
          apiKeySecret: "MAIL_KEY",
          apiSecretSecret: "MAIL_SECRET",
          appUrl: "https://chat.example.test",
          sender: { fromAddress: "noreply@example.test" }
        }
      },
      dataSources: {
        reporting: {
          kind: "postgres",
          connectionRef: "env:REPORTING_DATABASE_URL",
          description: "Reporting warehouse",
          sql: { dialect: "postgres", access: "read_only" },
          tools: { query: { enabled: true } }
        }
      }
    });

    const { instance, resolved } = await createTestInstanceOnSecrets(
      { config, tools: [], seedAssets: false },
      {
        BETTER_AUTH_SECRET: "a-test-secret-with-at-least-32-characters",
        SERVICE_ACCESS_TOKEN_SECRET: "a-service-token-secret-with-32-characters",
        MODEL_KEY: "model-key-value",
        MODEL_ORGANIZATION: "model-organization-value",
        MAIL_KEY: "mail-key-value",
        MAIL_SECRET: "mail-secret-value",
        REPORTING_DATABASE_URL: "postgres://readonly@reporting.example.test/reporting"
      }
    );
    try {
      expect([...resolved].sort()).toEqual(
        expect.arrayContaining([
          "BETTER_AUTH_SECRET",
          "DATABASE_URL",
          "MAIL_KEY",
          "MAIL_SECRET",
          "MODEL_KEY",
          "MODEL_ORGANIZATION",
          "REPORTING_DATABASE_URL",
          "SERVICE_ACCESS_TOKEN_SECRET"
        ])
      );
    } finally {
      await instance.close();
    }
  });

  it("hands the model adapter the resolved credential and the organization", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] })
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const entries = {
      main: {
        provider: "openai-compatible",
        region: "eu",
        model: "test-model",
        baseUrl: "https://models.example.test/v1",
        credentialSecret: "MODEL_KEY",
        organizationSecret: "MODEL_ORGANIZATION"
      }
    };
    const providers = await createModelProviderRegistry({
      registry: new ProviderRegistry(modelProviderDefinitions),
      providers: [{ id: "main", type: "openai-compatible", model: "test-model", region: "eu" }],
      entries,
      context: {
        logger,
        secrets: createFakeSecrets({
          MODEL_KEY: "model-key-value",
          MODEL_ORGANIZATION: "model-organization-value"
        })
      }
    });

    const clientInstanceId = asClientInstanceId("provider-registry-test");
    await providers.complete(
      {
        providerId: "main",
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        tools: []
      },
      {
        clientInstanceId,
        correlationId: "provider-registry-test",
        user: createTestUser("user-1", clientInstanceId)
      }
    );

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://models.example.test/v1/chat/completions");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer model-key-value");
    expect(headers.get("openai-organization")).toBe("model-organization-value");
  });

  it("hands the mail adapter both resolved secrets", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ Messages: [{ Status: "success" }] }))
    );
    vi.stubGlobal("fetch", fetchMock);
    const mail = await new ProviderRegistry(mailProviderDefinitions).create(
      "mail",
      {
        path: "infrastructure.mail",
        entry: {
          provider: "mailjet",
          region: "eu",
          apiKeySecret: "MAIL_KEY",
          apiSecretSecret: "MAIL_SECRET",
          appUrl: "https://chat.example.test",
          sender: { fromAddress: "noreply@example.test" }
        }
      },
      {
        logger,
        secrets: createFakeSecrets({ MAIL_KEY: "mail-key-value", MAIL_SECRET: "mail-secret-value" })
      }
    );

    await mail.transport.deliver(
      { to: { email: "ada@example.test" }, subject: "Subject", text: "Text", html: "<p>Html</p>" },
      { fromAddress: "noreply@example.test", fromName: "Example", productName: "Example" }
    );

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("mail-key-value:mail-secret-value").toString("base64")}`
    );
  });
});

describe("a secret that is configured and broken", () => {
  const sessionTokenConfig = () =>
    parseClientInstanceConfig({
      version: 1,
      clientInstance: {
        id: "provider-registry-test",
        displayName: "Provider Registry Test",
        environment: "staging"
      },
      auth: {
        standalone: { enabled: true },
        sessionToken: { issuer: "provider-registry-test", ttlSeconds: 300 }
      },
      infrastructure: { models: { local: { provider: "deterministic" } } }
    });
  const authSecret = { BETTER_AUTH_SECRET: "a-test-secret-with-at-least-32-characters" };

  it("starts without session-token sign-in when nothing configures its secret", async () => {
    const { instance, resolved } = await createTestInstanceOnSecrets(
      { config: sessionTokenConfig(), tools: [], seedAssets: false },
      authSecret
    );
    try {
      expect(resolved).toContain("CHAT_SESSION_TOKEN_SECRET");
    } finally {
      await instance.close();
    }
  });

  it.each(["CHAT_SESSION_TOKEN_SECRET", "CHAT_SERVER_CREDENTIAL", "SERVICE_ACCESS_TOKEN_SECRET"])(
    "stops startup and names %s when its mounted file cannot be read",
    async (name) => {
      await expect(
        createTestInstanceOnSecrets(
          { config: sessionTokenConfig(), tools: [], seedAssets: false },
          {
            ...authSecret,
            CHAT_SESSION_TOKEN_SECRET: "a-session-token-secret-with-32-characters",
            CHAT_SERVER_CREDENTIAL: "a-server-credential-with-32-characters"
          },
          [name]
        )
      ).rejects.toThrow(`Secret '${name}' could not be read from the file named by '${name}_FILE'`);
    }
  );

  it("tells a broken file from an unset secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vivd-catalyst-secrets-"));
    try {
      const emptyPath = join(directory, "empty");
      await writeFile(emptyPath, "\n", "utf8");
      const secrets = createEnvironmentSecrets({
        EMPTY_KEY_FILE: emptyPath,
        MISSING_KEY_FILE: join(directory, "absent")
      });

      await expect(resolveOptionalSecret(secrets, "UNSET_KEY")).resolves.toBeUndefined();
      await expect(resolveOptionalSecret(secrets, "EMPTY_KEY")).rejects.toThrow(
        "Secret 'EMPTY_KEY' is empty in the file named by 'EMPTY_KEY_FILE'"
      );
      await expect(resolveOptionalSecret(secrets, "MISSING_KEY")).rejects.toThrow(
        "Secret 'MISSING_KEY' could not be read from the file named by 'MISSING_KEY_FILE'"
      );
      await expect(secrets.resolve("MISSING_KEY")).rejects.toMatchObject({ kind: "unusable" });
      await expect(secrets.resolve("UNSET_KEY")).rejects.toMatchObject({ kind: "absent" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("environment secret provider", () => {
  it("reads a mounted secret from the file that NAME_FILE names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vivd-catalyst-secrets-"));
    try {
      const path = join(directory, "model-key");
      await writeFile(path, "mounted-value\n", "utf8");
      const secrets = createEnvironmentSecrets({
        MODEL_KEY_FILE: path,
        DIRECT: "direct-value",
        DIRECT_FILE: path,
        MISSING_FILE: join(directory, "absent")
      });

      await expect(secrets.resolve("MODEL_KEY")).resolves.toBe("mounted-value");
      // The variable itself wins over its file.
      await expect(secrets.resolve("DIRECT")).resolves.toBe("direct-value");
      await expect(secrets.resolve("MISSING")).rejects.toThrow(
        "Secret 'MISSING' could not be read from the file named by 'MISSING_FILE'"
      );
      await expect(secrets.resolve("UNSET")).rejects.toThrow(
        "Secret 'UNSET' is not set: neither the variable 'UNSET' nor 'UNSET_FILE' is present"
      );
      await expect(secrets.resolve("UNSET")).rejects.toBeInstanceOf(SecretNotResolvedError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("provider registry", () => {
  const vault = defineProvider({
    port: "objectStorage",
    type: "vault",
    configSchema: z.object({ bucket: z.string().min(1), keySecret: secretRef() }),
    external: true,
    create: async (config, { secrets }) => ({
      bucket: config.bucket,
      key: await secrets.resolve(config.keySecret)
    }),
    describe: (config) => ({ bucket: config.bucket })
  });
  const entry = {
    path: "infrastructure.objectStorage.files",
    entry: { provider: "vault", region: "eu", bucket: "documents", keySecret: "VAULT_KEY" }
  };

  it("validates an entry without reading a secret and describes it without one", () => {
    const registry = new ProviderRegistry([vault]);

    expect(registry.validate("objectStorage", entry)).toEqual({
      port: "objectStorage",
      type: "vault",
      external: true,
      region: "eu",
      secrets: [{ field: "keySecret", name: "VAULT_KEY" }],
      description: { bucket: "documents" }
    });
    expect(() => registry.register(vault)).toThrow(
      "Provider 'vault' is registered twice for the port 'objectStorage'"
    );
    expect(() => registry.validate("sandbox", { path: "infrastructure.sandbox", entry })).toThrow(
      "'infrastructure.sandbox.provider' is not a registered provider for the port 'sandbox'; registered: none"
    );
  });

  it("creates a model provider that only a capability registers", async () => {
    const created: string[] = [];
    const capabilityModel = defineProvider({
      port: "models",
      type: "capability-model",
      configSchema: z.object({ keySecret: secretRef() }),
      external: true,
      create: async (config, { secrets }): Promise<ModelProviderFactory> => {
        created.push(await secrets.resolve(config.keySecret));
        return (provider) => new DeterministicModelProvider(provider.id);
      },
      describe: () => ({})
    });
    const registry = new ProviderRegistry([...modelProviderDefinitions, capabilityModel]);

    const providers = await createModelProviderRegistry({
      registry,
      providers: [{ id: "main", type: "capability-model", model: "m", region: "eu" }],
      entries: {
        main: {
          provider: "capability-model",
          region: "eu",
          model: "m",
          keySecret: "CAPABILITY_KEY"
        }
      },
      context: { logger, secrets: createFakeSecrets({ CAPABILITY_KEY: "resolved" }) }
    });

    expect(created).toEqual(["resolved"]);
    const clientInstanceId = asClientInstanceId("provider-registry-test");
    await expect(
      providers.complete(
        {
          providerId: "main",
          model: "m",
          messages: [{ role: "user", content: "hello" }],
          tools: []
        },
        {
          clientInstanceId,
          correlationId: "provider-registry-test",
          user: createTestUser("user-1", clientInstanceId)
        }
      )
    ).resolves.toBeDefined();
  });

  it("creates a provider with the secrets its schema names", async () => {
    await expect(
      createProvider([vault], "objectStorage", entry, {
        logger,
        secrets: createFakeSecrets({ VAULT_KEY: "vault-key-value" })
      })
    ).resolves.toEqual({ bucket: "documents", key: "vault-key-value" });
  });
});
