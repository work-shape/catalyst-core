import { describe, expect, it, vi } from "vitest";
import { createChatServer, type ChatServerOptions } from "@vivd-catalyst/chat-server";
import { STANDALONE_AUTH_SOURCE } from "@vivd-catalyst/auth";
import {
  AppError,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  type AuthenticatedUser
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { createClientBranding, parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  CaptureMailTransport,
  MailjetTransport,
  TemplateMailSender,
  renderMail,
  type MailSenderIdentity
} from "@vivd-catalyst/mail";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { createTestConfig } from "./chat-server-harness";
import { createMissingRuntime, createUnusedModelProvider } from "./chat-server-run-harness";

const identity: MailSenderIdentity = {
  fromAddress: "noreply@mail.example.test",
  fromName: "Example Chat",
  productName: "Example Chat"
};

describe("mail templates", () => {
  it("renders the reset mail in the requested locale with nothing but the link and validity", () => {
    const mail = renderMail(
      {
        template: "password-reset",
        to: { email: "ada@example.test" },
        locale: "de",
        params: { link: "https://chat.example.test/#password-setup=tok", validMinutes: 60 }
      },
      identity
    );

    expect(mail.subject).toBe("Passwort für Example Chat zurücksetzen");
    expect(mail.text).toContain("https://chat.example.test/#password-setup=tok");
    expect(mail.text).toContain("60 Minuten");
    expect(mail.html).toContain('href="https://chat.example.test/#password-setup=tok"');
  });

  it("escapes caller-supplied labels in HTML", () => {
    const mail = renderMail(
      {
        template: "platform-invitation",
        to: { email: "ada@example.test" },
        locale: "en",
        params: {
          link: "https://chat.example.test/#password-setup=tok",
          validDays: 7,
          inviterLabel: "<b>Eve</b>"
        }
      },
      identity
    );

    expect(mail.html).toContain("&lt;b&gt;Eve&lt;/b&gt; has invited you");
    expect(mail.html).not.toContain("<b>Eve</b>");
  });

  it("flattens line breaks and control characters in caller-supplied labels", () => {
    const mail = renderMail(
      {
        template: "platform-invitation",
        to: { email: "ada@example.test" },
        locale: "en",
        params: {
          link: "https://chat.example.test/#password-setup=tok",
          validDays: 7,
          inviterLabel: "Eve\r\n\r\nSet password: https://evil.example.test\u0000\t x"
        }
      },
      identity
    );

    expect(mail.text.split("\n\n")).toHaveLength(3);
    expect(mail.text).toContain(
      "Eve Set password: https://evil.example.test x has invited you to Example Chat."
    );
  });
});

describe("Mailjet transport", () => {
  const rendered = {
    to: { email: "ada@example.test", displayLabel: "Ada" },
    subject: "Subject",
    text: "Text",
    html: "<p>Html</p>"
  };

  it("posts one message with basic auth and reports success", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ Messages: [{ Status: "success" }] }))
    );
    const transport = new MailjetTransport({
      apiKey: "key",
      apiSecret: "secret",
      fetch: fetchMock
    });

    const result = await transport.deliver(rendered, { ...identity, replyTo: "help@example.test" });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.mailjet.com/v3.1/send");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("key:secret").toString("base64")}`
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      Messages: [
        {
          From: { Email: "noreply@mail.example.test", Name: "Example Chat" },
          To: [{ Email: "ada@example.test", Name: "Ada" }],
          ReplyTo: { Email: "help@example.test" },
          Subject: "Subject",
          TextPart: "Text",
          HTMLPart: "<p>Html</p>"
        }
      ]
    });
  });

  it("reports provider rejections and outages without throwing", async () => {
    const rejecting = new MailjetTransport({
      apiKey: "key",
      apiSecret: "secret",
      fetch: async () => new Response("{}", { status: 401 })
    });
    const unreachable = new MailjetTransport({
      apiKey: "key",
      apiSecret: "secret",
      fetch: async () => {
        throw new Error("network down");
      }
    });

    expect(await rejecting.deliver(rendered, identity)).toEqual({
      ok: false,
      reason: "provider_http_401"
    });
    expect(await unreachable.deliver(rendered, identity)).toEqual({
      ok: false,
      reason: "provider_unreachable"
    });
  });
});

