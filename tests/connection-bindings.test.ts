import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  connectionConfigSchema,
  parseClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import {
  createConnectionCredentialResolver,
  createEgressChecker,
  createSecretStore,
  loadSecretKeyring,
  openConnectorContext,
  type SecretKeyring
} from "@work-shape/catalyst-connections";
import {
  AppError,
  SHARED_CREDENTIAL_SUBJECT,
  asClientInstanceId,
  egressOriginOf,
  signInSecretSubject,
  type ConnectionBindingKey,
  type ConnectionBindingRecord,
  type ConnectorTypeDefinition,
  type ConnectionsStore
} from "@work-shape/catalyst-core";
import { required } from "./support/assertions";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { connection, fixtureConnectorType } from "./support/connections";
import { createTestConfig } from "./support/fixtures";
import {
  captureProcessOutput,
  dumpDatabaseText,
  findLeak,
  generateSecretStoreKey,
  generateTestSecret
} from "./support/test-connector";
import { createTestInstance, getTestJobs, type TestPostgresStore } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// The sign-in bindings of Connections and the setup sessions of sign-ins under way, over real
// rows (CS-4b1). Before them there was no table, no lease and no resolver of a sign-in.

const clientInstanceId = asClientInstanceId("connection-bindings-test");
const HOST = "outside.example.test";
const target = { protocol: "https" as const, host: HOST, port: 443 };
const ORIGIN = egressOriginOf(target);
const OTHER_ORIGIN = egressOriginOf({ ...target, host: "elsewhere.example.test" });

/** The fixture type with the sign-in scheme, as a type that lists `oauth` offers it. */
const signedType: ConnectorTypeDefinition = {
  ...fixtureConnectorType,
  authSchemes: ["none", "bearer", "oauth"]
};
const egress = createEgressChecker({
  allow: [{ protocol: "https", host: HOST, port: 443, network: "public", cidrs: [] }],
  resolve: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }])
});

async function refusal(work: Promise<unknown>): Promise<AppError> {
  const error: unknown = await work.then(
    () => undefined,
    (caught: unknown) => caught
  );
  if (!(error instanceof AppError)) throw new Error("Expected an AppError");
  return error;
}

const keyringWith = (key: string): Promise<SecretKeyring> =>
  loadSecretKeyring({
    keys: [{ id: "k1", ref: "STORE_KEY" }],
    secrets: { resolve: () => Promise.resolve(key) }
  });

