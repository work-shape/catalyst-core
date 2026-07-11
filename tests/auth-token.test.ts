import { describe, expect, it } from "vitest";
import { CHAT_SESSION_AUTH_SCOPES, asClientInstanceId } from "@vivd-catalyst/core";
import {
  HmacSessionTokenAuthAdapter,
  HmacSessionTokenIssuer
} from "@vivd-catalyst/auth";

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
    expect(user.scopes).toEqual([...CHAT_SESSION_AUTH_SCOPES]);
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
});
