import { describe, expect, it } from "vitest";
import { createSafeConfigView, parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  createEnvironmentSecretResolver,
  isSecretName,
  resolveOptionalSecret,
  SecretNotResolvedError
} from "@vivd-catalyst/core";
import { createDataSourceRegistry } from "@vivd-catalyst/data-source";
import { createTestInstanceOnSecrets } from "./support/test-instance";

const SECRET_VALUE = "sk-live-4f9c2d7e1a8b-never-printed";
// Credentials that are upper case and alphanumeric, so the shape of a name alone does not
// tell them from one.
const UPPER_CASE_SECRET_VALUES = [
  "AKIAIOSFODNN7EXAMPLE",
  "Q7ZK2M9XP4LT8VB3NH6WR5YD",
  "KJHGFDSAQWERTYUIOPMNBVCXZLKJHG",
  "X9_QWHZKPLMVBNTRXDFGCSJAYEOIU_77",
  "X7K9P2QW4M"
];
const SECRET_NAME_RULE =
  "expected the name of an environment variable such as MODEL_API_KEY (upper-case words joined by underscores, at most 64 characters); the value given does not read as one and looks like a credential value";

const models = { local: { provider: "deterministic" } };

function config(infrastructure: Record<string, unknown>, more: Record<string, unknown> = {}) {
  return {
    version: 1,
    clientInstance: {
      id: "infrastructure-config-test",
      displayName: "Infrastructure Config Test",
      environment: "development"
    },
    auth: { development: { enabled: true } },
    infrastructure,
    ...more
  };
}