describe("the bindings of Connections", () => {
  let stores: TestPostgresStore;
  let keyring: SecretKeyring;
  let assetId: string;
  let key: ConnectionBindingKey;

  beforeEach(async () => {
    stores = (await createTestInstance({ postgres: {} })).stores;
    keyring = await keyringWith(generateSecretStoreKey());
    await applyAtCurrentRevisions(stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "signed",
          config: connection("signed", { authScheme: "oauth", secretHandle: undefined })
        }
      ]
    });
    assetId = required(
      await stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name: "signed"
      })
    ).id;
    key = { clientInstanceId, connectionAssetId: assetId, subject: SHARED_CREDENTIAL_SUBJECT };
  });

  /** Stores a token set the way a callback does, and the binding that names it. */
  async function signIn(
    input: { origin?: string; expectedRowVersion?: number | null; accessToken?: string } = {},
    store: ConnectionsStore = stores.connections
  ) {
    const accessToken = input.accessToken ?? generateTestSecret();
    const refreshToken = generateTestSecret();
    const origin = input.origin ?? ORIGIN;
    const written = await createSecretStore({ clientInstanceId, keyring, store }).put({
      binding: {
        connectionAssetId: assetId,
        subject: signInSecretSubject(SHARED_CREDENTIAL_SUBJECT)
      },
      value: JSON.stringify({ accessToken, refreshToken }),
      source: "runtime",
      origin
    });
    const binding = await store.connectConnectionBinding({
      ...key,
      scheme: "oauth",
      accountLabel: "Shared account",
      grantedScopes: ["read"],
      secretHandle: written.handle,
      secretVersion: written.version,
      connectedBy: "user-1",
      origin,
      expectedRowVersion: input.expectedRowVersion ?? null
    });
    return { accessToken, refreshToken, binding };
  }

  describe("writes", () => {
    it("creates a binding once, and replaces it only at the row version that was read", async () => {
      const { binding } = await signIn();
      expect(required(binding)).toMatchObject({
        state: "connected",
        scheme: "oauth",
        origin: ORIGIN,
        grantedScopes: ["read"],
        secretVersion: 1,
        rowVersion: 1
      });
      // A second creation finds the row there and writes nothing.
      expect((await signIn({ expectedRowVersion: null })).binding).toBeUndefined();

      const moved = required(
        await stores.connections.changeConnectionBindingState({
          ...key,
          expectedRowVersion: 1,
          state: "needs_reconnect",
          reason: "refresh_refused"
        })
      );
      expect(moved).toMatchObject({
        state: "needs_reconnect",
        stateReason: "refresh_refused",
        rowVersion: 2
      });

      // Version 1 is stale now: neither a state change nor a new sign-in at it writes.
      expect(
        await stores.connections.changeConnectionBindingState({
          ...key,
          expectedRowVersion: 1,
          state: "revoked",
          reason: "disconnected"
        })
      ).toBeUndefined();
      expect((await signIn({ expectedRowVersion: 1 })).binding).toBeUndefined();
      expect(await stores.connections.getConnectionBinding(key)).toMatchObject({
        state: "needs_reconnect",
        rowVersion: 2
      });

      // At the version read, a new sign-in connects it again.
      const again = required((await signIn({ expectedRowVersion: 2 })).binding);
      expect(again).toMatchObject({ state: "connected", rowVersion: 3 });
      expect(again.stateReason).toBeUndefined();
    });

    it("lets one of two processes take the lease, and the other after it ran out", async () => {
      // Fails without the condition on the lease: every taker got the binding.
      await signIn();
      const other = await createTestInstance({ postgres: {} });
      const processes = [stores.connections, other.stores.connections];
      for (let round = 0; round < 5; round += 1) {
        await withTestSql(
          (sql) => sql`update connection_bindings set lease_owner = null, lease_expires_at = null`
        );
        const owners = Array.from({ length: 8 }, (_, index) => `worker-${round}-${index}`);
        const taken = await Promise.all(
          owners.map((owner, index) =>
            required(processes[index % 2]).takeConnectionBindingLease({
              ...key,
              owner,
              leaseMs: 60_000
            })
          )
        );
        const winners = taken.flatMap((binding, index) => (binding ? [owners[index]] : []));
        expect(winners).toHaveLength(1);
        expect(await stores.connections.getConnectionBinding(key)).toMatchObject({
          leaseOwner: winners[0]
        });
      }

      const holder = required((await stores.connections.getConnectionBinding(key))?.leaseOwner);
      // The holder takes it again, to go on; another owner and a release by it are refused.
      expect(
        await other.stores.connections.takeConnectionBindingLease({
          ...key,
          owner: holder,
          leaseMs: 60_000
        })
      ).toMatchObject({ leaseOwner: holder });
      expect(
        await stores.connections.releaseConnectionBindingLease({ ...key, owner: "someone-else" })
      ).toBe(false);
      // A lease that ran out is anybody's, by the database clock.
      await withTestSql(
        (sql) =>
          sql`update connection_bindings set lease_expires_at = clock_timestamp() - interval '1 second'`
      );
      expect(
        await stores.connections.takeConnectionBindingLease({
          ...key,
          owner: "late-worker",
          leaseMs: 60_000
        })
      ).toMatchObject({ leaseOwner: "late-worker" });
      expect(
        await stores.connections.releaseConnectionBindingLease({ ...key, owner: holder })
      ).toBe(false);
      expect(
        await stores.connections.releaseConnectionBindingLease({ ...key, owner: "late-worker" })
      ).toBe(true);
      const released = required(await stores.connections.getConnectionBinding(key));
      expect([released.leaseOwner, released.leaseExpiresAt]).toEqual([undefined, undefined]);
      // The lease is no change of the binding: its row version stays.
      expect(released.rowVersion).toBe(1);
      await other.close();
    });

    it("goes with its Connection", async () => {
      await signIn();
      await withTestSql((sql) => sql`delete from config_assets where id = ${assetId}`);
      expect(await stores.connections.getConnectionBinding(key)).toBeUndefined();
    });
  });

  describe("setup sessions", () => {
    const session = (overrides: { stateHash?: string; ttlMs?: number; instance?: string } = {}) =>
      stores.connections.createConnectionSetupSession({
        id: `setup_${randomUUID()}`,
        clientInstanceId: asClientInstanceId(overrides.instance ?? clientInstanceId),
        connectionAssetId: assetId,
        connectionRevision: 1,
        subject: SHARED_CREDENTIAL_SUBJECT,
        actorUserId: "user-1",
        authSessionId: "session-1",
        stateHash: overrides.stateHash ?? randomBytes(32).toString("base64url"),
        verifier: { keyId: "k1", nonce: randomBytes(12), ciphertext: randomBytes(48) },
        redirectUri: "https://instance.example.test/api/connections/oauth/callback",
        issuer: "https://auth.example.test",
        resource: "https://outside.example.test/mcp",
        clientId: "client-1",
        scopes: ["read"],
        ttlMs: overrides.ttlMs ?? 15 * 60_000
      });

    it("is consumed once, also by two callbacks at the same time", async () => {
      const created = await session();
      const lifetime = Date.parse(created.expiresAt) - Date.parse(created.createdAt);
      expect(lifetime).toBeGreaterThanOrEqual(15 * 60_000);
      expect(lifetime).toBeLessThan(15 * 60_000 + 1000);
      const consume = () =>
        stores.connections.consumeConnectionSetupSession({
          clientInstanceId,
          stateHash: created.stateHash
        });
      const outcomes = await Promise.all([consume(), consume(), consume()]);
      expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual([
        "consumed",
        "unknown",
        "unknown"
      ]);
      const consumed = required(outcomes.find((outcome) => outcome.outcome === "consumed"));
      expect(consumed).toEqual({ outcome: "consumed", session: created });
      expect(await consume()).toEqual({ outcome: "unknown" });
      // A state of another instance is none.
      const elsewhere = await session({ instance: "another-instance" });
      expect(
        await stores.connections.consumeConnectionSetupSession({
          clientInstanceId,
          stateHash: elsewhere.stateHash
        })
      ).toEqual({ outcome: "unknown" });
    });

    it("answers an expired session as expired once, and never hands it out", async () => {
      const expired = await session({ ttlMs: 0 });
      const consume = () =>
        stores.connections.consumeConnectionSetupSession({
          clientInstanceId,
          stateHash: expired.stateHash
        });
      expect(await consume()).toEqual({ outcome: "expired" });
      expect(await consume()).toEqual({ outcome: "unknown" });
    });

    it("sweeps the expired sessions of its instance and leaves the rest", async () => {
      const live = await session();
      await session({ ttlMs: 0 });
      await session({ ttlMs: 0 });
      const elsewhere = await session({ ttlMs: 0, instance: "another-instance" });
      expect(
        await stores.connections.sweepExpiredConnectionSetupSessions({ clientInstanceId })
      ).toBe(2);
      const left = await withTestSql(
        (sql) => sql<{ id: string }[]>`select id from connection_setup_sessions order by id`
      );
      expect(left.map((row) => row.id).sort()).toEqual([live.id, elsewhere.id].sort());
    });
  });

  describe("the resolver of a sign-in", () => {
    const open = () =>
      openConnectorContext({
        type: signedType,
        connection: {
          id: assetId,
          revision: 1,
          config: connectionConfigSchema.parse(
            connection("signed", { authScheme: "oauth", secretHandle: undefined })
          )
        },
        egress,
        credentials: createConnectionCredentialResolver({
          clientInstanceId,
          keyring,
          store: stores.connections
        }),
        signal: new AbortController().signal
      });
    const reasonOf = async () => (await refusal(open())).details;

    it("hands a call the access token of the connected binding as a bearer header", async () => {
      const { accessToken, refreshToken } = await signIn();
      const context = await open();
      expect(context.credentialFor(context.target)?.headers.authorization).toBe(
        `Bearer ${accessToken}`
      );
      expect(JSON.stringify(context.credentialFor(context.target))).not.toContain(refreshToken);
    });

    it("refuses a binding signed in for another origin, and never uses it", async () => {
      // Fails without the origin check: the token of the other server was handed out.
      const { accessToken } = await signIn({ origin: OTHER_ORIGIN });
      const error = await refusal(open());
      expect(error.details).toEqual({ reason: "connection_not_connected" });
      expect(findLeak(`${error.message}${error.stack ?? ""}`, accessToken)).toBeUndefined();

      // Also where the token set is of this origin and only the binding says another one.
      await withTestSql((sql) => sql`delete from connection_bindings`);
      await signIn();
      await withTestSql((sql) => sql`update connection_bindings set origin = ${OTHER_ORIGIN}`);
      expect(await reasonOf()).toEqual({ reason: "connection_not_connected" });
    });

    it("refuses a Connection nobody signed in for, and does not fall back to its own secret", async () => {
      await createSecretStore({ clientInstanceId, keyring, store: stores.connections }).put({
        binding: { connectionAssetId: assetId, subject: SHARED_CREDENTIAL_SUBJECT },
        value: generateTestSecret(),
        source: "runtime",
        origin: ORIGIN
      });
      expect(await reasonOf()).toEqual({ reason: "connection_not_connected" });
    });

    it("refuses a binding that needs a new sign-in, one that was revoked, and one whose token set is gone", async () => {
      const { binding } = await signIn();
      const moved = required(
        await stores.connections.changeConnectionBindingState({
          ...key,
          expectedRowVersion: required(binding).rowVersion,
          state: "needs_reconnect",
          reason: "refresh_refused"
        })
      );
      // The refusal names the state and why it was entered, so a person's Connect card can say it.
      expect(await reasonOf()).toEqual({
        reason: "connection_needs_reconnect",
        state: "needs_reconnect",
        cause: "refresh_refused"
      });

      await stores.connections.changeConnectionBindingState({
        ...key,
        expectedRowVersion: moved.rowVersion,
        state: "revoked",
        reason: "disconnected"
      });
      expect(await reasonOf()).toEqual({ reason: "connection_not_connected" });

      await withTestSql((sql) => sql`delete from connection_bindings`);
      await signIn();
      await stores.connections.deleteSecrets({
        clientInstanceId,
        connectionAssetId: assetId,
        subject: signInSecretSubject(SHARED_CREDENTIAL_SUBJECT)
      });
      expect(await reasonOf()).toEqual({ reason: "connection_not_connected" });
    });

    it("refuses a token set it cannot read as unreadable", async () => {
      const written = await createSecretStore({
        clientInstanceId,
        keyring,
        store: stores.connections
      }).put({
        binding: {
          connectionAssetId: assetId,
          subject: signInSecretSubject(SHARED_CREDENTIAL_SUBJECT)
        },
        value: "not a token set",
        source: "runtime",
        origin: ORIGIN
      });
      await stores.connections.connectConnectionBinding({
        ...key,
        scheme: "oauth",
        grantedScopes: [],
        secretHandle: written.handle,
        secretVersion: written.version,
        origin: ORIGIN,
        expectedRowVersion: null
      });
      expect(await reasonOf()).toEqual({ reason: "secret_unreadable" });
    });
  });

  it("keeps every token out of every column but the ciphertext of `secrets`", async () => {
    const { accessToken, refreshToken, binding } = await signIn();
    const stored: ConnectionBindingRecord = required(binding);
    const dump = await dumpDatabaseText();
    expect(dump).toContain(stored.secretHandle);
    expect(findLeak(dump, accessToken)).toBeUndefined();
    expect(findLeak(dump, refreshToken)).toBeUndefined();
    const [row] = await withTestSql(
      (sql) => sql<{ subject: string }[]>`
        select subject from secrets where handle = ${stored.secretHandle}`
    );
    expect(required(row).subject).toBe("oauth:shared");
  });
});

