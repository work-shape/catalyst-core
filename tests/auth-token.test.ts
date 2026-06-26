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
      permissionRefs: ["demo-tools"]
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
});