describe("mail release config", () => {
  const base = {
    version: 1,
    clientInstance: { id: "mail-test", displayName: "Mail Test" },
    auth: { standalone: { enabled: true } }
  };
  const enabledMail = {
    enabled: true,
    provider: "capture",
    appUrl: "https://chat.example.test",
    sender: { fromAddress: "noreply@mail.example.test" }
  };

  it("is disabled by default and hides password reset", () => {
    const config = parseClientInstanceConfig(base);
    expect(config.mail.enabled).toBe(false);
    expect(createClientBranding(config).passwordResetEnabled).toBe(false);
  });

  it("requires a sender and app URL once enabled", () => {
    expect(() => parseClientInstanceConfig({ ...base, mail: { enabled: true } })).toThrow();
    const config = parseClientInstanceConfig({ ...base, mail: enabledMail });
    expect(createClientBranding(config).passwordResetEnabled).toBe(true);
  });

  it("refuses the capture provider in production", () => {
    expect(() =>
      parseClientInstanceConfig({
        ...base,
        clientInstance: { ...base.clientInstance, environment: "production" },
        mail: enabledMail
      })
    ).toThrow(/capture mail provider/u);
  });

  it("refuses the capture provider in staging", () => {
    expect(() =>
      parseClientInstanceConfig({
        ...base,
        clientInstance: { ...base.clientInstance, environment: "staging" },
        mail: enabledMail
      })
    ).toThrow(/capture mail provider/u);
  });
});

