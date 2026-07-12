import { describe, expect, it } from "vitest";
import {
  ApiKeyAccessTokenExchange,
  HmacServiceAccessTokenAuthAdapter,
  IdentityResolvingAuthAdapter
} from "@vivd-catalyst/auth";
import { asClientInstanceId, requireAuthScope } from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";

const secret = "a-test-service-access-token-secret-with-enough-length";

describe("service access tokens", () => {
  it("intersects credential scopes with current principal permissions", async () => {
    const fixture = await createFixture({
      permissions: ["config_assets.read"],
      scopes: ["config_assets:read", "config_assets:release"]
    });

    const issued = await fixture.exchange.exchange(fixture.apiKey);
    const principal = await fixture.adapter.authenticate(authRequest(fixture.clientInstanceId, issued.accessToken));

    expect(principal).toMatchObject({
      kind: "service",
      id: fixture.servicePrincipalId,
      credentialId: fixture.credentialId,
      permissions: ["config_assets.read"],
      scopes: ["config_assets:read"]
    });
  });

  it("applies explicit principal permission revocations before issuing grants", async () => {
    const fixture = await createFixture({
      permissions: ["config_assets.release", "!config_assets.release"],
      scopes: ["config_assets:release"]
    });

    const issued = await fixture.exchange.exchange(fixture.apiKey);
    expect(issued.principal).toMatchObject({ permissions: [], scopes: [] });
    await expect(
      fixture.adapter.authenticate(authRequest(fixture.clientInstanceId, issued.accessToken))
    ).resolves.toMatchObject({ permissions: [], scopes: [] });
    expect(() => requireAuthScope(issued.principal, "config_assets:release")).toThrow(
      "Missing auth scope"
    );
  });

  it("bypasses product-user identity resolution", async () => {
    const fixture = await createFixture();
    const issued = await fixture.exchange.exchange(fixture.apiKey);
    const resolving = new IdentityResolvingAuthAdapter(fixture.adapter, fixture.store);

    await expect(
      resolving.authenticate(authRequest(fixture.clientInstanceId, issued.accessToken))
    ).resolves.toMatchObject({ kind: "service", id: fixture.servicePrincipalId });
    await expect(
      fixture.store.listUsers({ clientInstanceId: fixture.clientInstanceId })
    ).resolves.toEqual([]);
  });

  it("rejects a wrong API key and an API key from another client", async () => {
    const fixture = await createFixture();
    const wrongKey = `${fixture.apiKey.slice(0, -1)}${fixture.apiKey.endsWith("0") ? "1" : "0"}`;
    await expect(fixture.exchange.exchange(wrongKey)).rejects.toMatchObject({
      code: "UNAUTHENTICATED"
    });

    const otherClientExchange = new ApiKeyAccessTokenExchange({
      secret,
      clientInstanceId: asClientInstanceId("other-client"),
      apiAccessStore: fixture.store
    });
    await expect(otherClientExchange.exchange(fixture.apiKey)).rejects.toMatchObject({
      code: "UNAUTHENTICATED"
    });
  });

  it("rejects revoked, expired, and disabled credentials", async () => {
    const revoked = await createFixture();
    await revoked.store.revokeApiCredential({
      clientInstanceId: revoked.clientInstanceId,
      credentialId: revoked.credentialId
    });
    await expect(revoked.exchange.exchange(revoked.apiKey)).rejects.toThrow("revoked");

    const expired = await createFixture({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    await expect(expired.exchange.exchange(expired.apiKey)).rejects.toThrow("expired");

    const disabled = await createFixture();
    await disabled.store.updateServicePrincipal({
      clientInstanceId: disabled.clientInstanceId,
      servicePrincipalId: disabled.servicePrincipalId,
      status: "disabled"
    });
    await expect(disabled.exchange.exchange(disabled.apiKey)).rejects.toThrow("disabled");
  });

  it("rechecks revocation while verifying an already-issued access token", async () => {
    const fixture = await createFixture();
    const issued = await fixture.exchange.exchange(fixture.apiKey);
    await fixture.store.revokeApiCredential({
      clientInstanceId: fixture.clientInstanceId,
      credentialId: fixture.credentialId
    });

    await expect(
      fixture.adapter.authenticate(authRequest(fixture.clientInstanceId, issued.accessToken))
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("enforces the dedicated token-secret and TTL constraints", () => {
    const store = new InMemoryPlatformStore();
    const clientInstanceId = asClientInstanceId("service-auth-test");
    expect(
      () =>
        new ApiKeyAccessTokenExchange({
          secret: "too-short",
          clientInstanceId,
          apiAccessStore: store
        })
    ).toThrow("at least 32 characters");
    expect(
      () =>
        new ApiKeyAccessTokenExchange({
          secret,
          clientInstanceId,
          ttlSeconds: 901,
          apiAccessStore: store
        })
    ).toThrow("between 10 and 15 minutes");
  });
});

async function createFixture(
  input: {
    permissions?: string[];
    scopes?: string[];
    expiresAt?: string;
  } = {}
) {
  const clientInstanceId = asClientInstanceId("service-auth-test");
  const store = new InMemoryPlatformStore();
  const servicePrincipal = await store.createServicePrincipal({
    clientInstanceId,
    displayLabel: "Catalyst CLI",
    permissions: input.permissions ?? ["config_assets.read", "config_assets.release"]
  });
  const created = await store.createApiCredential({
    clientInstanceId,
    servicePrincipalId: servicePrincipal.id,
    name: "test key",
    scopes: input.scopes,
    expiresAt: input.expiresAt
  });
  const options = {
    secret,
    clientInstanceId,
    apiAccessStore: store
  };
  return {
    clientInstanceId,
    store,
    servicePrincipalId: servicePrincipal.id,
    credentialId: created.credential.id,
    apiKey: created.secret,
    exchange: new ApiKeyAccessTokenExchange(options),
    adapter: new HmacServiceAccessTokenAuthAdapter(options)
  };
}

function authRequest(clientInstanceId: ReturnType<typeof asClientInstanceId>, token: string) {
  return {
    headers: { authorization: `Bearer ${token}` },
    clientInstanceId,
    correlationId: "corr_service_auth_test"
  };
}
