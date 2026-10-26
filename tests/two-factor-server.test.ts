import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "@work-shape/catalyst-client-assembly";
import { apiOperations, TWO_FACTOR_SETUP_REQUIRED_REASON } from "@work-shape/catalyst-api-contract";
import {
  createStandaloneAuthRuntime,
  IdentityResolvingAuthAdapter,
  type StandaloneAuthRuntime
} from "@work-shape/catalyst-auth";
import {
  StoreBackedAuditRecorder,
  asApiCredentialId,
  asClientInstanceId,
  asServicePrincipalId,
  type AuditEvent,
  type AuthenticatedIdentity,
  type AuthenticatedServicePrincipal,
  type AuthenticatedUser,
  type Logger,
  type UserRole
} from "@work-shape/catalyst-core";
import type { ClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { createTestConfig } from "./support/fixtures";
import { fileTestDatabaseUrl } from "./support/test-database";
import {
  createTestInstanceWith,
  listenTestInstance,
  listTestRoutes,
  type TestInstance,
  type TestStore
} from "./support/test-instance";
import {
  CookieJar,
  authUrl,
  backupCodesSchema,
  readJson,
  recordIdSchema,
  refusalReasonSchema,
  totpCode,
  twoFactorSetupSchema,
  wrongCode
} from "./support/two-factor-client";
import { z } from "zod";

// Check 51 (TWO-FACTOR-1) through the server: the gate on every operation, the admin reset,
// the audit and the rate limit, with the real sign-in library and the real HTTP routes.

const authOrigin = "http://localhost:3000";
const baseConfig = createTestConfig();
const clientInstanceId = asClientInstanceId(baseConfig.clientInstance.id);

type Operation = (typeof apiOperations)[keyof typeof apiOperations];

interface Stack {
  instance: TestInstance<TestStore>;
  url: string;
  config: ClientInstanceConfig;
  auth: StandaloneAuthRuntime;
  /** What a key sent as `Bearer <name>` authenticates as: a personal key or a service's. */
  keys: Map<string, AuthenticatedIdentity>;
  logged: string[];
  audit(): Promise<AuditEvent[]>;
  close(): Promise<void>;
}

async function createStack(input: {
  required: boolean;
  signInPerAddressPerMinute?: number;
}): Promise<Stack> {
  const auth = await createStandaloneAuthRuntime({
    clientInstanceId,
    databaseUrl: await fileTestDatabaseUrl(),
    secret: "test-secret-at-least-32-characters-long",
    baseUrl: authUrl(authOrigin, "").href,
    twoFactorIssuer: "Catalyst Test"
  });
  // The product's own logger, as a deployment writes it, read back from standard output.
  const logged: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    logged.push(String(chunk));
    return true;
  });
  const logger: Logger = createLogger();
  const config: ClientInstanceConfig = {
    ...baseConfig,
    auth: {
      ...baseConfig.auth,
      standalone: {
        enabled: true,
        trustedOrigins: [],
        seedUsers: [],
        twoFactor: { required: input.required }
      }
    },
    rateLimits: {
      ...baseConfig.rateLimits,
      signInPerAccountPerMinute: 1000,
      signInPerAddressPerMinute: input.signInPerAddressPerMinute ?? 1000
    }
  };
  let auditStore: TestStore["audit"] | undefined;
  const keys = new Map<string, AuthenticatedIdentity>();
  const instance = await createTestInstanceWith((stores) => {
    auditStore = stores.audit;
    const cookies = new IdentityResolvingAuthAdapter(auth.authAdapter, stores.users);
    return {
      config,
      clientInstanceId,
      logger,
      allowedOrigins: [authOrigin],
      standaloneAuth: auth,
      // A key stands in for the key adapters, which hand the server the same identity.
      authAdapter: {
        id: "two-factor-test",
        credentialMode: "explicit",
        authenticate(request) {
          const header = request.headers.authorization;
          const key =
            typeof header === "string" ? keys.get(header.slice("Bearer ".length)) : undefined;
          return key ? Promise.resolve(key) : cookies.authenticate(request);
        }
      },
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit })
    };
  });
  await instance.call("health.get");
  const url = await listenTestInstance(instance);
  return {
    instance,
    url,
    config,
    auth,
    keys,
    logged,
    audit: async () =>
      auditStore ? auditStore.listAuditEvents({ clientInstanceId, limit: 1000 }) : [],
    async close() {
      stdout.mockRestore();
      await instance.close();
      await auth.close();
    }
  };
}

