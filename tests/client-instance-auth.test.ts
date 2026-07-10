import { describe, expect, it } from "vitest";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { resolveTrustedOrigins } from "../packages/client-assembly/src/auth";

describe("client instance standalone auth trusted origins", () => {
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
        modelProviders: [{ id: "local", type: "deterministic", model: "local" }]
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
    modelProviders: [{ id: "local", type: "deterministic", model: "local" }]
  });
}