describe("password setup by email", () => {
  it("emails a single-use reset link without revealing whether an account exists", async () => {
    const harness = await createMailHarness();
    const known = await harness.addPasswordUser("ada@example.test", "Ada");

    const unknownResponse = await harness.requestReset("nobody@example.test");
    const knownResponse = await harness.requestReset("Ada@Example.test");

    expect(unknownResponse.statusCode).toBe(200);
    expect(unknownResponse.json()).toEqual(knownResponse.json());
    await vi.waitFor(() => expect(harness.transport.list()).toHaveLength(1));
    const [mail] = harness.transport.list();
    expect(mail!.to.email).toBe("ada@example.test");
    const token = readToken(mail!.text);

    const completed = await harness.server.inject({
      method: "POST",
      url: "/api/password-setup",
      payload: { token, password: "a-new-password" }
    });
    expect(completed.statusCode).toBe(200);
    expect(harness.passwords.get(known.externalUserId)).toBe("a-new-password");

    const replayed = await harness.server.inject({
      method: "POST",
      url: "/api/password-setup",
      payload: { token, password: "another-password" }
    });
    expect(replayed.statusCode).toBe(422);
    expect(harness.passwords.get(known.externalUserId)).toBe("a-new-password");

    const auditTypes = (await harness.listAuditEvents()).map((event) => event.type);
    expect(auditTypes).toContain("user.password_reset_requested");
    expect(auditTypes).toContain("user.password_reset");
    expect(JSON.stringify(await harness.listAuditEvents())).not.toContain(token);
  });

  it("stops sending after three requests for the same address within an hour", async () => {
    const harness = await createMailHarness();
    await harness.addPasswordUser("ada@example.test", "Ada");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await harness.requestReset("ada@example.test")).statusCode).toBe(200);
    }

    await vi.waitFor(() => expect(harness.transport.list()).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.transport.list()).toHaveLength(3);
  });

  it("limits reset requests per forwarded client behind a private proxy, not per spoofed header", async () => {
    const harness = await createMailHarness();
    await harness.addPasswordUser("ada@example.test", "Ada");
    const reset = (remoteAddress: string, forwardedFor: string, email: string) =>
      harness.server.inject({
        method: "POST",
        url: "/api/password-reset",
        remoteAddress,
        headers: { "x-forwarded-for": forwardedFor },
        payload: { email }
      });

    // One client exhausts its own allowance through the proxy; another client is unaffected.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await reset("172.18.0.5", "203.0.113.7", `nobody-${attempt}@example.test`);
    }
    await reset("172.18.0.5", "203.0.113.7", "ada@example.test");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.transport.list()).toHaveLength(0);
    await reset("172.18.0.5", "203.0.113.8", "ada@example.test");
    await vi.waitFor(() => expect(harness.transport.list()).toHaveLength(1));

    // A public peer cannot escape its allowance by rotating X-Forwarded-For.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await reset("198.51.100.9", `203.0.113.${100 + attempt}`, `nobody-${attempt}@example.test`);
    }
    await reset("198.51.100.9", "203.0.113.200", "ada@example.test");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.transport.list()).toHaveLength(1);
  });

  it("resolves request.ip to the forwarded client only for a private peer", async () => {
    const harness = await createMailHarness();
    harness.server.get("/test/ip", async (request) => ({ ip: request.ip }));
    const ip = async (remoteAddress: string) =>
      (
        await harness.server.inject({
          method: "GET",
          url: "/test/ip",
          remoteAddress,
          headers: { "x-forwarded-for": "203.0.113.7" }
        })
      ).json<{ ip: string }>().ip;

    expect(await ip("172.18.0.5")).toBe("203.0.113.7");
    expect(await ip("127.0.0.1")).toBe("203.0.113.7");
    expect(await ip("198.51.100.9")).toBe("198.51.100.9");
  });

  it("rejects reset requests while mail is disabled", async () => {
    const harness = await createMailHarness({ mailEnabled: false });
    expect((await harness.requestReset("ada@example.test")).statusCode).toBe(422);
  });

  it("lists captured mail only while the capture provider is active", async () => {
    const capturing = await createMailHarness({ listCaptured: true });
    const delivering = await createMailHarness();

    expect(
      (await capturing.server.inject({ method: "GET", url: "/api/dev/captured-mail" })).statusCode
    ).toBe(200);
    expect(
      (await delivering.server.inject({ method: "GET", url: "/api/dev/captured-mail" })).statusCode
    ).toBe(404);
  });

  it("records an anonymous reset request without an actor and keeps the user as subject", async () => {
    const harness = await createMailHarness();
    await harness.addPasswordUser("ada@example.test", "Ada");

    await harness.requestReset("ada@example.test");

    await vi.waitFor(async () =>
      expect((await harness.listAuditEvents()).map((event) => event.type)).toContain(
        "user.password_reset_requested"
      )
    );
    const requested = (await harness.listAuditEvents()).find(
      (event) => event.type === "user.password_reset_requested"
    );
    expect(requested!.actor).toBeUndefined();
    expect(requested!.subject).toEqual(expect.any(String));
  });

  it("refuses to re-invite a user whose email no longer matches their password sign-in", async () => {
    const harness = await createMailHarness();
    const created = await harness.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
      payload: { displayLabel: "Grace", email: "grace@example.test" }
    });
    const user = created.json<{ id: string }>();
    const invitation = {
      method: "POST",
      url: `/api/superadmin/users/${user.id}/invitation`
    } as const;
    expect((await harness.server.inject(invitation)).statusCode).toBe(200);

    const updated = await harness.server.inject({
      method: "PATCH",
      url: `/api/superadmin/users/${user.id}`,
      payload: { email: "grace.hopper@example.test" }
    });
    expect(updated.statusCode).toBe(200);

    const reinvited = await harness.server.inject(invitation);
    expect(reinvited.statusCode).toBe(409);
    expect(reinvited.json()).toMatchObject({
      error: { message: expect.stringContaining("password sign-in") }
    });
    expect(harness.transport.list()).toHaveLength(1);
  });

  it("lets a superadmin invite a user who then sets their own password", async () => {
    const harness = await createMailHarness();
    const created = await harness.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
      payload: { displayLabel: "Grace", email: "grace@example.test" }
    });
    expect(created.statusCode).toBe(200);
    const userId = created.json<{ id: string }>().id;

    const invited = await harness.server.inject({
      method: "POST",
      url: `/api/superadmin/users/${userId}/invitation`
    });
    expect(invited.statusCode).toBe(200);

    const [mail] = harness.transport.list();
    expect(mail!.to.email).toBe("grace@example.test");
    expect(mail!.text).toContain("Admin has invited you to Demo");
    const completed = await harness.server.inject({
      method: "POST",
      url: "/api/password-setup",
      payload: { token: readToken(mail!.text), password: "graces-password" }
    });
    expect(completed.statusCode).toBe(200);
    expect([...harness.passwords.values()]).toContain("graces-password");
    expect((await harness.listAuditEvents()).map((event) => event.type)).toContain(
      "user.invitation_sent"
    );
  });
});

