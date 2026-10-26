import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { asClientInstanceId } from "@work-shape/catalyst-core";
import {
  createStandaloneAuthRuntime,
  type StandaloneAuthRuntime,
  type StandaloneTwoFactorEvent
} from "@work-shape/catalyst-auth";
import { fileTestDatabaseUrl } from "./support/test-database";
import { createTestInstance } from "./support/test-instance";
import {
  CookieJar,
  authUrl,
  backupCodesSchema,
  readJson,
  sessionUserSchema,
  totpCode,
  twoFactorSetupSchema,
  wrongCode
} from "./support/two-factor-client";

const baseUrl = "http://localhost:3000";
const DAY_MS = 24 * 60 * 60 * 1000;

describe("two-factor sign-in in the sign-in library (TWO-FACTOR-1)", () => {
  let auth: StandaloneAuthRuntime;
  let sql: Sql;
  const events: StandaloneTwoFactorEvent[] = [];
  let accountCount = 0;

  beforeAll(async () => {
    await createTestInstance();
    const databaseUrl = await fileTestDatabaseUrl();
    sql = postgres(databaseUrl, { max: 1, onnotice() {} });
    auth = await createStandaloneAuthRuntime({
      clientInstanceId: asClientInstanceId("two_factor_test"),
      databaseUrl,
      secret: "test-secret-at-least-32-characters-long",
      baseUrl,
      twoFactorIssuer: "Catalyst Test"
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    events.length = 0;
  });

  afterAll(async () => {
    await auth?.close();
    await sql?.end();
  });

  it("asks for a code after the password, and gives no session for the password alone", async () => {
    const account = await enrolledAccount();
    const sessionsBefore = await sessionCount(account.authUserId);

    const browser = new CookieJar();
    const signIn = await call(browser, "/sign-in/email", account.credentials);
    expect(signIn.status).toBe(200);
    expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
    expect(browser.has("session_token")).toBe(false);
    expect(await sessionCount(account.authUserId)).toBe(sessionsBefore);
    expect(
      (await call(browser, "/get-session", undefined, "GET").then((r) => r.json())) ?? null
    ).toBeNull();

    const verified = await call(browser, "/two-factor/verify-totp", {
      code: totpCode(account.totpUri)
    });
    expect(verified.status).toBe(200);
    expect(browser.has("session_token")).toBe(true);
    const session = await readJson(
      await call(browser, "/get-session", undefined, "GET"),
      sessionUserSchema
    );
    expect(session.user.id).toBe(account.authUserId);
  });

  it("turns the factor on only with a valid first code, and replaces the session", async () => {
    const account = await passwordAccount();
    const browser = await signedIn(account.credentials);
    const before = browser.header();

    const enable = await call(browser, "/two-factor/enable", {
      password: account.credentials.password
    });
    expect(enable.status).toBe(200);
    const { totpURI, backupCodes } = await readJson(enable, twoFactorSetupSchema);
    expect(totpURI).toMatch(/^otpauth:\/\/totp\/Catalyst%20Test:/u);
    expect(backupCodes).toHaveLength(10);
    expect(await factorRow(account.authUserId)).toMatchObject({ verified: false });
    expect(await enabledFlag(account.authUserId)).toBe(false);

    const refused = await call(browser, "/two-factor/verify-totp", { code: wrongCode(totpURI) });
    expect(refused.status).toBe(401);
    expect(await enabledFlag(account.authUserId)).toBe(false);

    const verified = await call(browser, "/two-factor/verify-totp", { code: totpCode(totpURI) });
    expect(verified.status).toBe(200);
    expect(await enabledFlag(account.authUserId)).toBe(true);
    expect(await factorRow(account.authUserId)).toMatchObject({ verified: true });
    expect(browser.header()).not.toBe(before);
    expect(events).toEqual([{ type: "enabled", authUserId: account.authUserId }]);

    // The secret and the codes are stored encrypted, never as they were shown.
    const stored = await factorRow(account.authUserId);
    const secret = new URL(totpURI).searchParams.get("secret") ?? "";
    expect(JSON.stringify(stored)).not.toContain(secret);
    for (const code of backupCodes) expect(JSON.stringify(stored)).not.toContain(code);
  });

  it("refuses /two-factor/enable on an account with a factor and keeps its secret", async () => {
    const account = await enrolledAccount();
    const stored = await factorRow(account.authUserId);

    const refused = await call(account.browser, "/two-factor/enable", {
      password: account.credentials.password
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "TWO_FACTOR_ALREADY_ENABLED" });
    expect(await factorRow(account.authUserId)).toEqual(stored);
  });

  it("refuses the e-mail and SMS code routes and reading the secret again", async () => {
    const account = await enrolledAccount();
    for (const path of [
      "/two-factor/send-otp",
      "/two-factor/verify-otp",
      "/two-factor/get-totp-uri"
    ]) {
      const response = await call(account.browser, path, {
        password: account.credentials.password,
        code: "123456"
      });
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain("otpauth");
    }
  });

  it("signs in once with a backup code and refuses it the second time", async () => {
    const account = await enrolledAccount();
    const [code] = account.backupCodes;
    if (!code) throw new Error("No backup code");

    const first = new CookieJar();
    await call(first, "/sign-in/email", account.credentials);
    const used = await call(first, "/two-factor/verify-backup-code", { code });
    expect(used.status).toBe(200);
    expect(first.has("session_token")).toBe(true);
    expect(events).toEqual([
      { type: "backup_code_used", authUserId: account.authUserId, backupCodesLeft: 9 }
    ]);

    const second = new CookieJar();
    await call(second, "/sign-in/email", account.credentials);
    const again = await call(second, "/two-factor/verify-backup-code", { code });
    expect(again.status).toBe(401);
    expect(second.has("session_token")).toBe(false);
  });

  it("takes a backup code at the sign-in step only, not with a session", async () => {
    const account = await enrolledAccount();
    const refused = await call(account.browser, "/two-factor/verify-backup-code", {
      code: account.backupCodes[0] ?? ""
    });
    expect(refused.status).toBe(400);
    const browser = new CookieJar();
    await call(browser, "/sign-in/email", account.credentials);
    const used = await call(browser, "/two-factor/verify-backup-code", {
      code: account.backupCodes[0] ?? ""
    });
    expect(used.status).toBe(200);
  });

  it("locks the account for 15 minutes after ten wrong codes, across challenges, and says so once", async () => {
    const account = await enrolledAccount();
    let browser = new CookieJar();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      // The library allows five tries per challenge, so a new sign-in starts the next five.
      if (attempt % 5 === 0) {
        browser = new CookieJar();
        await call(browser, "/sign-in/email", account.credentials);
      }
      const response = await call(browser, "/two-factor/verify-totp", {
        code: wrongCode(account.totpUri)
      });
      expect(response.status).toBe(401);
    }
    expect(events).toEqual([{ type: "locked", authUserId: account.authUserId }]);
    const row = await factorRow(account.authUserId);
    const lockedFor = new Date(String(row?.locked_until)).getTime() - Date.now();
    expect(lockedFor).toBeGreaterThan(14 * 60_000);
    expect(lockedFor).toBeLessThanOrEqual(15 * 60_000);

    browser = new CookieJar();
    await call(browser, "/sign-in/email", account.credentials);
    const locked = await call(browser, "/two-factor/verify-totp", {
      code: totpCode(account.totpUri)
    });
    expect(locked.status).toBe(429);
    expect(browser.has("session_token")).toBe(false);
    expect(events).toHaveLength(1);
  });

  it("trusts a browser for 30 days from the code, and a sign-in there does not extend it", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const account = await enrolledAccount();
    const browser = new CookieJar();
    await call(browser, "/sign-in/email", account.credentials);
    await call(browser, "/two-factor/verify-totp", {
      code: totpCode(account.totpUri),
      trustDevice: true
    });
    expect(browser.has("trust_device")).toBe(true);
    const [trusted] = await trustRows(account.authUserId);
    const codeEnteredAt = Date.now();
    expect(trusted?.expiresAt.getTime()).toBe(codeEnteredAt + 30 * DAY_MS);

    // Day 29: the password alone signs in, and the renewed row keeps the first expiry.
    vi.setSystemTime(codeEnteredAt + 29 * DAY_MS);
    browser.drop("session_token");
    const day29 = await call(browser, "/sign-in/email", account.credentials);
    expect(await day29.json()).not.toHaveProperty("twoFactorRedirect");
    expect(browser.has("session_token")).toBe(true);
    const renewed = await trustRows(account.authUserId);
    expect(renewed).toHaveLength(1);
    expect(renewed[0]?.identifier).not.toBe(trusted?.identifier);
    expect(renewed[0]?.expiresAt.getTime()).toBe(codeEnteredAt + 30 * DAY_MS);

    // Day 30 and a minute: the code is asked again, though the last sign-in was a day ago.
    vi.setSystemTime(codeEnteredAt + 30 * DAY_MS + 60_000);
    browser.drop("session_token");
    const day30 = await call(browser, "/sign-in/email", account.credentials);
    expect(await day30.json()).toMatchObject({ twoFactorRedirect: true });
    expect(browser.has("session_token")).toBe(false);
  });

  it("asks a trusted browser for the code again after the factor is turned off and on", async () => {
    const account = await enrolledAccount();
    const trustedBrowser = new CookieJar();
    await call(trustedBrowser, "/sign-in/email", account.credentials);
    await call(trustedBrowser, "/two-factor/verify-totp", {
      code: totpCode(account.totpUri),
      trustDevice: true
    });
    const otherBrowser = new CookieJar();
    await call(otherBrowser, "/sign-in/email", account.credentials);
    await call(otherBrowser, "/two-factor/verify-totp", {
      code: totpCode(account.totpUri),
      trustDevice: true
    });
    expect(await trustRows(account.authUserId)).toHaveLength(2);

    const disabled = await call(account.browser, "/two-factor/disable", {
      password: account.credentials.password
    });
    expect(disabled.status).toBe(200);
    expect(await trustRows(account.authUserId)).toHaveLength(0);
    expect(await factorRow(account.authUserId)).toBeUndefined();
    expect(await enabledFlag(account.authUserId)).toBe(false);
    expect(events.map((event) => event.type)).toEqual(["disabled"]);

    const again = await enroll(account.browser, account.credentials.password);
    expect(again.status).toBe(200);
    for (const browser of [trustedBrowser, otherBrowser]) {
      browser.drop("session_token");
      const signIn = await call(browser, "/sign-in/email", account.credentials);
      expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
    }
  });

  it("forgets every trusted browser of the person on request", async () => {
    const account = await enrolledAccount();
    const browser = new CookieJar();
    await call(browser, "/sign-in/email", account.credentials);
    await call(browser, "/two-factor/verify-totp", {
      code: totpCode(account.totpUri),
      trustDevice: true
    });
    expect(await trustRows(account.authUserId)).toHaveLength(1);

    const forgotten = await call(account.browser, "/two-factor/forget-trusted-browsers", {});
    expect(forgotten.status).toBe(200);
    expect(await trustRows(account.authUserId)).toHaveLength(0);
    browser.drop("session_token");
    const signIn = await call(browser, "/sign-in/email", account.credentials);
    expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
  });

  it("replaces the backup codes with the password and audits it", async () => {
    const account = await enrolledAccount();
    const refused = await call(account.browser, "/two-factor/generate-backup-codes", {
      password: "not-the-password"
    });
    expect(refused.status).toBe(400);
    const generated = await call(account.browser, "/two-factor/generate-backup-codes", {
      password: account.credentials.password
    });
    expect(generated.status).toBe(200);
    const { backupCodes } = await readJson(generated, backupCodesSchema);
    expect(backupCodes).toHaveLength(10);
    expect(events).toEqual([{ type: "backup_codes_regenerated", authUserId: account.authUserId }]);

    const browser = new CookieJar();
    await call(browser, "/sign-in/email", account.credentials);
    const old = await call(browser, "/two-factor/verify-backup-code", {
      code: account.backupCodes[0] ?? ""
    });
    expect(old.status).toBe(401);
  });

  it("resets a factor for an admin: no factor, no trusted browser, no session", async () => {
    const account = await enrolledAccount();
    const browser = new CookieJar();
    await call(browser, "/sign-in/email", account.credentials);
    await call(browser, "/two-factor/verify-totp", {
      code: totpCode(account.totpUri),
      trustDevice: true
    });

    expect(await auth.resetTwoFactor({ externalUserId: account.authUserId })).toEqual({
      hadFactor: true
    });
    expect(await factorRow(account.authUserId)).toBeUndefined();
    expect(await enabledFlag(account.authUserId)).toBe(false);
    expect(await trustRows(account.authUserId)).toHaveLength(0);
    expect(await sessionCount(account.authUserId)).toBe(0);
    expect(await auth.resetTwoFactor({ externalUserId: account.authUserId })).toEqual({
      hadFactor: false
    });
  });

  it("deletes the factor and the trusted browsers with the password sign-in", async () => {
    const account = await enrolledAccount();
    const browser = new CookieJar();
    await call(browser, "/sign-in/email", account.credentials);
    await call(browser, "/two-factor/verify-totp", {
      code: totpCode(account.totpUri),
      trustDevice: true
    });
    expect(await trustRows(account.authUserId)).toHaveLength(1);

    await auth.deletePasswordSignIn({ externalUserId: account.authUserId });
    expect(await factorRow(account.authUserId)).toBeUndefined();
    expect(await trustRows(account.authUserId)).toHaveLength(0);
    expect(await sql`select id from "user" where id = ${account.authUserId}`).toHaveLength(0);
  });

  it("lists which sign-ins have a factor", async () => {
    const enrolled = await enrolledAccount();
    const plain = await passwordAccount();
    expect(await auth.twoFactorEnrolled([enrolled.authUserId, plain.authUserId])).toEqual(
      new Set([enrolled.authUserId])
    );
    expect(await auth.twoFactorEnrolled([])).toEqual(new Set());
  });

  it("counts every /two-factor/ path as a credential route", () => {
    for (const path of [
      "/two-factor/verify-totp",
      "/two-factor/verify-backup-code",
      "/two-factor/enable",
      "/two-factor/forget-trusted-browsers"
    ]) {
      expect(auth.routeKind(authUrl(baseUrl, path).pathname)).toBe("credential");
    }
  });

  // Helpers.

  async function passwordAccount() {
    accountCount += 1;
    const credentials = {
      email: `two-factor-${accountCount}@example.test`,
      password: `two-factor-password-${accountCount}`
    };
    const signIn = await auth.setOrCreatePasswordSignIn({
      ...credentials,
      displayLabel: `Person ${accountCount}`,
      roles: ["user"],
      permissionRefs: [],
      permissions: []
    });
    return { credentials, authUserId: signIn.externalUserId };
  }

  async function enrolledAccount() {
    const account = await passwordAccount();
    const browser = await signedIn(account.credentials);
    const enable = await enroll(browser, account.credentials.password);
    events.length = 0;
    return { ...account, browser, ...enable.setup };
  }

  async function enroll(browser: CookieJar, password: string) {
    const enable = await call(browser, "/two-factor/enable", { password });
    const setup = await readJson(enable, twoFactorSetupSchema);
    const verify = await call(browser, "/two-factor/verify-totp", {
      code: totpCode(setup.totpURI)
    });
    return {
      status: verify.status,
      setup: { totpUri: setup.totpURI, backupCodes: setup.backupCodes }
    };
  }

  async function signedIn(credentials: { email: string; password: string }) {
    const browser = new CookieJar();
    const response = await call(browser, "/sign-in/email", credentials);
    expect(response.status).toBe(200);
    expect(browser.has("session_token")).toBe(true);
    return browser;
  }

  async function call(
    browser: CookieJar,
    path: string,
    body?: Record<string, unknown>,
    method = "POST"
  ): Promise<Response> {
    const response = await auth.handleRequest(
      new Request(authUrl(baseUrl, path), {
        method,
        headers: {
          "content-type": "application/json",
          origin: baseUrl,
          cookie: browser.header()
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) })
      }),
      {
        twoFactor: async (event) => {
          events.push(event);
        }
      }
    );
    browser.store(response);
    return response;
  }

  async function factorRow(authUserId: string) {
    const [row] = await sql<Record<string, unknown>[]>`
      select * from two_factor where user_id = ${authUserId}`;
    return row;
  }

  async function enabledFlag(authUserId: string) {
    const [row] = await sql<{ enabled: boolean }[]>`
      select two_factor_enabled as enabled from "user" where id = ${authUserId}`;
    return row?.enabled;
  }

  async function trustRows(authUserId: string) {
    return sql<{ identifier: string; expiresAt: Date }[]>`
      select identifier, "expiresAt" from verification
      where value = ${authUserId} and identifier like 'trust-device-%'`;
  }

  async function sessionCount(authUserId: string) {
    const rows = await sql`select id from session where "userId" = ${authUserId}`;
    return rows.length;
  }
});