let accountCount = 0;

describe("two-factor sign-in through the server (TWO-FACTOR-1)", () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await createStack({ required: true });
  });

  afterAll(async () => {
    await stack?.close();
  });

  it("refuses every operation but me.get to a session without a factor, then opens the same session", async () => {
    const person = await account(stack, { roles: ["user", "admin", "superadmin"] });
    const browser = await signIn(stack, person);

    const me = await api(stack, browser, apiOperations["me.get"]);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ twoFactor: { required: true, enrolled: false } });

    // Every operation this instance serves; one of a module it leaves out has no route at all.
    const served = new Set(
      (await listTestRoutes(stack.instance)).map((route) => `${route.method} ${route.path}`)
    );
    const signedInOperations = (Object.values(apiOperations) as Operation[]).filter(
      (operation) =>
        (operation.auth as string) !== "public" &&
        operation.id !== "me.get" &&
        served.has(`${operation.method} ${operation.path}`)
    );
    expect(signedInOperations.length).toBeGreaterThan(200);
    const answered: string[] = [];
    for (const operation of signedInOperations) {
      const response = await api(stack, browser, operation);
      const body = refusalReasonSchema.safeParse(await response.json().catch(() => undefined));
      const refused =
        response.status === 403 &&
        body.data?.error?.details?.reason === TWO_FACTOR_SETUP_REQUIRED_REASON;
      // A server-credential operation never takes the cookie and answers on its own.
      if (!refused && (operation.auth as string) !== "serverCredential") {
        answered.push(`${operation.id}: ${response.status}`);
      }
    }
    expect(answered).toEqual([]);

    // The library's own routes stay open: the person sets the factor up in the same session.
    await enroll(stack, browser, person.password);
    const after = await api(stack, browser, apiOperations["me.get"]);
    expect(await after.json()).toMatchObject({ twoFactor: { required: true, enrolled: true } });
    expect((await api(stack, browser, apiOperations["users.list"])).status).toBe(200);
  });

  it("gives no session for the password alone on an enrolled account", async () => {
    const person = await enrolledAccount(stack);
    const browser = new CookieJar();
    const response = await authCall(stack, browser, "/sign-in/email", person.credentials);
    expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
    expect((await api(stack, browser, apiOperations["me.get"])).status).toBe(401);
    await authCall(stack, browser, "/two-factor/verify-totp", { code: totpCode(person.totpUri) });
    expect((await api(stack, browser, apiOperations["me.get"])).status).toBe(200);
  });

  it("lets an admin reset a person's factor: sessions end, the next sign-in reaches the setup", async () => {
    const admin = await enrolledAccount(stack, { roles: ["user", "admin"] });
    const person = await enrolledAccount(stack);
    const personId = await userIdOf(stack, person.browser);

    const listed = await api(stack, admin.browser, apiOperations["users.list"]);
    const { items: rows } = await readJson(
      listed,
      z.object({
        items: z.array(z.object({ id: z.string(), twoFactorEnabled: z.boolean().optional() }))
      })
    );
    expect(rows.find((row) => row.id === personId)?.twoFactorEnabled).toBe(true);

    const reset = await api(stack, admin.browser, apiOperations["users.two_factor.reset"], {
      params: { userId: personId }
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ ok: true, hadFactor: true });

    // The old session is gone.
    expect((await api(stack, person.browser, apiOperations["me.get"])).status).toBe(401);
    // The password alone signs in again, straight to the setup.
    const again = await signIn(stack, person);
    const me = await api(stack, again, apiOperations["me.get"]);
    expect(await me.json()).toMatchObject({ twoFactor: { required: true, enrolled: false } });
    const blocked = await api(stack, again, apiOperations["conversations.list"]);
    expect(blocked.status).toBe(403);
    expect((await readJson(blocked, refusalReasonSchema)).error?.details?.reason).toBe(
      TWO_FACTOR_SETUP_REQUIRED_REASON
    );

    const events = (await stack.audit()).filter(
      (event) => event.type === "user.two_factor_reset" && event.subject === personId
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "success",
      actor: { userId: await userIdOf(stack, admin.browser) },
      metadata: { authSource: "better-auth", hadFactor: true }
    });
  });

  it("refuses an admin's reset of their own factor", async () => {
    const admin = await enrolledAccount(stack, { roles: ["user", "admin"] });
    const adminId = await userIdOf(stack, admin.browser);
    const reset = await api(stack, admin.browser, apiOperations["users.two_factor.reset"], {
      params: { userId: adminId }
    });
    expect(reset.status).toBe(403);
    expect(await reset.json()).toMatchObject({
      error: { details: { reason: "holder_not_administrable" } }
    });
    // The factor is still there.
    expect((await stack.auth.twoFactorEnrolled([admin.authUserId])).has(admin.authUserId)).toBe(
      true
    );
  });

  it("refuses a users.manage holder without admin the reset of an admin", async () => {
    const manager = await enrolledAccount(stack, {
      roles: ["user"],
      permissions: ["users.manage"]
    });
    const admin = await enrolledAccount(stack, { roles: ["user", "admin"] });
    const person = await enrolledAccount(stack);
    const adminId = await userIdOf(stack, admin.browser);
    const personId = await userIdOf(stack, person.browser);

    const refused = await api(stack, manager.browser, apiOperations["users.two_factor.reset"], {
      params: { userId: adminId }
    });
    expect(refused.status).toBe(403);
    expect((await stack.auth.twoFactorEnrolled([admin.authUserId])).has(admin.authUserId)).toBe(
      true
    );
    const allowed = await api(stack, manager.browser, apiOperations["users.two_factor.reset"], {
      params: { userId: personId }
    });
    expect(allowed.status).toBe(200);
  });

  it("audits the person's own changes and keeps every secret and code out of answers, audit and log", async () => {
    const person = await account(stack);
    const browser = await signIn(stack, person);
    // The person's record exists before the changes, as for anyone an admin created.
    const personId = await userIdOf(stack, browser);
    const enable = await authCall(stack, browser, "/two-factor/enable", {
      password: person.password
    });
    const setup = await readJson(enable, twoFactorSetupSchema);
    await authCall(stack, browser, "/two-factor/verify-totp", { code: totpCode(setup.totpURI) });
    const regenerated = await readJson(
      await authCall(stack, browser, "/two-factor/generate-backup-codes", {
        password: person.password
      }),
      backupCodesSchema
    );

    // A backup code at the second sign-in step.
    const second = new CookieJar();
    await authCall(stack, second, "/sign-in/email", person.credentials);
    const used = await authCall(stack, second, "/two-factor/verify-backup-code", {
      code: regenerated.backupCodes[0]
    });
    expect(used.status).toBe(200);

    // Ten wrong codes lock the account.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const jar = new CookieJar();
      await authCall(stack, jar, "/sign-in/email", person.credentials);
      await authCall(stack, jar, "/two-factor/verify-totp", { code: wrongCode(setup.totpURI) });
    }

    const disabled = await authCall(stack, browser, "/two-factor/disable", {
      password: person.password
    });
    expect(disabled.status).toBe(200);

    const events = (await stack.audit()).filter(
      (event) => event.subject === personId && event.type.startsWith("user.two_factor_")
    );
    expect(events.map((event) => `${event.type}:${event.status}`).sort()).toEqual(
      [
        "user.two_factor_backup_code_used:success",
        "user.two_factor_backup_codes_regenerated:success",
        "user.two_factor_disabled:success",
        "user.two_factor_enabled:success",
        "user.two_factor_locked:denied"
      ].sort()
    );
    expect(events.find((event) => event.type === "user.two_factor_backup_code_used")).toMatchObject(
      { actor: { userId: personId }, metadata: { backupCodesLeft: 9 } }
    );

    const secret = new URL(setup.totpURI).searchParams.get("secret") ?? "";
    expect(secret).not.toBe("");
    const traces = [
      secret,
      setup.totpURI,
      "otpauth://",
      ...setup.backupCodes,
      ...regenerated.backupCodes
    ];
    const auditText = JSON.stringify(await stack.audit());
    const logText = stack.logged.join("\n");
    expect(logText).toContain("/two-factor/verify-totp");
    for (const trace of traces) {
      expect(auditText).not.toContain(trace);
      expect(logText).not.toContain(trace);
    }

    // The person's own record and the admin list name whether there is a factor, never the factor.
    const admin = await enrolledAccount(stack, { roles: ["user", "admin"] });
    const answers = [
      await (await api(stack, browser, apiOperations["me.get"])).text(),
      await (await api(stack, admin.browser, apiOperations["users.list"])).text()
    ].join("\n");
    for (const trace of traces) {
      expect(answers).not.toContain(trace);
    }
  });

  it("refuses a personal key of an owner without a factor, never a service principal's", async () => {
    const person = await account(stack);
    const browser = await signIn(stack, person);
    const personId = await userIdOf(stack, browser);
    const keyOwner: AuthenticatedUser = {
      id: personId,
      externalUserId: personId,
      displayLabel: "Key owner",
      roles: ["user", "admin"],
      permissionRefs: [],
      permissions: [],
      clientInstanceId,
      authSource: "api-key",
      delegatedActor: {
        kind: "api_key",
        id: asApiCredentialId("key_1"),
        displayLabel: "Key",
        authSource: "api-key"
      },
      scopes: ["*"]
    };
    stack.keys.set("personal-key", keyOwner);
    const byKey = (key: string) =>
      fetch(`${stack.url}${apiOperations["users.list"].path}`, {
        headers: { authorization: `Bearer ${key}` }
      });

    const refused = await byKey("personal-key");
    expect(refused.status).toBe(403);
    expect((await readJson(refused, refusalReasonSchema)).error?.details?.reason).toBe(
      TWO_FACTOR_SETUP_REQUIRED_REASON
    );
    await enroll(stack, browser, person.password);
    expect((await byKey("personal-key")).status).toBe(200);

    const service: AuthenticatedServicePrincipal = {
      kind: "service",
      id: asServicePrincipalId("sp_1"),
      credentialId: asApiCredentialId("cred_1"),
      displayLabel: "Service",
      permissionRefs: [],
      permissions: ["users.manage"],
      clientInstanceId,
      authSource: "api-key",
      scopes: ["*"]
    };
    stack.keys.set("service-key", service);
    const serviceAnswer = await byKey("service-key");
    expect((await readJson(serviceAnswer, refusalReasonSchema)).error?.details?.reason).not.toBe(
      TWO_FACTOR_SETUP_REQUIRED_REASON
    );

    // An owner who signs in only through a company identity provider has no factor here to need.
    const companyUser = await stack.instance.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Company",
      roles: ["user", "admin"]
    });
    stack.keys.set("company-key", { ...keyOwner, id: companyUser.id });
    expect((await byKey("company-key")).status).toBe(200);
  });
});

