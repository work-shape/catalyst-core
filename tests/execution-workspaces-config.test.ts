import { describe, expect, it } from "vitest";
import { applyWorkspaceRunnerImageEnvOverride } from "@vivd-catalyst/client-assembly";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";

describe("execution workspaces config", () => {
  it("defaults to disabled execution workspaces with no-network Docker sandbox settings", () => {
    const config = parseClientInstanceConfig(baseConfig());

    expect(config.executionWorkspaces).toMatchObject({
      enabled: false,
      sourceFiles: {
        maxFileBytes: 25 * 1024 * 1024
      },
      runner: {
        mode: "docker",
        networkMode: "none",
        readOnlyRootFilesystem: true,
        cpuCount: 1,
        memoryBytes: 4 * 1024 * 1024 * 1024,
        pidsLimit: 128
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

  it("accepts explicit Docker runner and concurrency settings", () => {
    const config = parseClientInstanceConfig(
      baseConfig({
        executionWorkspaces: {
          enabled: true,
          sourceFiles: {
            maxFileBytes: 128 * 1024 * 1024
          },
          runner: {
            mode: "docker",
            image: "ghcr.io/example/catalyst-runner-base:v1",
            networkMode: "none",
            cpuCount: 2,
            memoryBytes: 1024 * 1024 * 1024,
            pidsLimit: 256
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
      runner: {
        image: "ghcr.io/example/catalyst-runner-base:v1",
        networkMode: "none",
        cpuCount: 2,
        memoryBytes: 1024 * 1024 * 1024,
        pidsLimit: 256
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

  it("keeps local workspace runner mode development-only when execution workspaces are enabled", () => {
    const development = parseClientInstanceConfig(
      baseConfig({
        executionWorkspaces: {
          enabled: true,
          runner: {
            mode: "local"
          }
        }
      })
    );

    expect(development.executionWorkspaces.runner.mode).toBe("local");

    expect(() =>
      parseClientInstanceConfig(
        baseConfig({
          clientInstance: {
            id: "config-test",
            displayName: "Config Test",
            environment: "staging"
          },
          executionWorkspaces: {
            enabled: true,
            runner: {
              mode: "local"
            }
          }
        })
      )
    ).toThrow(/Local execution workspace runner mode is only allowed for development/u);
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
        executionWorkspaces: {
          enabled: true,
          runner: {
            image: "ghcr.io/example/catalyst-runner-base:placeholder"
          }
        }
      })
    );

    const resolved = applyWorkspaceRunnerImageEnvOverride(config, {
      EXECUTION_WORKSPACE_RUNNER_IMAGE:
        "ghcr.io/example/vivd-catalyst-musterbau-catalyst-runner-base:staging-20260629"
    });

    expect(resolved.executionWorkspaces.runner.image).toBe(
      "ghcr.io/example/vivd-catalyst-musterbau-catalyst-runner-base:staging-20260629"
    );
    expect(config.executionWorkspaces.runner.image).toBe(
      "ghcr.io/example/catalyst-runner-base:placeholder"
    );
  });
});

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
    modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
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