describe("an assembled instance", () => {
  const KEY_VARIABLE = "CATALYST_SECRET_STORE_KEY";
  const instanceId = asClientInstanceId("demo-local");
  const start = (key: string) =>
    createTestInstance({
      config: parseClientInstanceConfig({
        ...createTestConfig(),
        modules: { connections: { enabled: true } },
        secretStore: { keys: [{ id: "k1", ref: KEY_VARIABLE }] },
        egress: { allow: [{ protocol: "https", host: HOST, port: 443 }] }
      }),
      env: { [KEY_VARIABLE]: key },
      tools: [],
      connectorTypes: [fixtureConnectorType],
      seedAssets: false
    });
  const makeSweepDue = () =>
    withTestSql(
      (sql) => sql`
        update platform_jobs set run_after = now()
        where kind = 'connection_setup_sessions.sweep' and status = 'queued'`
    );

  it("sweeps the expired setup sessions on its schedule", async () => {
    const instance = await start(generateSecretStoreKey());
    await applyAtCurrentRevisions(instance.stores.configAssets, {
      clientInstanceId: instanceId,
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "signed",
          config: connection("signed", { origin: "runtime", secretHandle: undefined })
        }
      ]
    });
    const assetId = required(
      await instance.stores.configAssets.getConfigAsset({
        clientInstanceId: instanceId,
        kind: "connection",
        name: "signed"
      })
    ).id;
    const session = (ttlMs: number) =>
      instance.stores.connections.createConnectionSetupSession({
        id: `setup_${randomUUID()}`,
        clientInstanceId: instanceId,
        connectionAssetId: assetId,
        connectionRevision: 1,
        subject: SHARED_CREDENTIAL_SUBJECT,
        actorUserId: "user-1",
        authSessionId: "session-1",
        stateHash: randomBytes(32).toString("base64url"),
        verifier: { keyId: "k1", nonce: randomBytes(12), ciphertext: randomBytes(48) },
        redirectUri: "https://instance.example.test/api/connections/oauth/callback",
        issuer: "https://auth.example.test",
        resource: "https://outside.example.test/mcp",
        clientId: "client-1",
        scopes: [],
        ttlMs
      });
    const live = await session(15 * 60_000);
    await session(0);
    await instance.call("health.get");
    const jobs = getTestJobs(instance);
    await jobs.runDue();
    await makeSweepDue();
    await jobs.runDue();
    const left = await withTestSql(
      (sql) => sql<{ id: string }[]>`select id from connection_setup_sessions`
    );
    expect(left.map((row) => row.id)).toEqual([live.id]);
    const [next] = await withTestSql(
      (sql) => sql<{ due: boolean }[]>`
        select run_after > now() + interval '50 minutes' as due from platform_jobs
        where kind = 'connection_setup_sessions.sweep' and status = 'queued'`
    );
    // The next tick waits an hour.
    expect(required(next).due).toBe(true);
  });

  it("starts with an oauth Connection, its binding and its token set present, and logs no token", async () => {
    // The previous release meets these rows on the new schema: its types list no `oauth`, as
    // the fixture type does not. The start, its seed and its due jobs pass them by.
    const key = generateSecretStoreKey();
    const first = await start(key);
    await applyAtCurrentRevisions(first.stores.configAssets, {
      clientInstanceId: instanceId,
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "signed",
          config: connection("signed", {
            origin: "runtime",
            authScheme: "oauth",
            secretHandle: undefined
          })
        }
      ]
    });
    const assetId = required(
      await first.stores.configAssets.getConfigAsset({
        clientInstanceId: instanceId,
        kind: "connection",
        name: "signed"
      })
    ).id;
    const accessToken = generateTestSecret();
    const written = await createSecretStore({
      clientInstanceId: instanceId,
      keyring: await keyringWith(key),
      store: first.stores.connections
    }).put({
      binding: {
        connectionAssetId: assetId,
        subject: signInSecretSubject(SHARED_CREDENTIAL_SUBJECT)
      },
      value: JSON.stringify({ accessToken }),
      source: "runtime",
      origin: ORIGIN
    });
    await first.stores.connections.connectConnectionBinding({
      clientInstanceId: instanceId,
      connectionAssetId: assetId,
      subject: SHARED_CREDENTIAL_SUBJECT,
      scheme: "oauth",
      grantedScopes: [],
      secretHandle: written.handle,
      secretVersion: written.version,
      origin: ORIGIN,
      expectedRowVersion: null
    });
    await first.close();

    const output = captureProcessOutput();
    try {
      const instance = await start(key);
      expect((await instance.call("health.get")).statusCode).toBe(200);
      await getTestJobs(instance).runDue();
      await makeSweepDue();
      await getTestJobs(instance).runDue();
      await instance.close();
    } finally {
      expect(findLeak(output.stop(), accessToken)).toBeUndefined();
    }
    expect(
      await withTestSql((sql) => sql<{ state: string }[]>`select state from connection_bindings`)
    ).toEqual([{ state: "connected" }]);
  });
});