describe("two-factor sign-in without the setting (TWO-FACTOR-1)", () => {
  it("opens everything without a factor, and the person turns it on and off", async () => {
    const stack = await createStack({ required: false });
    try {
      const person = await account(stack, { roles: ["user", "admin"] });
      const browser = await signIn(stack, person);
      const me = await api(stack, browser, apiOperations["me.get"]);
      expect(await me.json()).toMatchObject({ twoFactor: { required: false, enrolled: false } });
      expect((await api(stack, browser, apiOperations["users.list"])).status).toBe(200);
      await enroll(stack, browser, person.password);
      expect(await (await api(stack, browser, apiOperations["me.get"])).json()).toMatchObject({
        twoFactor: { required: false, enrolled: true }
      });
      const off = await authCall(stack, browser, "/two-factor/disable", {
        password: person.password
      });
      expect(off.status).toBe(200);
      expect((await api(stack, browser, apiOperations["users.list"])).status).toBe(200);
    } finally {
      await stack.close();
    }
  });
});

describe("rate limit of two-factor codes (TWO-FACTOR-1)", () => {
  it("counts every /two-factor/ call against the sign-in limit of the address", async () => {
    const stack = await createStack({ required: true, signInPerAddressPerMinute: 4 });
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await authCall(stack, new CookieJar(), "/two-factor/verify-totp", {
          code: "000000"
        });
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 4)).not.toContain(429);
      expect(statuses.slice(4)).toEqual([429, 429]);
    } finally {
      await stack.close();
    }
  });
});

