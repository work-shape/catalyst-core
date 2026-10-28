import { createHmac } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CHAT_SESSION_AUTH_SCOPES,
  asClientInstanceId,
  type DelegatedActor
} from "@work-shape/catalyst-core";
import {
  HmacSessionTokenAuthAdapter,
  HmacSessionTokenIssuer,
  type SessionTokenInput
} from "@work-shape/catalyst-auth";

/** Signs claims as the issuer does: a token only a holder of the secret can make. */
function signedToken(claims: object, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

describe("HMAC chat session tokens", () => {
  it("normalizes signed token claims into an authenticated user", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const options = {
      secret: "a-development-secret-with-enough-length",
      clientInstanceId,
      issuer: "demo",
      ttlSeconds: 900
    };
    const issuer = new HmacSessionTokenIssuer(options);
    const adapter = new HmacSessionTokenAuthAdapter(options);

    const issued = issuer.issue({
      externalUserId: "external-123",
      displayLabel: "Jane Reviewer",
      roles: ["user"],
      permissionRefs: ["demo-tools"],
      permissions: ["usage.view"]
    });

    const user = await adapter.authenticate({
      headers: {
        authorization: `Bearer ${issued.chatSessionToken}`
      },
      clientInstanceId,
      correlationId: "corr_test"
    });

    expect(user.externalUserId).toBe("external-123");
    expect(user.displayLabel).toBe("Jane Reviewer");
    expect(user.permissionRefs).toContain("demo-tools");
    expect(user.permissions).toEqual(["usage.view"]);
    expect(user.clientInstanceId).toBe(clientInstanceId);
    expect(user.subjectUserId).toBe(`${clientInstanceId}:external-123`);
    expect(user.principal).toMatchObject({
      kind: "user",
      id: `${clientInstanceId}:external-123`
    });
    // The host acting for the person, though the token names no actor of its own.
    expect(user.delegatedActor).toEqual({
      kind: "service_principal",
      id: "demo",
      displayLabel: "demo",
      authSource: "session-token"
    });
    expect(user.scopes).toEqual([...CHAT_SESSION_AUTH_SCOPES]);
  });

  // The host mints a token for any person with one server credential, and identity linking
  // maps it onto the person's own sign-in: nothing proves the person is present, so the
  // credential that verified the token names the host, not a field the host fills in.
  it("names the issuer as the delegated actor of a token signed without one, with chat scopes only", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const options = {
      secret: "a-development-secret-with-enough-length",
      clientInstanceId,
      issuer: "demo",
      ttlSeconds: 900
    };
    const adapter = new HmacSessionTokenAuthAdapter(options);
    // Signed by hand as a token in flight from before the verifier named the host.
    const now = Math.floor(Date.now() / 1000);
    const token = signedToken(
      {
        sub: "kai",
        displayLabel: "Kai",
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId,
        authSource: "embed",
        iss: "demo",
        iat: now,
        exp: now + 300
      },
      options.secret
    );

    const user = await adapter.authenticate({
      headers: { authorization: `Bearer ${token}` },
      clientInstanceId,
      correlationId: "corr_unnamed"
    });

    expect(user.delegatedActor).toEqual({
      kind: "service_principal",
      id: "demo",
      displayLabel: "demo",
      authSource: "embed"
    });
    expect(user.principal).toMatchObject({ kind: "user", id: `${clientInstanceId}:kai` });
    expect(user.scopes).toEqual([...CHAT_SESSION_AUTH_SCOPES]);

    // The default actor never widens the scopes: a first-party scope still needs a signed one.
    const widened = signedToken(
      {
        sub: "kai",
        displayLabel: "Kai",
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId,
        authSource: "embed",
        iss: "demo",
        iat: now,
        exp: now + 300,
        scopes: ["config_assets:read"]
      },
      options.secret
    );
    await expect(
      adapter.authenticate({
        headers: { authorization: `Bearer ${widened}` },
        clientInstanceId,
        correlationId: "corr_widened"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects broad bearer scopes during chat session token issuance", () => {
    const issuer = new HmacSessionTokenIssuer({
      secret: "a-development-secret-with-enough-length",
      clientInstanceId: asClientInstanceId("demo-local"),
      issuer: "demo",
      ttlSeconds: 900
    });

    expect(() =>
      issuer.issue({
        externalUserId: "external-123",
        displayLabel: "Jane Reviewer",
        scopes: ["*"]
      })
    ).toThrow("Chat session token scopes must be limited to chat API operations");
  });

  it("allows explicit first-party config asset scopes for service principals", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const options = {
      secret: "a-development-secret-with-enough-length",
      clientInstanceId,
      issuer: "demo",
      ttlSeconds: 900
    };
    const issuer = new HmacSessionTokenIssuer(options);
    const adapter = new HmacSessionTokenAuthAdapter(options);
    const issued = issuer.issue({
      externalUserId: "config-cli",
      displayLabel: "Config CLI",
      permissions: ["config_assets.read", "config_assets.write"],
      scopes: ["config_assets:read", "config_assets:write"],
      delegatedActor: {
        kind: "service_principal",
        id: "config-cli",
        authSource: "server-credential"
      }
    });

    const user = await adapter.authenticate({
      headers: { authorization: `Bearer ${issued.chatSessionToken}` },
      clientInstanceId,
      correlationId: "corr_service"
    });

    expect(user.scopes).toEqual(["config_assets:read", "config_assets:write"]);
    expect(user.permissions).toEqual(["config_assets.read", "config_assets.write"]);
    expect(user.principal).toMatchObject({ kind: "service", id: "config-cli" });
  });

  it("keeps non-service tokens restricted to chat scopes", () => {
    const issuer = new HmacSessionTokenIssuer({
      secret: "a-development-secret-with-enough-length",
      clientInstanceId: asClientInstanceId("demo-local"),
      issuer: "demo",
      ttlSeconds: 900
    });

    expect(() =>
      issuer.issue({
        externalUserId: "external-123",
        displayLabel: "Jane Reviewer",
        scopes: ["config_assets:read"]
      })
    ).toThrow("Chat session token scopes must be limited to chat API operations");
  });

  it("rejects Collaboration Workspace scopes for user chat sessions", () => {
    const issuer = new HmacSessionTokenIssuer({
      secret: "a-development-secret-with-enough-length",
      clientInstanceId: asClientInstanceId("demo-local"),
      issuer: "demo",
      ttlSeconds: 900
    });

    expect(() =>
      issuer.issue({
        externalUserId: "external-123",
        displayLabel: "Jane Reviewer",
        scopes: ["collaboration_workspace:manage"]
      })
    ).toThrow(
      expect.objectContaining({
        code: "VALIDATION_FAILED"
      })
    );
  });

  it("allows Collaboration Workspace scopes for service principals", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const options = {
      secret: "a-development-secret-with-enough-length",
      clientInstanceId,
      issuer: "demo",
      ttlSeconds: 900
    };
    const issuer = new HmacSessionTokenIssuer(options);
    const adapter = new HmacSessionTokenAuthAdapter(options);
    const issued = issuer.issue({
      externalUserId: "workspace-service",
      displayLabel: "Workspace service",
      scopes: ["collaboration_workspace:manage"],
      delegatedActor: {
        kind: "service_principal",
        id: "workspace-service",
        authSource: "server-credential"
      }
    });

    const user = await adapter.authenticate({
      headers: { authorization: `Bearer ${issued.chatSessionToken}` },
      clientInstanceId,
      correlationId: "corr_workspace_service"
    });

    expect(user.scopes).toEqual(["collaboration_workspace:manage"]);
  });

  it("rejects wildcard and unknown scopes for service principals", () => {
    const issuer = new HmacSessionTokenIssuer({
      secret: "a-development-secret-with-enough-length",
      clientInstanceId: asClientInstanceId("demo-local"),
      issuer: "demo",
      ttlSeconds: 900
    });
    const delegatedActor = {
      kind: "service_principal" as const,
      id: "config-cli",
      authSource: "server-credential"
    };

    for (const scopes of [["*"], ["unknown:scope"]]) {
      expect(() =>
        issuer.issue({
          externalUserId: "config-cli",
          displayLabel: "Config CLI",
          scopes,
          delegatedActor
        })
      ).toThrow(
        "Service session token scopes must be limited to explicit first-party API operations"
      );
    }
  });

  it("issues a session token for a service principal only, never for an API key", () => {
    expectTypeOf<Extract<DelegatedActor, { kind: "api_key" }>>().not.toMatchTypeOf<
      SessionTokenInput["delegatedActor"]
    >();
    const issuer = new HmacSessionTokenIssuer({
      secret: "a-development-secret-with-enough-length",
      clientInstanceId: asClientInstanceId("demo-local"),
      issuer: "demo",
      ttlSeconds: 900
    });
    const delegatedActor = { kind: "service_principal" as const, id: "key_x", authSource: "x" };
    // What a caller outside the type system can still pass, such as a host's JavaScript.
    Reflect.set(delegatedActor, "kind", "api_key");

    expect(() =>
      issuer.issue({ externalUserId: "kai", displayLabel: "Kai", delegatedActor })
    ).toThrow(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        message: "A session token names only a service principal as its delegated actor"
      })
    );
  });

  // CONNECT-1b verification: a signed token naming an API key authenticated, skipped resolving
  // its user, and `originOf` in chat-server's route.ts recorded its calls as the CLI.
  it("does not authenticate a session token that names any other delegated actor", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const options = {
      secret: "a-development-secret-with-enough-length",
      clientInstanceId,
      issuer: "demo",
      ttlSeconds: 900
    };
    const adapter = new HmacSessionTokenAuthAdapter(options);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: "kai",
      displayLabel: "Kai",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "session-token",
      iss: "demo",
      iat: now,
      exp: now + 300
    };

    for (const delegatedActor of [
      { kind: "api_key", id: "key_x", displayLabel: "x", authSource: "x" },
      { id: "key_x", authSource: "x" },
      null
    ]) {
      await expect(
        adapter.authenticate({
          headers: {
            authorization: `Bearer ${signedToken({ ...claims, delegatedActor }, options.secret)}`
          },
          clientInstanceId,
          correlationId: "corr_forged"
        })
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }
  });
});
