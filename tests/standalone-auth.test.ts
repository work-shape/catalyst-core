import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { asClientInstanceId } from "@vivd-catalyst/core";
import { createStandaloneAuthRuntime, type StandaloneAuthRuntime } from "@vivd-catalyst/auth";
import { hashPassword } from "../packages/auth/node_modules/better-auth/dist/crypto/index.mjs";

const { authDatabase, closeDatabase } = vi.hoisted(() => ({
  authDatabase: {
    user: [] as Record<string, unknown>[],
    account: [] as Record<string, unknown>[],
    session: [] as Record<string, unknown>[],
    verification: [] as Record<string, unknown>[]
  },
  closeDatabase: vi.fn()
}));

vi.mock(
  "../packages/auth/node_modules/better-auth/dist/adapters/drizzle-adapter/index.mjs",
  async () => {
    const { memoryAdapter } =
      await import("../packages/auth/node_modules/better-auth/dist/adapters/memory-adapter/index.mjs");
    return {
      drizzleAdapter: () => memoryAdapter(authDatabase)
    };
  }
);

vi.mock("../packages/auth/node_modules/drizzle-orm/postgres-js/index.js", () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              authUserId: "usr_provisioned",
              externalUserId: "provisioned",
              displayLabel: "Provisioned User",
              roles: ["user"],
              permissionRefs: [],
              permissions: []
            }
          ]
        })
      })
    })
  })
}));

vi.mock("postgres", () => ({
  default: () => ({
    options: { parsers: {}, serializers: {} },
    end: closeDatabase
  })
}));

describe("standalone auth email routes", () => {
  const baseUrl = "http://localhost:3000";
  const email = "provisioned@example.test";
  const password = "provisioned-password";
  let auth: StandaloneAuthRuntime;

  beforeAll(async () => {
    const now = new Date();
    authDatabase.user.push({
      id: "usr_provisioned",
      name: "Provisioned User",
      email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now
    });
    authDatabase.account.push({
      id: "acc_provisioned",
      accountId: "usr_provisioned",
      providerId: "credential",
      userId: "usr_provisioned",
      password: await hashPassword(password),
      createdAt: now,
      updatedAt: now
    });
    auth = await createStandaloneAuthRuntime({
      clientInstanceId: asClientInstanceId("standalone_auth_test"),
      databaseUrl: "postgres://unused",
      secret: "test-secret-at-least-32-characters-long",
      baseUrl
    });
  });

  afterAll(async () => {
    await auth?.close();
  });

  it("rejects public email sign-up without creating a user", async () => {
    const response = await postAuth("/api/auth/sign-up/email", {
      name: "Public User",
      email: "public@example.test",
      password: "public-password"
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "EMAIL_PASSWORD_SIGN_UP_DISABLED"
    });
    expect(authDatabase.user).toHaveLength(1);
  });

  it("still signs in a provisioned user", async () => {
    const response = await postAuth("/api/auth/sign-in/email", { email, password });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: { email }
    });
  });

  it("marks successful session-cookie authentication on the adapter result", async () => {
    const response = await postAuth("/api/auth/sign-in/email", { email, password });
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(cookie).not.toBe("");
    const user = await auth.authAdapter.authenticate({
      headers: { cookie },
      clientInstanceId: asClientInstanceId("standalone_auth_test"),
      correlationId: "cookie-auth-test"
    });
    expect(user).toMatchObject({
      id: "usr_provisioned",
      authenticationMethod: "session-cookie"
    });
    await expect(
      auth.authAdapter.authenticate({
        headers: {},
        clientInstanceId: asClientInstanceId("standalone_auth_test"),
        correlationId: "no-cookie-test"
      })
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  function postAuth(path: string, body: Record<string, string>): Promise<Response> {
    return auth.handleRequest(
      new Request(new URL(path, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      })
    );
  }
});