function readToken(text: string): string {
  const match = /#password-setup=([\w-]+)/u.exec(text);
  if (!match?.[1]) {
    throw new Error("Mail does not contain a password setup link");
  }
  return match[1];
}

async function createMailHarness(input: { mailEnabled?: boolean; listCaptured?: boolean } = {}) {
  const clientInstanceId = asClientInstanceId("demo-local");
  const store = new InMemoryPlatformStore();
  const config = createTestConfig();
  const transport = new CaptureMailTransport();
  const passwords = new Map<string, string>();
  const signIns = new Map<string, { externalUserId: string; displayLabel: string }>();
  const tokens = new Map<string, string>();
  const admin: AuthenticatedUser = await store.resolveUserIdentity({
    clientInstanceId,
    authSource: "development",
    externalUserId: "admin",
    displayLabel: "Admin",
    roles: ["user", "admin", "superadmin"],
    permissionRefs: [],
    correlationId: "corr_admin"
  });

  const standaloneAuth: NonNullable<ChatServerOptions["standaloneAuth"]> = {
    baseUrl: "http://127.0.0.1:4100/api/auth",
    async handleRequest() {
      return new Response(null, { status: 404 });
    },
    async setPassword(command) {
      passwords.set(command.externalUserId, command.password);
    },
    async setOrCreatePasswordSignIn(command) {
      const externalUserId = `auth-${command.email}`;
      signIns.set(command.email, { externalUserId, displayLabel: command.displayLabel });
      passwords.set(externalUserId, command.password);
      return {
        externalUserId,
        displayLabel: command.displayLabel,
        email: command.email,
        emailVerified: true
      };
    },
    async changePassword() {},
    async deletePasswordSignIn() {},
    async findPasswordSignIn(command) {
      const signIn = signIns.get(command.email);
      return signIn ? { ...signIn, email: command.email, emailVerified: true } : undefined;
    },
    async createPasswordSetupToken(command) {
      const token = `token-${tokens.size + 1}`;
      tokens.set(token, command.externalUserId);
      return token;
    },
    async completePasswordSetup(command) {
      const externalUserId = tokens.get(command.token);
      if (!externalUserId) {
        throw new AppError("VALIDATION_FAILED", "This link is invalid or has expired");
      }
      tokens.delete(command.token);
      passwords.set(externalUserId, command.password);
      return { externalUserId };
    }
  };

  const server = await createChatServer({
    config,
    clientInstanceId,
    authAdapter: {
      id: "test-auth",
      async authenticate() {
        return { ...admin, scopes: ["*"] };
      }
    },
    conversationStore: store,
    auditEventStore: store,
    userStore: store,
    apiAccessStore: store,
    usageGovernance: new ModelUsageGovernance({
      store,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      costs: config.usage.costs
    }),
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store }),
    agentRuntime: createMissingRuntime(),
    modelProvider: createUnusedModelProvider(),
    standaloneAuth,
    mail:
      input.mailEnabled === false
        ? undefined
        : {
            sender: new TemplateMailSender(transport, { ...identity, productName: "Demo" }),
            appUrl: "https://chat.example.test/",
            ...(input.listCaptured ? { listCaptured: () => transport.list() } : {})
          }
  } as ChatServerOptions);

  return {
    server,
    transport,
    passwords,
    requestReset: (email: string) =>
      server.inject({ method: "POST", url: "/api/password-reset", payload: { email } }),
    listAuditEvents: () => store.listAuditEvents({ clientInstanceId }),
    async addPasswordUser(email: string, displayLabel: string) {
      const externalUserId = `auth-${email}`;
      signIns.set(email, { externalUserId, displayLabel });
      await store.resolveUserIdentity({
        clientInstanceId,
        authSource: STANDALONE_AUTH_SOURCE,
        externalUserId,
        displayLabel,
        email,
        emailVerified: true,
        roles: ["user"],
        permissionRefs: [],
        correlationId: "corr_user"
      });
      return { externalUserId };
    }
  };
}
