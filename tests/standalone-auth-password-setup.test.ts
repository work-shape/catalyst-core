import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStandaloneAuthRuntime, type StandaloneAuthRuntime } from "@vivd-catalyst/auth";
import { asClientInstanceId } from "@vivd-catalyst/core";
import { PostgresPlatformStore } from "@vivd-catalyst/postgres-store";
import postgres from "postgres";

const databaseUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("standalone auth password setup tokens", () => {
  let auth: StandaloneAuthRuntime;
  let sql: ReturnType<typeof postgres>;
  let externalUserId: string;
  const email = `setup-${Date.now()}@example.test`;

  beforeAll(async () => {
    const store = await PostgresPlatformStore.connect({
      databaseUrl: databaseUrl!,
      runMigrations: true
    });
    await store.close();
    sql = postgres(databaseUrl!, { max: 1 });
    auth = await createStandaloneAuthRuntime({
      clientInstanceId: asClientInstanceId("password-setup-test"),
      databaseUrl: databaseUrl!,
      secret: "0123456789abcdef0123456789abcdef",
      baseUrl: "http://127.0.0.1:4100/api/auth"
    });
    const signIn = await auth.setOrCreatePasswordSignIn({
      email,
      displayLabel: "Setup User",
      roles: ["user"],
      permissionRefs: [],
      permissions: [],
      password: "initial-password"
    });
    externalUserId = signIn.externalUserId;
  });

  afterAll(async () => {
    await auth?.deletePasswordSignIn({ externalUserId });
    await auth?.close();
    await sql?.end();
  });

  it("finds a password sign-in by email only within its client instance", async () => {
    expect(await auth.findPasswordSignIn({ email: email.toUpperCase() })).toMatchObject({
      externalUserId,
      email
    });
    expect(await auth.findPasswordSignIn({ email: "missing@example.test" })).toBeUndefined();
  });

  it("stores only a hash, accepts a token once, and revokes sessions", async () => {
    const token = await auth.createPasswordSetupToken({ externalUserId, ttlMs: 60_000 });
    const stored = await sql`select identifier from verification where value = ${externalUserId}`;
    expect(stored).toHaveLength(1);
    expect(String(stored[0]!.identifier)).not.toContain(token);
    await sql`
      insert into session (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
      values (${`ses_${Date.now()}`}, now() + interval '1 day', ${`tok_${Date.now()}`}, now(), now(), ${externalUserId})
    `;

    await expect(
      auth.completePasswordSetup({ token, password: "second-password" })
    ).resolves.toEqual({ externalUserId });
    await expect(auth.completePasswordSetup({ token, password: "third-password" })).rejects.toThrow(
      /invalid or has expired/u
    );
    expect(await sql`select id from session where "userId" = ${externalUserId}`).toHaveLength(0);
    await expect(
      auth.changePassword({
        externalUserId,
        currentPassword: "second-password",
        newPassword: "fourth-password"
      })
    ).resolves.toBeUndefined();
  });

  it("invalidates older and expired tokens", async () => {
    const older = await auth.createPasswordSetupToken({ externalUserId, ttlMs: 60_000 });
    const newer = await auth.createPasswordSetupToken({ externalUserId, ttlMs: 60_000 });
    await expect(
      auth.completePasswordSetup({ token: older, password: "older-password" })
    ).rejects.toThrow(/invalid or has expired/u);

    await auth.setPassword({ externalUserId, password: "admin-set-password" });
    await expect(
      auth.completePasswordSetup({ token: newer, password: "newer-password" })
    ).rejects.toThrow(/invalid or has expired/u);

    const expired = await auth.createPasswordSetupToken({ externalUserId, ttlMs: -1 });
    await expect(
      auth.completePasswordSetup({ token: expired, password: "expired-password" })
    ).rejects.toThrow(/invalid or has expired/u);
  });
});
