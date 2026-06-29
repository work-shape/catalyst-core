import { describe, expect, it } from "vitest";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";

describe("execution workspaces config", () => {
  it("defaults to disabled execution workspaces with no-network Docker sandbox settings", () => {
    const config = parseClientInstanceConfig(baseConfig());

    expect(config.executionWorkspaces).toMatchObject({
      enabled: false,
      runner: {
        mode: "docker",
        networkMode: "none",
        readOnlyRootFilesystem: true,
        pidsLimit: 128
      },
      command: {
        defaultTimeoutSeconds: 60,
        maxTimeoutSeconds: 300,
        idleTimeoutSeconds: 30,
        maxStdoutBytes: 65536,
        maxStderrBytes: 65536,
        maxWorkspaceBytes: 104857600,
        perConversationActiveCommands: 1,
        perUserActiveCommands: 1,
        globalActiveCommands: 4
      },
      worker: {
        concurrency: 1,
        heartbeatIntervalMs: 5000,
        leaseDurationMs: 600000
      }
    });
  });

  it("accepts explicit Docker runner and concurrency settings", () => {
    const config = parseClientInstanceConfig(
      baseConfig({
        executionWorkspaces: {
          enabled: true,
          runner: {
            mode: "docker",
            image: "ghcr.io/example/catalyst-runner-base:v1",
            networkMode: "none",
            cpuCount: 2,
            memoryBytes: 1024 * 1024 * 1024,
            pidsLimit: 256
          },
          command: {
            defaultTimeoutSeconds: 90,
            maxTimeoutSeconds: 180,
            globalActiveCommands: 8
          },
          worker: {
            concurrency: 4,
            heartbeatIntervalMs: 2000,
            leaseDurationMs: 30000
          }
        }
      })
    );

    expect(config.executionWorkspaces).toMatchObject({
      enabled: true,
      runner: {
        image: "ghcr.io/example/catalyst-runner-base:v1",
        networkMode: "none",
        cpuCount: 2,
        memoryBytes: 1024 * 1024 * 1024,
        pidsLimit: 256
      },
      command: {
        defaultTimeoutSeconds: 90,
        maxTimeoutSeconds: 180,
        globalActiveCommands: 8
      },
      worker: {
        concurrency: 4,
        heartbeatIntervalMs: 2000,
        leaseDurationMs: 30000
      }
    });
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
    defaultAgentName: "test_agent",
    agents: [
      {
        name: "test_agent",
        displayName: "Test Agent",
        instructions: "Test."
      }
    ],
    modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
    ...overrides
  };
}

function expectConfigIssue(run: () => void, message: RegExp): void {
  try {
    run();
  } catch (error) {
    const issues = (error as { details?: { issues?: Array<{ message?: string }> } }).details?.issues ?? [];
    expect(issues.some((issue) => message.test(issue.message ?? ""))).toBe(true);
    return;
  }
  throw new Error("Expected config parsing to fail");
}
