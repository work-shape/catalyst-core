import { describe, expect, it } from "vitest";
import { applyWorkspaceRunnerImageEnvOverride } from "@vivd-catalyst/client-assembly";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";

describe("execution workspaces config", () => {
  it("defaults to disabled execution workspaces", () => {
    const config = parseClientInstanceConfig(baseConfig());

    expect(config.executionWorkspaces).toMatchObject({
      enabled: false,
      sourceFiles: {
        maxFileBytes: 25 * 1024 * 1024
      },
      command: {
        defaultTimeoutSeconds: 60,
        maxTimeoutSeconds: 300,
        idleTimeoutSeconds: 30,
        maxStdoutBytes: 65536,
        maxStderrBytes: 65536,
        maxWorkspaceBytes: 104857600
      },
      worker: {
        concurrency: 1,
        heartbeatIntervalMs: 5000,
        leaseDurationMs: 600000
      },
      cleanup: {
        deletedWorkspaceCleanupIntervalMs: 3600000,
        deletedWorkspaceCleanupBatchSize: 100,
        tempStateCleanupIntervalMs: 600000,
        hydratedWorkspaceIdleTtlMs: 3600000
      }
    });
  });

  it("accepts explicit command, worker and cleanup settings", () => {
    const config = parseClientInstanceConfig(
      baseConfig({
        infrastructure: workspaceInfrastructure({
          provider: "docker",
          image: "ghcr.io/example/catalyst-runner-base:v1",
          cpuCount: 2,
          memoryBytes: 1024 * 1024 * 1024,
          pidsLimit: 256
        }),
        executionWorkspaces: {
          enabled: true,
          sourceFiles: {
            maxFileBytes: 128 * 1024 * 1024
          },
          command: {
            defaultTimeoutSeconds: 600,
            maxTimeoutSeconds: 900,
            idleTimeoutSeconds: 600,
            maxStdoutBytes: 2 * 1024 * 1024,
            maxStderrBytes: 2 * 1024 * 1024
          },
          worker: {
            concurrency: 4,
            heartbeatIntervalMs: 2000,
            leaseDurationMs: 30000
          },
          cleanup: {
            deletedWorkspaceCleanupIntervalMs: 300000,
            deletedWorkspaceCleanupBatchSize: 25,
            tempStateCleanupIntervalMs: 60000,
            hydratedWorkspaceIdleTtlMs: 0
          }
        }
      })
    );

    expect(config.executionWorkspaces).toMatchObject({
      enabled: true,
      sourceFiles: {
        maxFileBytes: 128 * 1024 * 1024
      },
      command: {
        defaultTimeoutSeconds: 600,
        maxTimeoutSeconds: 900,
        idleTimeoutSeconds: 600,
        maxStdoutBytes: 2 * 1024 * 1024,
        maxStderrBytes: 2 * 1024 * 1024
      },
      worker: {
        concurrency: 4,
        heartbeatIntervalMs: 2000,
        leaseDurationMs: 30000
      },
      cleanup: {
        deletedWorkspaceCleanupIntervalMs: 300000,
        deletedWorkspaceCleanupBatchSize: 25,
        tempStateCleanupIntervalMs: 60000,
        hydratedWorkspaceIdleTtlMs: 0
      }
    });
  });

  it("requires a workspace store and a sandbox when execution workspaces are enabled", () => {
    expect(() =>
      parseClientInstanceConfig(baseConfig({ executionWorkspaces: { enabled: true } }))
    ).toThrow(
      "'infrastructure.objectStorage.workspaces' is required when execution workspaces are enabled"
    );
    expect(() =>
      parseClientInstanceConfig(
        baseConfig({
          infrastructure: {
            models,
            objectStorage: { workspaces: { provider: "filesystem", root: "/tmp/objects" } }
          },
          executionWorkspaces: { enabled: true }
        })
      )
    ).toThrow("'infrastructure.sandbox' is required when execution workspaces are enabled");
  });

  it("keeps the local sandbox development-only when execution workspaces are enabled", () => {
    const development = parseClientInstanceConfig(
      baseConfig({
        infrastructure: workspaceInfrastructure({ provider: "local" }),
        executionWorkspaces: { enabled: true }
      })
    );

    expect(development.infrastructure.sandbox?.provider).toBe("local");

    expect(() =>
      parseClientInstanceConfig(
        baseConfig({
          clientInstance: {
            id: "config-test",
            displayName: "Config Test",
            environment: "staging"
          },
          infrastructure: workspaceInfrastructure({ provider: "local" }),
          executionWorkspaces: { enabled: true }
        })
      )
    ).toThrow(
      "'infrastructure.sandbox.provider': the local sandbox is only allowed for development client instances"
    );
  });

  it("rejects unsafe timeout and heartbeat settings", () => {
    expectConfigIssue(
      () =>
        parseClientInstanceConfig(
          baseConfig({
            executionWorkspaces: {
              command: {
                defaultTimeoutSeconds: 120,
                maxTimeoutSeconds: 60
              }
            }
          })
        ),
      /Default workspace command timeout/u
    );

    expectConfigIssue(
      () =>
        parseClientInstanceConfig(
          baseConfig({
            executionWorkspaces: {
              worker: {
                heartbeatIntervalMs: 30000,
                leaseDurationMs: 30000
              }
            }
          })
        ),
      /heartbeat interval/u
    );
  });

  it("lets the workspace command worker use the deployment-built runner image tag", () => {
    const config = parseClientInstanceConfig(
      baseConfig({
        infrastructure: workspaceInfrastructure({
          provider: "docker",
          image: "ghcr.io/example/catalyst-runner-base:placeholder"
        }),
        executionWorkspaces: { enabled: true }
      })
    );

    const resolved = applyWorkspaceRunnerImageEnvOverride(config, {
      EXECUTION_WORKSPACE_RUNNER_IMAGE:
        "ghcr.io/example/vivd-catalyst-musterbau-catalyst-runner-base:staging-20260629"
    });

    expect(resolved.infrastructure.sandbox?.image).toBe(
      "ghcr.io/example/vivd-catalyst-musterbau-catalyst-runner-base:staging-20260629"
    );
    expect(config.infrastructure.sandbox?.image).toBe(
      "ghcr.io/example/catalyst-runner-base:placeholder"
    );
  });

  it("leaves a sandbox that is not Docker alone when the runner image variable is set", () => {
    const config = parseClientInstanceConfig(
      baseConfig({
        infrastructure: workspaceInfrastructure({ provider: "local" }),
        executionWorkspaces: { enabled: true }
      })
    );

    const resolved = applyWorkspaceRunnerImageEnvOverride(config, {
      EXECUTION_WORKSPACE_RUNNER_IMAGE: "ghcr.io/example/catalyst-runner-base:staging"
    });

    expect(resolved).toBe(config);
    expect(resolved.infrastructure.sandbox).toEqual({ provider: "local" });
  });
});

const models = { local: { provider: "deterministic", model: "local" } };

function workspaceInfrastructure(sandbox: Record<string, unknown>) {
  return {
    models,
    objectStorage: { workspaces: { provider: "filesystem", root: "/tmp/objects" } },
    sandbox
  };
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    clientInstance: {
      id: "config-test",
      displayName: "Config Test",
      environment: "development"
    },
    auth: {
      development: {
        enabled: true
      }
    },
    localization: {
      defaultLocale: "en",
      supportedLocales: ["en"]
    },
    infrastructure: { models },
    ...overrides
  };
}

function expectConfigIssue(run: () => void, message: RegExp): void {
  try {
    run();
  } catch (error) {
    const issues =
      (error as { details?: { issues?: Array<{ message?: string }> } }).details?.issues ?? [];
    expect(issues.some((issue) => message.test(issue.message ?? ""))).toBe(true);
    return;
  }
  throw new Error("Expected config parsing to fail");
}
