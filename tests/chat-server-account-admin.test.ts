import { describe, expect, it } from "vitest";
import { createStandaloneAuthRuntime } from "@work-shape/catalyst-auth";
import { asClientInstanceId } from "@work-shape/catalyst-core";
import { createTestInstanceWith } from "./support/test-instance";
import { fileTestDatabaseUrl } from "./support/test-database";

// DIET-E2E-2: password reset and account removal must change real password sign-in,
// not just the administration response or a mocked password store.
describe("administering standalone password accounts", () => {
  it("refuses the old password after a reset, accepts the new one, and refuses a deleted user", async () => {
    const auth = await createStandaloneAuthRuntime({
      clientInstanceId: asClientInstanceId("demo-local"),
      databaseUrl: await fileTestDatabaseUrl(),
      secret: "test-account-administration-secret-long-enough",
      baseUrl: "http://localhost:3000/api/auth"
    });
    const app = await createTestInstanceWith(() => ({ standaloneAuth: auth }));
    const email = "account-admin@example.test";
    const signIn = (password: string) =>
      auth.handleRequest(
        new Request("http://localhost:3000/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password })
        })
      );
    try {
      const created = await app.call("users.create", {
        payload: {
          displayLabel: "Account administration",
          email,
          roles: ["user"],
          passwordSignIn: { password: "initial-account-password" }
        }
      });
      expect(created.statusCode).toBe(200);
      const { id } = created.json<{ id: string }>();
      expect((await signIn("initial-account-password")).status).toBe(200);
      const reset = await app.call("users.password.reset", {
        params: { userId: id },
        payload: { password: "replacement-account-password" }
      });
      expect(reset.statusCode).toBe(200);
      expect((await signIn("initial-account-password")).status).toBe(401);
      const accepted = await signIn("replacement-account-password");
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toMatchObject({ user: { email } });
      const deleted = await app.call("users.delete", { params: { userId: id } });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toEqual({ state: "deleted" });
      const listed = await app.call("users.list", {});
      expect(listed.statusCode).toBe(200);
      expect(listed.json<{ items: { id: string; email?: string }[] }>().items).not.toContainEqual(
        expect.objectContaining({ id })
      );
      expect((await signIn("replacement-account-password")).status).toBe(401);
    } finally {
      await app.close();
      await auth.close();
    }
  });
});
