import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { fileTestDatabaseUrl } from "./support/test-database";
import { createTestInstance } from "./support/test-instance";
import { afterAll, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../packages/auth/node_modules/better-auth/dist/crypto/index.mjs";
import { createStandaloneAuthRuntime, type StandaloneAuthRuntime } from "@vivd-catalyst/auth";
import { asClientInstanceId } from "@vivd-catalyst/core";

import postgres from "postgres";

vi.mock(
  "../packages/auth/node_modules/better-auth/dist/crypto/index.mjs",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../packages/auth/node_modules/better-auth/dist/crypto/index.mjs")
      >();
    return { ...actual, hashPassword: vi.fn(actual.hashPassword) };
  }
);

let databaseUrl: string;
beforeAll(async () => {
  databaseUrl = await fileTestDatabaseUrl();
});

describe("standalone auth password setup tokens", () => {
  let auth: StandaloneAuthRuntime;
  let sql: ReturnType<typeof postgres>;
  let externalUserId: string;
  const email = `setup-${Date.now()}@example.test`;

  beforeAll(async () => {
    const store = (
      await createTestInstance({
        postgres: {}
      })
    ).stores;
    await store.close();
    sql = postgres(databaseUrl, { max: 1 });
    auth = await createStandaloneAuthRuntime({
      clientInstanceId: asClientInstanceId("password-setup-test"),
      databaseUrl: databaseUrl,
      secret: "0123456789abcdef0123456789abcdef",
      baseUrl: "http://127.0.0.1:4100/api/auth",
      rateLimit: false
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

  it("keeps the link usable when a write fails after the token was taken", async () => {
    const token = await auth.createPasswordSetupToken({ externalUserId, ttlMs: 60_000 });
    const suffix = Date.now();
    const failure = `fail_session_delete_${suffix}`;
    await sql`
      insert into session (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
      values (${`ses_tx_${suffix}`}, now() + interval '1 day', ${`tok_tx_${suffix}`}, now(), now(), ${externalUserId})
    `;
    await sql.unsafe(`
      create function ${failure}() returns trigger language plpgsql as
        $$ begin raise exception 'session delete failed'; end $$;
      create trigger ${failure} before delete on session for each row
        when (old."userId" = '${externalUserId}') execute function ${failure}();
    `);
    try {
      await expect(
        auth.completePasswordSetup({ token, password: "rolled-back-password" })
      ).rejects.toThrow();
    } finally {
      await sql.unsafe(`drop trigger ${failure} on session; drop function ${failure}();`);
    }

    await expect(
      auth.changePassword({
        externalUserId,
        currentPassword: "rolled-back-password",
        newPassword: "unused-password"
      })
    ).rejects.toThrow(/incorrect/u);
    await expect(
      auth.completePasswordSetup({ token, password: "retried-password" })
    ).resolves.toEqual({ externalUserId });
  });

  it("rejects an invalid or expired token without hashing the password", async () => {
    const expired = await auth.createPasswordSetupToken({ externalUserId, ttlMs: -1 });
    vi.mocked(hashPassword).mockClear();
    await expect(
      auth.completePasswordSetup({ token: "not-a-token", password: "any-password" })
    ).rejects.toThrow(/invalid or has expired/u);
    await expect(
      auth.completePasswordSetup({ token: expired, password: "any-password" })
    ).rejects.toThrow(/invalid or has expired/u);
    expect(hashPassword).not.toHaveBeenCalled();

    const valid = await auth.createPasswordSetupToken({ externalUserId, ttlMs: 60_000 });
    await auth.completePasswordSetup({ token: valid, password: "hashed-password" });
    expect(hashPassword).toHaveBeenCalledTimes(1);
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