// Helpers.

async function account(
  stack: Stack,
  input: { roles?: UserRole[]; permissions?: string[] } = {}
): Promise<{
  email: string;
  password: string;
  credentials: { email: string; password: string };
  authUserId: string;
}> {
  accountCount += 1;
  const email = `server-two-factor-${accountCount}@example.test`;
  const password = `server-two-factor-password-${accountCount}`;
  const signIn = await stack.auth.setOrCreatePasswordSignIn({
    email,
    password,
    displayLabel: `Server person ${accountCount}`,
    roles: input.roles ?? ["user"],
    permissionRefs: [],
    permissions: input.permissions ?? []
  });
  return { email, password, credentials: { email, password }, authUserId: signIn.externalUserId };
}

async function enrolledAccount(
  stack: Stack,
  input: { roles?: UserRole[]; permissions?: string[] } = {}
) {
  const person = await account(stack, input);
  const browser = await signIn(stack, person);
  const setup = await enroll(stack, browser, person.password);
  return { ...person, browser, totpUri: setup.totpURI };
}

async function signIn(
  stack: Stack,
  person: { credentials: { email: string; password: string } }
): Promise<CookieJar> {
  const browser = new CookieJar();
  const response = await authCall(stack, browser, "/sign-in/email", person.credentials);
  expect(response.status).toBe(200);
  expect(browser.has("session_token")).toBe(true);
  return browser;
}

