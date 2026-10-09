import { describe, expect, it } from "vitest";
import { createSafeConfigView, parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { createTestInstanceOnSecrets } from "./support/test-instance";

const SECRET_VALUE = "sk-live-4f9c2d7e1a8b-never-printed";

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

function expectNoSecretValue(error: Error): void {
  expect(error.message).not.toContain(SECRET_VALUE);
  expect(JSON.stringify(error)).not.toContain(SECRET_VALUE);
  expect(error.stack ?? "").not.toContain(SECRET_VALUE);
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
      "'infrastructure.models.main.credentialSecret' is invalid: must be the name of a secret in upper case, digits and underscores, never its value"
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

  it("no longer reads the workspace object root from the environment", () => {
    expect(() =>
      parseClientInstanceConfig(config({ models }, { executionWorkspaces: { enabled: true } }))
    ).toThrow(
      "'infrastructure.objectStorage.workspaces' is required when execution workspaces are enabled; the variables EXECUTION_WORKSPACE_OBJECT_ROOT and ARTIFACT_PREVIEW_OBJECT_ROOT are no longer read"
    );
  });
});
