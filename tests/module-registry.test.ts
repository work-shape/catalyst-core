import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apiOperations, safeConfigSchema } from "@vivd-catalyst/api-contract";
import { defineCapability } from "@vivd-catalyst/capability-sdk";
import {
  createClientInstanceApp,
  platformModules,
  resolveInstanceModules
} from "@vivd-catalyst/client-assembly";
import {
  createSafeConfigView,
  isPasswordMailEnabled,
  loadClientInstanceConfigFromFile,
  parseClientInstanceConfig,
  resolveModuleSwitches,
  type ClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import {
  createModuleRegistry,
  defineModule,
  MODULE_NAMES,
  type ModuleSnapshot
} from "@vivd-catalyst/core";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance } from "./support/test-instance";

const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Stands in for a capability package that ships the `documents` module. */
function documentsCapability(seen: { modules?: ModuleSnapshot } = {}) {
  return defineCapability({
    name: "documents-stand-in",
    configKey: "documentProcessing",
    modules: [defineModule({ name: "documents", tools: ["read_document"] })],
    create(context) {
      seen.modules = context.modules;
      return {};
    }
  });
}

function states(snapshot: ModuleSnapshot): Record<string, boolean> {
  return Object.fromEntries(snapshot.modules.map((module) => [module.name, module.enabled]));
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    clientInstance: { id: "module-test", displayName: "Module Test", environment: "development" },
    auth: { development: { enabled: true } },
    infrastructure: { models: { local: { provider: "deterministic", model: "local" } } },
    ...overrides
  };
}

const emptyAssets = { version: 0, agents: [], skills: [] };
const mailEntry = {
  provider: "capture",
  appUrl: "http://127.0.0.1:5173",
  sender: { fromAddress: "noreply@example.test" }
};

describe("the module registry", () => {
  it("fails on a module name the product does not know, naming it", () => {
    const registry = createModuleRegistry(platformModules);

    expect(() => registry.snapshot({ resourcs: { enabled: false } })).toThrow(
      /Unknown module 'resourcs' under 'modules'\. Known modules: documents, resources/u
    );
  });

  it("fails on an enabled module this build ships no code for, naming it", () => {
    const registry = createModuleRegistry(platformModules);

    expect(() => registry.snapshot({ documents: { enabled: true } })).toThrow(
      /Module 'documents' is enabled but this build ships no code for it/u
    );
    // Off, it needs no code.
    expect(registry.snapshot({ documents: { enabled: false } }).isEnabled("documents")).toBe(false);
  });

  it("fails on an enabled module whose required module is off, naming both", () => {
    const registry = createModuleRegistry([
      defineModule({ name: "resources", requires: ["documents"] }),
      defineModule({ name: "documents" })
    ]);

    expect(() => registry.snapshot({ resources: { enabled: true } })).toThrow(
      /Module 'resources' requires module 'documents', which is off/u
    );
    // Nothing turns a required module on implicitly, and both on is fine.
    expect(
      states(registry.snapshot({ resources: { enabled: true }, documents: { enabled: true } }))
    ).toMatchObject({ resources: true, documents: true });
  });

  it("fails on a module registered twice, naming it", () => {
    expect(() =>
      createModuleRegistry([...platformModules, defineModule({ name: "resources" })])
    ).toThrow(/Module 'resources' is registered more than once/u);
  });

  it("is frozen, and so is the snapshot it resolves", () => {
    const registry = createModuleRegistry(platformModules);
    const snapshot = registry.snapshot({ resources: { enabled: true } });

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.modules)).toBe(true);
    expect(registry.modules.every((module) => Object.isFrozen(module.operations))).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.modules)).toBe(true);
    expect(snapshot.modules.map((module) => module.name)).toEqual([...MODULE_NAMES]);
  });

  it("registers only operations the API catalog has", () => {
    const operationIds = new Set(Object.keys(apiOperations));

    for (const module of platformModules) {
      for (const operation of module.operations ?? []) {
        expect(operationIds, `${module.name}: ${operation}`).toContain(operation);
      }
    }
  });
});

