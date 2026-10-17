import { describe, expect, it } from "vitest";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { egressTargetOfUrl } from "@work-shape/catalyst-connections";
import {
  SHARED_CREDENTIAL_SUBJECT,
  asClientInstanceId,
  egressOriginOf,
  type ConnectorTypeDefinition,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { required } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";
import { createTestConnector, generateSecretStoreKey } from "./support/test-connector";
import { createTestInstance } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// CS-4b2, spec "Revocation": changing a Connection's origin or its auth scheme ends its
// shared sign-in, and a revert never restores a binding or a token. A release-origin
// Connection changes by release config, at a start, so the release seed ends a sign-in made
// for another address or kept by a Connection that no longer signs in. (A runtime-origin
// Connection's change is tested in connection-oauth-refusals.test.ts.)

const clientInstanceId = asClientInstanceId("demo-local");
const KEY_VARIABLE = "CATALYST_SECRET_STORE_KEY";
const HOST = "93.184.216.34";
const HOME = `https://${HOST}/mcp`;
const ELSEWHERE = `https://${HOST}:8443/mcp`;

const base = createTestConnector().type;
const signing: ConnectorTypeDefinition = { ...base, authSchemes: [...base.authSchemes, "oauth"] };
const env = { [KEY_VARIABLE]: generateSecretStoreKey() };

function start(url: string, authScheme: "oauth" | "none") {
  const config = parseClientInstanceConfig({
    ...createTestConfig(),
    modules: { connections: { enabled: true } },
    connections: {
      outside: {
        connectorType: "test",
        displayName: "Outside",
        settings: { url },
        authScheme,
        operations: [{ name: "echo", effect: "reading", exposure: ["agent"] }]
      }
    },
    secretStore: { keys: [{ id: "k1", ref: KEY_VARIABLE }] },
    egress: {
      allow: [
        { protocol: "https", host: HOST, port: 443 },
        { protocol: "https", host: HOST, port: 8443 }
      ]
    }
  });
  return createTestInstance({
    config,
    env,
    tools: [],
    connectorTypes: [signing],
    seedAssets: false
  });
}

/** Signs `outside` in at its current address, as a completed callback stores it. */
async function signIn(stores: PlatformStores, url: string) {
  const asset = required(
    await stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name: "outside"
    })
  );
  const key = { clientInstanceId, connectionAssetId: asset.id, subject: SHARED_CREDENTIAL_SUBJECT };
  const before = await stores.connections.getConnectionBinding(key);
  await stores.connections.connectConnectionBinding({
    ...key,
    scheme: "oauth",
    grantedScopes: [],
    secretHandle: "sec_token_set",
    secretVersion: 1,
    origin: egressOriginOf(egressTargetOfUrl(url)),
    expectedRowVersion: before?.rowVersion ?? null
  });
}

const state = () =>
  withTestSql((sql) => sql<{ state: string }[]>`select state from connection_bindings`).then(
    (rows) => rows.map((row) => row.state)
  );

describe("the release seed of a Connection that signs in", () => {
  it("ends the sign-in when release config moves the Connection, and moving back restores none", async () => {
    const first = await start(HOME, "oauth");
    await signIn(first.stores, HOME);
    await first.close();
    const kept = await start(HOME, "oauth");
    expect(await state()).toEqual(["connected"]);
    await kept.close();

    await (await start(ELSEWHERE, "oauth")).close();
    expect(await state()).toEqual(["revoked"]);
    await (await start(HOME, "oauth")).close();
    expect(await state()).toEqual(["revoked"]);
  });

  it("ends the sign-in when release config stops the Connection signing in", async () => {
    const first = await start(HOME, "oauth");
    await signIn(first.stores, HOME);
    await first.close();
    await (await start(HOME, "none")).close();
    expect(await state()).toEqual(["revoked"]);
    await (await start(HOME, "oauth")).close();
    expect(await state()).toEqual(["revoked"]);
  });
});