/** Starts the app on a fake resolver and returns the failure that stopped it. */
async function startupFailure(
  infrastructure: Record<string, unknown>,
  secrets: Record<string, string> = {}
): Promise<Error> {
  try {
    const { instance } = await createTestInstanceOnSecrets(
      { config: parseClientInstanceConfig(config(infrastructure)), tools: [], seedAssets: false },
      secrets
    );
    await instance.close();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected startup to stop");
}

function expectNoSecretValue(error: Error, value = SECRET_VALUE): void {
  expect(error.message).not.toContain(value);
  expect(JSON.stringify(error)).not.toContain(value);
  expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain(value);
  expect(error.stack ?? "").not.toContain(value);
}

async function failure(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a failure");
}

describe("infrastructure section", () => {
  it("stops startup on a provider type that is not registered, naming the port and the field", async () => {
    const error = await startupFailure({
      models: { main: { provider: "acme-llm", region: "eu", model: "m" } }
    });
    expect(error.message).toBe(
      "'infrastructure.models.main.provider' 'acme-llm' is not a registered provider for the port 'models'; registered: deterministic, openai-compatible"
    );

    const mail = await startupFailure({
      models,
      mail: {
        provider: "pigeon",
        appUrl: "https://chat.example.test",
        sender: { fromAddress: "noreply@example.test" }
      }
    });
    expect(mail.message).toBe(
      "'infrastructure.mail.provider' 'pigeon' is not a registered provider for the port 'mail'; registered: capture, mailjet"
    );
  });

  it("stops startup on an external entry without a region and on a region where none belongs", async () => {
    const error = await startupFailure(
      { models: { main: { provider: "openai-compatible", model: "m", credentialSecret: "KEY" } } },
      { KEY: SECRET_VALUE }
    );
    expect(error.message).toBe(
      "'infrastructure.models.main.region' is required and must be one of eu, global: the 'openai-compatible' provider sends data outside the instance"
    );
    expectNoSecretValue(error);

    const internal = await startupFailure({
      models: { local: { provider: "deterministic", region: "eu" } }
    });
    expect(internal.message).toBe(
      "'infrastructure.models.local.region' must be absent: the 'deterministic' provider keeps data inside the instance"
    );
  });

  it("stops on a config without a model entry", () => {
    const withoutSection = { ...config({}), infrastructure: undefined };
    expect(() => parseClientInstanceConfig(withoutSection)).toThrow(
      "Client instance config is invalid: infrastructure: 'infrastructure' is required: it names the provider per port, and 'infrastructure.models' needs at least one entry"
    );
    expect(() => parseClientInstanceConfig(config({ models: {} }))).toThrow(
      "'infrastructure.models' needs at least one entry; there is no default model provider"
    );
    expect(() =>
      parseClientInstanceConfig(config({ models: { main: { provider: "openai-compatible" } } }))
    ).toThrow("'infrastructure.models.main.model' is required");
  });

  it("stops startup on a secret name that does not resolve, naming the field and no value", async () => {
    const error = await startupFailure(
      {
        models: {
          main: {
            provider: "openai-compatible",
            region: "eu",
            model: "m",
            credentialSecret: "MODEL_KEY",
            organizationSecret: "MODEL_ORGANIZATION"
          }
        }
      },
      { MODEL_KEY: SECRET_VALUE }
    );
    expect(error.message).toBe(
      "'infrastructure.models.main.organizationSecret' names the secret 'MODEL_ORGANIZATION', which does not resolve"
    );
    expectNoSecretValue(error);

    const mail = await startupFailure(
      {
        models,
        mail: {
          provider: "mailjet",
          region: "eu",
          appUrl: "https://chat.example.test",
          sender: { fromAddress: "noreply@example.test" }
        }
      },
      { MAILJET_API_KEY: SECRET_VALUE }
    );
    expect(mail.message).toBe(
      "'infrastructure.mail.apiSecretSecret' names the secret 'MAILJET_API_SECRET', which does not resolve"
    );
    expectNoSecretValue(mail);
  });

  it("never repeats a secret value that was pasted into config", async () => {
    const asName = await startupFailure({
      models: {
        main: {
          provider: "openai-compatible",
          region: "eu",
          model: "m",
          credentialSecret: SECRET_VALUE
        }
      }
    });
    expect(asName.message).toBe(
      `'infrastructure.models.main.credentialSecret' is invalid: ${SECRET_NAME_RULE}`
    );
    expectNoSecretValue(asName);

    const asUnknownKey = await startupFailure({
      models: {
        main: { provider: "openai-compatible", region: "eu", model: "m", apiKey: SECRET_VALUE }
      }
    });
    expect(asUnknownKey.message).toBe(
      "'infrastructure.models.main.apiKey' is not a setting of the 'openai-compatible' provider"
    );
    expectNoSecretValue(asUnknownKey);
  });

  it.each(UPPER_CASE_SECRET_VALUES)(
    "never repeats the upper-case credential %s pasted where a name belongs",
    async (value) => {
      expect(isSecretName(value)).toBe(false);

      const inProvider = await startupFailure({
        models: {
          main: { provider: "openai-compatible", region: "eu", model: "m", credentialSecret: value }
        }
      });
      expect(inProvider.message).toBe(
        `'infrastructure.models.main.credentialSecret' is invalid: ${SECRET_NAME_RULE}`
      );
      expectNoSecretValue(inProvider, value);

      const empty = createEnvironmentSecretResolver({ env: {}, readSecretFile: async () => "" });
      const inResolver = await failure(() => empty.resolve(value));
      expect(inResolver).toBeInstanceOf(SecretNotResolvedError);
      expect(inResolver.message).toBe(`A secret reference is refused: ${SECRET_NAME_RULE}`);
      expectNoSecretValue(inResolver, value);
      // A reference that is not a name is broken config, never an optional secret left unset.
      await expect(resolveOptionalSecret(empty, value)).rejects.toBeInstanceOf(
        SecretNotResolvedError
      );

      const inDataSource = await failure(() =>
        createDataSourceRegistry({
          secrets: empty,
          configs: {
            reporting: {
              kind: "postgres",
              connectionRef: `env:${value}`,
              description: "Reporting warehouse",
              sql: {
                dialect: "postgres",
                access: "read_only",
                statementTimeoutMs: 1000,
                maxRows: 10,
                allowedSchemas: ["public"]
              }
            }
          }
        })
      );
      expect(inDataSource.message).toBe(
        "'dataSources.reporting.connectionRef' must be 'env:' followed by the name of a secret such as REPORTING_DATABASE_URL, never a connection string"
      );
      expectNoSecretValue(inDataSource, value);
    }
  );

  it("names the seed user's field and not the value when its password name is refused", () => {
    for (const value of [...UPPER_CASE_SECRET_VALUES, "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]) {
      const error = (() => {
        try {
          parseClientInstanceConfig({
            ...config({ models }),
            auth: {
              standalone: {
                enabled: true,
                seedUsers: [
                  {
                    email: "admin@example.test",
                    displayLabel: "Admin",
                    passwordEnvName: value,
                    roles: ["superadmin"]
                  }
                ]
              }
            }
          });
        } catch (thrown) {
          if (thrown instanceof Error) {
            return thrown;
          }
        }
        throw new Error("Expected the config to be refused");
      })();
      expect(error.message).toBe(
        `Client instance config is invalid: auth.standalone.seedUsers.0.passwordEnvName: ${SECRET_NAME_RULE}`
      );
      expectNoSecretValue(error, value);
    }
  });

  it("accepts the names deployments use for their secrets", () => {
    for (const name of [
      "DATABASE_URL",
      "MODEL_KEY",
      "AZURE_OPENAI_API_KEY",
      "INTERNAL_CATALYST_DEPLOYMENT_OPENAI_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "S3_SECRET_KEY",
      "OAUTH2_CLIENT_SECRET",
      "E2E_ADMIN_PASSWORD",
      // Ordinary names that begin as a well-known credential does.
      "GHOST_API_KEY",
      "ASIA_MODEL_KEY",
      "AKIA_REGION_KEY",
      "GHP_TOKEN",
      "GHS_DEPLOY_KEY",
      "XOXO_API_KEY",
      "EYJ_SIGNING_KEY",
      "AIZA_MAPS_KEY",
      "MUSTERBAU_SUPERADMIN_PASSWORD",
      "TOKEN"
    ]) {
      expect(isSecretName(name)).toBe(true);
    }
  });

  it("requires a region of a Docker sandbox on another host and none of the local engine", async () => {
    const sandbox = { provider: "docker", image: "runner:test" };
    const remote = await startupFailure({
      models,
      sandbox: { ...sandbox, endpoint: "tcp://docker.example.test:2376" }
    });
    expect(remote.message).toBe(
      "'infrastructure.sandbox.region' is required and must be one of eu, global: the 'docker' provider sends data outside the instance"
    );

    const local = await startupFailure({ models, sandbox: { ...sandbox, region: "eu" } });
    expect(local.message).toBe(
      "'infrastructure.sandbox.region' must be absent: the 'docker' provider keeps data inside the instance"
    );

    const { instance } = await createTestInstanceOnSecrets({
      config: parseClientInstanceConfig(
        config({
          models,
          sandbox: { ...sandbox, region: "eu", endpoint: "ssh://docker.example.test" }
        })
      ),
      tools: [],
      seedAssets: false
    });
    await instance.close();
  });

  it("refuses a model id made only of digits, which would move the default provider", () => {
    expect(() =>
      parseClientInstanceConfig(
        config({
          models: { "20": { provider: "deterministic" }, "3": { provider: "deterministic" } }
        })
      )
    ).toThrow(
      // The file names "20" first; the object already hands back "3" first.
      "'infrastructure.models.3' is not a usable id: an id made only of digits is read before the other entries whatever its place in the file, which would change the default provider. Rename it, for example to 'model-3', also where an agent names it"
    );
  });

  it("keeps secret names and values out of the safe config view", () => {
    const parsed = parseClientInstanceConfig(
      config({
        models: {
          main: {
            provider: "openai-compatible",
            region: "eu",
            model: "m",
            baseUrl: "https://models.example.test/v1",
            credentialSecret: "MODEL_KEY"
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
      })
    );
    const view = JSON.stringify(
      createSafeConfigView(parsed, {
        version: 1,
        defaultAgentName: "assistant",
        agents: [
          {
            name: "assistant",
            displayName: "Assistant",
            instructions: "Answer.",
            modelProviderId: "main",
            toolNames: [],
            skillNames: [],
            initialPrompts: []
          }
        ],
        skills: []
      })
    );
    expect(view).toContain('"region":"eu"');
    for (const hidden of [
      SECRET_VALUE,
      "MODEL_KEY",
      "MAIL_KEY",
      "MAIL_SECRET",
      "models.example.test"
    ]) {
      expect(view).not.toContain(hidden);
    }
  });
});

describe("keys that moved into the infrastructure section", () => {
  const moved: [string, Record<string, unknown>, string][] = [
    [
      "modelProviders",
      { modelProviders: [{ id: "local", type: "deterministic", model: "local" }] },
      "'modelProviders' moved to 'infrastructure.models'"
    ],
    ["mail", { mail: { enabled: false } }, "'mail' moved to 'infrastructure.mail'"],
    [
      "executionWorkspaces.runner",
      { executionWorkspaces: { runner: { mode: "docker" } } },
      "'executionWorkspaces.runner' moved to 'infrastructure.sandbox'"
    ],
    [
      "capabilities.documentProcessing.objectStorage",
      { capabilities: { documentProcessing: { objectStorage: { kind: "s3" } } } },
      "'capabilities.documentProcessing.objectStorage' moved to 'infrastructure.objectStorage.files'"
    ]
  ];

  it.each(moved)("refuses '%s' and names its new place", (_key, old, message) => {
    expect(() => parseClientInstanceConfig(config({ models }, old))).toThrow(message);
  });

  it("says what else changes with a moved key", () => {
    const message = (old: Record<string, unknown>): string => {
      try {
        parseClientInstanceConfig(config({ models }, old));
      } catch (error) {
        if (error instanceof Error) {
          return error.message;
        }
      }
      throw new Error("Expected the config to be refused");
    };
    const regionRequired =
      "'region' is now required for a provider that sends data outside the instance";

    expect(message({ modelProviders: [] })).toContain(regionRequired);
    const mail = message({ mail: { enabled: true } });
    expect(mail).toContain("Drop 'enabled: true'");
    expect(mail).toContain(regionRequired);
    const files = message({ capabilities: { documentProcessing: { objectStorage: {} } } });
    expect(files).toContain(
      "'accessKeyIdEnvName' becomes 'accessKeySecret' and 'secretAccessKeyEnvName' becomes 'secretKeySecret'"
    );
    expect(files).toContain("is required for a provider that sends data outside the instance");
  });

  it("no longer reads the workspace object root from the environment", () => {
    expect(() =>
      parseClientInstanceConfig(config({ models }, { executionWorkspaces: { enabled: true } }))
    ).toThrow(
      "'infrastructure.objectStorage.workspaces' is required when execution workspaces are enabled; the variables EXECUTION_WORKSPACE_OBJECT_ROOT and ARTIFACT_PREVIEW_OBJECT_ROOT are no longer read"
    );
  });
});
