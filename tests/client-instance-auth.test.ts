import { describe, expect, it } from "vitest";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { resolveTrustedOrigins } from "../packages/client-assembly/src/auth";

describe("client instance standalone auth trusted origins", () => {
  it("grants no tool permissions to a default or partial development user", () => {
    const base = {
      version: 1,
      auth: { development: {} },
      clientInstance: { id: "test", displayName: "Test", environment: "development" },
      infrastructure: { models: { local: { provider: "deterministic", model: "local" } } }
    };
    expect(parseClientInstanceConfig(base).auth.development?.user.permissionRefs).toEqual([]);
    expect(
      parseClientInstanceConfig({
        ...base,
        auth: { development: { enabled: true, user: { id: "test-user" } } }
      }).auth.development?.user.permissionRefs
    ).toEqual([]);
    expect(
      parseClientInstanceConfig({
        ...base,
        auth: { development: { enabled: true, user: { permissionRefs: ["test-tools"] } } }
      }).auth.development?.user.permissionRefs
    ).toEqual(["test-tools"]);
  });

  it("expands local loopback aliases for development standalone login", () => {
    const origins = resolveTrustedOrigins({
      config: createTestConfig({
        environment: "development",
        trustedOrigins: ["http://127.0.0.1:5173"]
      }),
      env: {
        CHAT_UI_ORIGIN: "http://localhost:5173/"
      }
    });

    expect(origins).toEqual([
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://[::1]:5173"
    ]);
  });

  it("does not expand local loopback aliases for production config", () => {
    const origins = resolveTrustedOrigins({
      config: createTestConfig({
        environment: "production",
        trustedOrigins: ["http://127.0.0.1:5173"]
      }),
      env: {}
    });

    expect(origins).toEqual(["http://127.0.0.1:5173"]);
  });

  it("merges and normalizes all configured origins into one deduplicated list", () => {
    expect(
      resolveTrustedOrigins({
        config: createTestConfig({
          environment: "production",
          trustedOrigins: ["https://login.example.test/path", "https://ui.example.test/"]
        }),
        env: { CHAT_UI_ORIGIN: "https://ui.example.test" },
        allowedOrigins: ["https://embed.example.test/", "https://ui.example.test"]
      })
    ).toEqual([
      "https://embed.example.test",
      "https://ui.example.test",
      "https://login.example.test"
    ]);
  });

  it("accepts and serializes a single configured origin", () => {
    expect(
      resolveTrustedOrigins({
        config: createTestConfig({ environment: "production", trustedOrigins: [] }),
        env: {},
        allowedOrigins: "https://UI.example.test:443/path"
      })
    ).toEqual(["https://ui.example.test"]);
  });

  it("rejects development auth in production config", () => {
    expect(() =>
      parseClientInstanceConfig({
        version: 1,
        clientInstance: {
          id: "demo-local",
          displayName: "Demo",
          environment: "production"
        },
        auth: {
          development: {
            enabled: true
          }
        },
        infrastructure: { models: { local: { provider: "deterministic", model: "local" } } }
      })
    ).toThrow(/Development auth must not be enabled in production/u);
  });

  it("rejects development seed passwords in production config", () => {
    expect(() =>
      createTestConfig({
        environment: "production",
        trustedOrigins: [],
        seedUsers: [
          {
            displayLabel: "Production User",
            email: "user@example.test",
            emailEnvName: "USER_EMAIL",
            passwordEnvName: "USER_PASSWORD",
            developmentPassword: "development-password",
            roles: ["user"],
            permissionRefs: []
          }
        ]
      })
    ).toThrow(/developmentPassword in production config/u);
  });
});

function createTestConfig(input: {
  environment: "development" | "production";
  trustedOrigins: string[];
  seedUsers?: Array<{
    displayLabel: string;
    email: string;
    emailEnvName?: string;
    passwordEnvName: string;
    developmentPassword?: string;
    roles: string[];
    permissionRefs: string[];
  }>;
}) {
  return parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: "demo-local",
      displayName: "Demo",
      environment: input.environment
    },
    auth: {
      standalone: {
        enabled: true,
        trustedOrigins: input.trustedOrigins,
        seedUsers: input.seedUsers ?? []
      }
    },
    infrastructure: { models: { local: { provider: "deterministic", model: "local" } } }
  });
}