describe("legacy module switches", () => {
  it("gives each module the state its legacy key or former default gave it", () => {
    const untouched = parseClientInstanceConfig(baseConfig());
    expect(resolveModuleSwitches(untouched)).toEqual({
      documents: { enabled: false },
      resources: { enabled: true },
      assetManagement: { enabled: false },
      userInvitations: { enabled: false }
    });

    const legacy = parseClientInstanceConfig(
      baseConfig({
        auth: { standalone: { enabled: true, baseUrl: "http://127.0.0.1:4100/api/auth" } },
        infrastructure: {
          models: { local: { provider: "deterministic", model: "local" } },
          mail: mailEntry
        },
        administration: { agentConfiguration: { enabled: true } },
        capabilities: { documentProcessing: { enabled: true } },
        ui: { resources: { enabled: false } }
      })
    );
    expect(resolveModuleSwitches(legacy)).toEqual({
      documents: { enabled: true },
      resources: { enabled: false },
      assetManagement: { enabled: true },
      userInvitations: { enabled: true }
    });
  });

  it("takes the new key where it is the only one set", () => {
    const config = parseClientInstanceConfig(
      baseConfig({
        modules: { resources: { enabled: false }, assetManagement: { enabled: true } }
      })
    );

    expect(resolveModuleSwitches(config)).toMatchObject({
      resources: { enabled: false },
      assetManagement: { enabled: true }
    });
  });

  it("accepts both keys when they agree", () => {
    const config = parseClientInstanceConfig(
      baseConfig({
        modules: { assetManagement: { enabled: true } },
        administration: { agentConfiguration: { enabled: true } }
      })
    );

    expect(resolveModuleSwitches(config).assetManagement).toEqual({ enabled: true });
  });

  it.each([
    {
      name: "resources",
      legacyKey: "ui.resources.enabled",
      legacy: { ui: { resources: { enabled: true } } }
    },
    {
      name: "assetManagement",
      legacyKey: "administration.agentConfiguration.enabled",
      legacy: { administration: { agentConfiguration: { enabled: true } } }
    },
    {
      name: "documents",
      legacyKey: "capabilities.documentProcessing.enabled",
      legacy: { capabilities: { documentProcessing: { enabled: true } } }
    }
  ])("refuses $name set to different values under both keys, naming both", (row) => {
    const parse = () =>
      parseClientInstanceConfig(
        baseConfig({ ...row.legacy, modules: { [row.name]: { enabled: false } } })
      );

    expect(parse).toThrow(`'modules.${row.name}.enabled' is false`);
    expect(parse).toThrow(`the legacy key '${row.legacyKey}' is true`);
  });

  it("refuses invitations that are switched on where no invitation can be sent", () => {
    expect(() =>
      parseClientInstanceConfig(baseConfig({ modules: { userInvitations: { enabled: true } } }))
    ).toThrow(/Module 'userInvitations' is enabled but invitations cannot be sent/u);
  });

  it("lets an instance that can send invitations switch them off", () => {
    const config = parseClientInstanceConfig(
      baseConfig({
        auth: { standalone: { enabled: true, baseUrl: "http://127.0.0.1:4100/api/auth" } },
        infrastructure: {
          models: { local: { provider: "deterministic", model: "local" } },
          mail: mailEntry
        },
        modules: { userInvitations: { enabled: false } }
      })
    );

    expect(resolveModuleSwitches(config).userInvitations).toEqual({ enabled: false });
  });
});

/**
 * What main computed for each feature before the `modules` section existed, written out from
 * its sources: `safe-config.ts` for resources, asset management and invitations, and the
 * document capability's own flag.
 */
function featuresBeforeModules(config: ClientInstanceConfig): Record<string, boolean> {
  const documents: unknown = config.capabilities.documentProcessing;
  return {
    documents:
      typeof documents === "object" &&
      documents !== null &&
      Reflect.get(documents, "enabled") === true,
    resources: config.ui.resources.enabled ?? true,
    assetManagement: config.administration.agentConfiguration.enabled ?? false,
    userInvitations: isPasswordMailEnabled(config)
  };
}

/** An instance config is committed as `config/app*.yaml` beside a client's sources. */
function instanceConfigFiles(root: string): string[] {
  const directory = join(root, "config");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => /^app.*\.ya?ml$/u.test(file))
    .map((file) => join(directory, file));
}