async function enroll(stack: Stack, browser: CookieJar, password: string) {
  const enable = await authCall(stack, browser, "/two-factor/enable", { password });
  expect(enable.status).toBe(200);
  const setup = await readJson(enable, twoFactorSetupSchema);
  const verified = await authCall(stack, browser, "/two-factor/verify-totp", {
    code: totpCode(setup.totpURI)
  });
  expect(verified.status).toBe(200);
  return setup;
}

async function userIdOf(stack: Stack, browser: CookieJar): Promise<string> {
  const me = await api(stack, browser, apiOperations["me.get"]);
  return (await readJson(me, recordIdSchema)).id;
}

async function authCall(
  stack: Stack,
  browser: CookieJar,
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  const response = await fetch(authUrl(stack.url, path), {
    method: "POST",
    headers: { "content-type": "application/json", origin: authOrigin, cookie: browser.header() },
    body: JSON.stringify(body)
  });
  browser.store(response);
  return response;
}

async function api(
  stack: Stack,
  browser: CookieJar,
  operation: Operation,
  input: { params?: Record<string, string>; body?: unknown } = {}
): Promise<Response> {
  const path = operation.path.replaceAll(
    /:([A-Za-z]+)/gu,
    (_, name: string) => input.params?.[name] ?? "any"
  );
  const method = operation.method;
  const response = await fetch(`${stack.url}${path}`, {
    method,
    headers: {
      origin: authOrigin,
      cookie: browser.header(),
      ...(method === "GET" || method === "DELETE" ? {} : { "content-type": "application/json" })
    },
    ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(input.body ?? {}) })
  });
  browser.store(response);
  return response;
}
