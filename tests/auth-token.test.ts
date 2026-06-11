import { describe, expect, it } from "vitest";
import { asClientInstanceId } from "@vivd-catalyst/core";
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
  });
});