// The platform's own configs, and those of the customer repositories where the platform is
// checked out beside them, as it is in the development workspace. They are read, not changed.
const workspaceRoot = resolve(platformRoot, "..");
const committedConfigFiles = [
  join(platformRoot, "tests/fixtures/e2e-app.yaml"),
  ...instanceConfigFiles(join(platformRoot, "clients/demo")),
  ...readdirSync(workspaceRoot)
    .filter((entry) => entry.startsWith("deployment."))
    .flatMap((entry) => instanceConfigFiles(join(workspaceRoot, entry)))
];

describe("committed instance configs", () => {
  it("includes the reference client's config", () => {
    expect(committedConfigFiles).toContain(join(platformRoot, "clients/demo/config/app.yaml"));
  });

  it.for(committedConfigFiles)("%s keeps every feature as it was", async (file, context) => {
    let config: ClientInstanceConfig;
    try {
      config = await loadClientInstanceConfigFromFile(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A file that is no entry config (a base that others extend) or that an earlier release
      // already refuses does not load on main either. Nothing about modules may be the reason.
      expect(message).not.toMatch(/module/iu);
      context.skip(`does not load without this change either: ${message.slice(0, 120)}`);
      return;
    }
    if (Object.keys(config.modules).length > 0) {
      context.skip("states its modules itself; the tests around this one hold its features");
      return;
    }
    const expected = featuresBeforeModules(config);

    const { snapshot } = resolveInstanceModules(config, [documentsCapability()]);
    expect(states(snapshot)).toEqual(expected);

    const safe = createSafeConfigView(config, emptyAssets, snapshot);
    expect(safe.features.resources.enabled).toBe(expected.resources);
    expect(safe.features.configAssets.enabled).toBe(expected.assetManagement);
    expect(safe.features.userInvitations.enabled).toBe(expected.userInvitations);
  });
});

describe("the snapshot in a running instance", () => {
  it("serves the reference client's modules and the features it served before", async () => {
    const config = await loadClientInstanceConfigFromFile(
      join(platformRoot, "clients/demo/config/app.yaml")
    );
    const safe = createSafeConfigView(config, emptyAssets, resolveInstanceModules(config).snapshot);

    expect(safe.modules).toEqual({
      documents: { enabled: false },
      resources: { enabled: true },
      assetManagement: { enabled: true },
      userInvitations: { enabled: true }
    });
    expect(safe.features).toEqual({
      attachments: { enabled: false, accept: "" },
      resources: { enabled: true },
      configAssets: {
        enabled: true,
        editableAgentFields: [
          "displayName",
          "description",
          "welcomeMessage",
          "welcomeSubtitle",
          "instructions",
          "modelBindingId",
          "reasoningEffort",
          "toolNames",
          "skillNames",
          "initialPrompts"
        ],
        allowAgentCreation: true,
        allowAgentDeletion: true,
        allowDefaultAgentChange: true,
        allowSkillEditing: true,
        agentSkillChanges: { enabled: true, allowSkillCreation: true }
      },
      userInvitations: { enabled: true }
    });
  });

  it("answers the config operation with the modules and the features derived from them", async () => {
    const instance = await createTestInstance({
      config: parseClientInstanceConfig({
        ...createTestConfig(),
        modules: { resources: { enabled: false } }
      }),
      tools: []
    });
    try {
      const response = await instance.call("config.get", {});
      expect(response.statusCode).toBe(200);
      const answer = safeConfigSchema.parse(response.json());
      expect(answer.modules).toEqual({
        documents: { enabled: false },
        resources: { enabled: false },
        assetManagement: { enabled: false },
        userInvitations: { enabled: false }
      });
      expect(answer.features.resources).toEqual({ enabled: false });
    } finally {
      await instance.close();
    }
  });

  it("hands a capability the snapshot and stops before any service on an invalid one", async () => {
    const seen: { modules?: ModuleSnapshot } = {};
    const instance = await createTestInstance({
      config: parseClientInstanceConfig({
        ...createTestConfig(),
        capabilities: { documentProcessing: { enabled: true } }
      }),
      tools: [],
      capabilities: [documentsCapability(seen)]
    });
    await instance.close();
    expect(seen.modules?.isEnabled("documents")).toBe(true);

    // No database and no secret is configured here: the refusal comes before either is needed.
    await expect(
      createClientInstanceApp({
        config: parseClientInstanceConfig({
          ...createTestConfig(),
          modules: { documents: { enabled: true } }
        }),
        env: {},
        tools: []
      })
    ).rejects.toThrow(/Module 'documents' is enabled but this build ships no code for it/u);
  });
});
