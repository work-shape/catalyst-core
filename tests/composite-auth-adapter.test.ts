import { createTestInstance } from "./support/test-instance";
import { describe, expect, it, vi } from "vitest";
import { AppError, asClientInstanceId, type AuthenticatedUser } from "@vivd-catalyst/core";

import { CompositeAuthAdapter, IdentityResolvingAuthAdapter } from "@vivd-catalyst/auth";

const request = {
  clientInstanceId: asClientInstanceId("composite-auth-test"),
  correlationId: "composite-auth-test",
  headers: { authorization: "Bearer test-token", cookie: "session=present" }
};
const user: AuthenticatedUser = {
  id: "cookie-user",
  externalUserId: "cookie-user",
  displayLabel: "Cookie User",
  roles: [],
  permissionRefs: [],
  authSource: "test",
  clientInstanceId: request.clientInstanceId
};

describe("composite auth credential modes", () => {
  it("does not consult an unmarked adapter when a bearer header is present", async () => {
    const authenticate = vi.fn(async () => user);
    const composite = new CompositeAuthAdapter([
      // Simulate a JavaScript adapter that does not declare its credential mode.
      // @ts-expect-error AuthAdapter requires a credential mode.
      { id: "custom-cookie", authenticate }
    ]);

    await expect(composite.authenticate(request)).rejects.toMatchObject({
      code: "UNAUTHENTICATED"
    });
    expect(authenticate).not.toHaveBeenCalled();
    await expect(composite.authenticate({ ...request, headers: {} })).resolves.toEqual(user);
  });

  it.each(["ambient", "explicit"] as const)(
    "preserves %s mode through identity resolution",
    async (credentialMode) => {
      const authenticate = vi.fn(async () => user);
      const wrapped = new IdentityResolvingAuthAdapter(
        { id: "custom", credentialMode, authenticate },
        createTestInstance().stores.users
      );
      expect(wrapped.credentialMode).toBe(credentialMode);
      const composite = new CompositeAuthAdapter([wrapped]);
      if (credentialMode === "ambient") {
        await expect(composite.authenticate(request)).rejects.toMatchObject({
          code: "UNAUTHENTICATED"
        });
        expect(authenticate).not.toHaveBeenCalled();
      } else {
        await expect(composite.authenticate(request)).resolves.toMatchObject({
          externalUserId: user.externalUserId
        });
        expect(authenticate).toHaveBeenCalledOnce();
      }
    }
  );

  it("keeps nested composites usable without allowing ambient fallback", async () => {
    const ambient = vi.fn(async () => user);
    const explicit = vi.fn(async () => {
      throw new AppError("UNAUTHENTICATED", "Invalid token");
    });
    const composite = new CompositeAuthAdapter([
      new CompositeAuthAdapter([
        { id: "cookie", credentialMode: "ambient", authenticate: ambient },
        { id: "token", credentialMode: "explicit", authenticate: explicit }
      ])
    ]);
    await expect(composite.authenticate(request)).rejects.toMatchObject({
      code: "UNAUTHENTICATED"
    });
    expect(explicit).toHaveBeenCalledOnce();
    expect(ambient).not.toHaveBeenCalled();
  });
});
