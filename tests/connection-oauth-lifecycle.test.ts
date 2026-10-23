import { waitUntil } from "./support/assertions";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CONNECTION_ACTIONS,
  NoopAuditRecorder,
  SHARED_CREDENTIAL_SUBJECT,
  asClientInstanceId,
  asUserId,
  createActorAccess,
  createPlatformId,
  isAuthenticatedServicePrincipal,
  type PermissionGrant,
  type OperationRunId
} from "@work-shape/catalyst-core";
import { ApprovalRequestWorkflow } from "@work-shape/catalyst-server";
import {
  CONNECTION_RECONNECT_NOTICE_KIND,
  createConnectionReconnectNoticeHandler,
  createConnectionCredentialResolver,
  createSdkOAuthPort,
  createSignInTokens,
  loadSecretKeyring
} from "@work-shape/catalyst-connections";
import { getTestExecution, getTestJobs } from "./support/test-instance";
import { createOAuthWorld, landingOf, type OAuthWorld } from "./support/oauth-sign-in-world";
import { withTestSql } from "./support/test-sql";

// CS-4b3, checks 54 to 56 of connections-and-secrets.md: what happens to a shared OAuth
// sign-in after it was made. A refresh under the binding's lease, one retry of a reading call
// after a 401, `insufficient_scope`, a refused refresh, Disconnect with RFC 7009 revocation,
// the end of a sign-in on delete, move and scheme change, a call waiting for a lease, a held
// call after a reconnect, and the keep-alive. Against the demo's sample authorization server.

const clientInstanceId = asClientInstanceId("demo-local");
const startAnswerSchema = z.object({ authorizationUrl: z.string().url() });
const disconnectSchema = z.object({ state: z.string(), providerRevocation: z.string() });
const countSchema = z.object({ count: z.number(), decided: z.number() });
const reasonSchema = z.object({ error: z.object({ details: z.object({ reason: z.string() }) }) });

let world: OAuthWorld;

beforeAll(async () => {
  world = await createOAuthWorld();
}, 60_000);

afterAll(async () => {
  await world?.close();
});

afterEach(() => {
  const { controls } = world.oauth;
  controls.accessTtlSeconds = 3600;
  controls.refuseRefresh = false;
  controls.requiredScope = undefined;
  world.provider.adjustMetadata = undefined;
  world.provider.beforeRevoke = undefined;
});

async function signInFully(name: string, cookie: string): Promise<void> {
  const started = await world.start(name, cookie);
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const back = await world.authorize(startAnswerSchema.parse(started.body).authorizationUrl);
  const landed = await world.callback(back, { cookie });
  expect(landingOf(landed.location)).toEqual({ signIn: "connected", connection: name });
  // The tools are read after a sign-in, and a call takes only a discovered tool.
  await world.discover(name, cookie);
}

/** A Connection made on the instance that signs in at the sample, with one tool. */
function runtimeConnection(url: string, authScheme = "oauth"): Record<string, unknown> {
  return {
    connectorType: "mcp",
    displayName: "Runtime sample",
    origin: "runtime",
    settings: { url },
    authScheme,
    operations: [
      { name: "list_customers", effect: "reading", exposure: ["agent", "outside"], enabled: true }
    ],
    enabled: true
  };
}

interface SignInRow {
  state: string;
  reason: string | null;
  tokens: number;
  version: number | null;
}

/** The binding of a Connection, its token sets and the version of the one it names. */
async function signInOf(name: string): Promise<SignInRow | undefined> {
  const [row] = await withTestSql(
    (sql) => sql<SignInRow[]>`
      select b.state, b.state_reason as reason, b.secret_version as version,
        (select count(*)::int from secrets s
          where s.connection_asset_id = a.id and s.subject = 'oauth:shared') as tokens
      from config_assets a join connection_bindings b
        on b.connection_asset_id = a.id and b.subject = 'shared'
      where a.kind = 'connection' and a.name = ${name}
      limit 1`
  );
  return row;
}

async function eventsOf(type: string, connection: string) {
  return withTestSql(
    (sql) => sql<{ reason: string | null; metadata: Record<string, unknown> }[]>`
      select reason, metadata from audit_events
      where type = ${type} and subject = ${connection} order by created_at`
  );
}

function failureOf(outcome: { result: unknown }): string {
  return JSON.stringify(outcome.result);
}

describe("a shared OAuth sign-in over its life", () => {
  it("refreshes a token about to expire once for 20 calls at the same time, with one new secret version", async () => {
    const alice = await world.signIn("alice");
    // The sign-in's access token expires within the minute a refresh looks ahead.
    world.oauth.controls.accessTtlSeconds = 30;
    await signInFully("dcr", alice);
    world.oauth.controls.accessTtlSeconds = 3600;
    const before = world.oauth.counts();
    const signedIn = await signInOf("dcr");
    expect(signedIn).toMatchObject({ state: "connected", tokens: 1 });
    const version = signedIn?.version ?? 0;

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => world.call("dcr", "list_customers", alice))
    );
    for (const outcome of outcomes) expect(outcome.result).toMatchObject({ status: "done" });
    expect(world.oauth.counts().refreshToken - before.refreshToken).toBe(1);
    expect(await signInOf("dcr")).toMatchObject({
      state: "connected",
      version: version + 1,
      tokens: 1
    });
  });

  it("answers the new sign-in's token, never the discarded refresh's, when a reconnect wins the race", async () => {
    const alice = await world.signIn("alice");
    world.oauth.controls.accessTtlSeconds = 30;
    await signInFully("dcr", alice);
    world.oauth.controls.accessTtlSeconds = 3600;
    const assembly = getTestExecution(world.worker);
    if (!assembly.connections) throw new Error("No Connections");
    const keyring = await loadSecretKeyring({
      keys: assembly.config.secretStore.keys,
      secrets: assembly.infrastructure.secrets
    });
    const credentials = createConnectionCredentialResolver({
      clientInstanceId,
      keyring,
      store: assembly.store.connections
    });
    const sdk = createSdkOAuthPort();
    let resume = () => {};
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let arrived = () => {};
    const received = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    // The provider has answered the refresh; its answer reaches the instance only later.
    const tokens = createSignInTokens({
      clientInstanceId,
      stores: assembly.store,
      connectorTypes: assembly.connections.connectorTypes,
      egress: assembly.connections.egress,
      keyring,
      credentials,
      logger: assembly.logger,
      oauth: {
        ...sdk,
        async refresh(input) {
          const answer = await sdk.refresh(input);
          arrived();
          await paused;
          return answer;
        }
      }
    });
    const asset = await world.instance.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name: "dcr"
    });
    if (!asset) throw new Error("No Connection");
    const input = { connectionAssetId: asset.id, origin: world.sample };
    const pending = tokens.accessToken(input);
    await received;
    let current: string | undefined;
    try {
      // Meanwhile someone signs the Connection in again.
      await signInFully("dcr", alice);
      current = await credentials.resolveSignIn?.(input);
    } finally {
      resume();
    }
    const returned = await pending;
    expect(current).toBeDefined();
    expect(returned === current).toBe(true);
  });

  it("makes a reading call once more after a 401, with one refresh", async () => {
    const alice = await world.signIn("alice");
    await signInFully("dcr", alice);
    const before = world.oauth.counts();
    // The provider ended the access token although it was believed valid.
    world.oauth.expireAccessTokens();
    const outcome = await world.call("dcr", "list_customers", alice);
    expect(outcome.result).toMatchObject({ status: "done" });
    expect(world.oauth.counts().refreshToken - before.refreshToken).toBe(1);
  });

  it("never makes a changing call again after a 401, and refreshes for the next call", async () => {
    const alice = await world.signIn("alice");
    const changing = {
      ...runtimeConnection(`${world.sample}/dcr/mcp`),
      operations: [
        { name: "list_customers", effect: "changing", exposure: ["outside"], enabled: true }
      ]
    };
    expect(await world.putConnection("changer", changing, alice)).toBe(200);
    await signInFully("changer", alice);
    const calls = await world.calls();
    const definition = await calls.deps.registry.resolve("connection.changer.list_customers");
    if (!definition) throw new Error("No operation");
    const actor = await world.identityOf(alice);
    const execute = async () =>
      definition.execute(
        {},
        {
          // A run of its own that waited for no decision.
          runId: createPlatformId<"OperationRunId">("oprun"),
          actor,
          origin: { kind: "cli" },
          correlationId: "corr_changing",
          runtime: {},
          access: await calls.deps.authorizer.forActor(actor),
          audit: calls.deps.audit
        }
      );
    const before = world.oauth.counts();
    world.oauth.expireAccessTokens();
    // The system may have carried the call out before it answered 401: it is not made again.
    await expect(execute()).rejects.toMatchObject({
      details: { reason: "upstream_unauthorized" }
    });
    expect(world.oauth.counts().refreshToken - before.refreshToken).toBe(1);
    await expect(execute()).resolves.toBeDefined();
    expect(world.oauth.counts().refreshToken - before.refreshToken).toBe(1);
  });

  it("answers insufficient_scope as needs reconnect with the scopes it lacks, and keeps the sign-in", async () => {
    const alice = await world.signIn("alice");
    await signInFully("dcr", alice);
    world.oauth.controls.requiredScope = "sample.write";
    const outcome = await world.call("dcr", "list_customers", alice);
    expect(failureOf(outcome)).toContain("connection_needs_reconnect");
    expect(await signInOf("dcr")).toMatchObject({ state: "connected" });
    const [recorded] = (await eventsOf("connection.binding_needs_reconnect", "dcr")).slice(-1);
    expect(recorded).toMatchObject({
      reason: "insufficient_scope",
      metadata: { connectionName: "dcr", subjectKind: "shared", missingScopes: ["sample.write"] }
    });
  });

  it("sets needs_reconnect on a refused refresh, deletes the token set and files one Inbox notice", async () => {
    const alice = await world.signIn("alice");
    world.oauth.controls.accessTtlSeconds = 30;
    await signInFully("registered", alice);
    world.oauth.controls.refuseRefresh = true;

    const first = await world.call("registered", "list_customers", alice);
    expect(failureOf(first)).toContain("connection_needs_reconnect");
    expect(await signInOf("registered")).toMatchObject({
      state: "needs_reconnect",
      reason: "invalid_grant",
      tokens: 0
    });
    // The Connection's own secret, the client's, stays and is never sent in the token's place.
    const own = await withTestSql(
      (sql) => sql<{ count: number }[]>`
        select count(*)::int as count from secrets s join config_assets a
          on a.id = s.connection_asset_id
        where a.name = 'registered' and s.subject = ${SHARED_CREDENTIAL_SUBJECT}`
    );
    expect(own).toEqual([{ count: 1 }]);
    const refreshes = world.oauth.counts().refreshToken;
    const second = await world.call("registered", "list_customers", alice);
    expect(failureOf(second)).toContain("connection_needs_reconnect");
    expect(world.oauth.counts().refreshToken).toBe(refreshes);

    expect(await eventsOf("connection.binding_needs_reconnect", "registered")).toEqual([
      {
        reason: "invalid_grant",
        metadata: expect.objectContaining({ connectionName: "registered", subjectKind: "shared" })
      }
    ]);
    const notices = await withTestSql(
      (sql) => sql<{ status: string; payload: Record<string, unknown> }[]>`
        select status, payload from approval_requests where kind = 'connection_reconnect'`
    );
    expect(notices).toEqual([
      {
        status: "pending",
        payload: {
          subject: { connectionAssetId: expect.any(String), connectionName: "registered" },
          reason: "invalid_grant"
        }
      }
    ]);
  });

  it("disconnects: the token set is gone before the provider is asked, and the answer says what it said", async () => {
    const alice = await world.signIn("alice");
    await signInFully("dcr", alice);
    let tokensAtRevocation: number | undefined;
    world.provider.beforeRevoke = async () => {
      tokensAtRevocation = (await signInOf("dcr"))?.tokens;
    };
    const before = world.oauth.counts();
    const answer = await world.disconnect("dcr", alice);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(disconnectSchema.parse(answer.body)).toEqual({
      state: "revoked",
      providerRevocation: "confirmed"
    });
    expect(world.oauth.counts().revocation - before.revocation).toBe(1);
    expect(tokensAtRevocation).toBe(0);
    expect(await signInOf("dcr")).toMatchObject({ state: "revoked", reason: "disconnect" });
    const [revoked] = (await eventsOf("connection.binding_revoked", "dcr")).slice(-1);
    expect(revoked).toMatchObject({
      reason: "disconnect",
      metadata: { connectionName: "dcr", subjectKind: "shared", providerRevocation: "confirmed" }
    });

    const again = await world.disconnect("dcr", alice);
    expect(again.status).toBe(409);
    expect(reasonSchema.parse(again.body).error.details.reason).toBe("connection_not_connected");
  });

  it("answers not_offered where the provider lists no revocation endpoint, and asks it nothing", async () => {
    const alice = await world.signIn("alice");
    await signInFully("dcr", alice);
    world.provider.adjustMetadata = (_mode, kind, metadata) => {
      if (kind !== "server") return metadata;
      const { revocation_endpoint: _revocation, ...rest } = metadata;
      return rest;
    };
    const before = world.oauth.counts();
    const answer = await world.disconnect("dcr", alice);
    expect(disconnectSchema.parse(answer.body)).toEqual({
      state: "revoked",
      providerRevocation: "not_offered"
    });
    expect(world.oauth.counts().revocation).toBe(before.revocation);
    expect(await signInOf("dcr")).toMatchObject({ state: "revoked", tokens: 0 });
  });

  it("restores no token by a revert after Disconnect", async () => {
    const alice = await world.signIn("alice");
    const home = `${world.sample}/dcr/mcp`;
    expect(await world.putConnection("reverting", runtimeConnection(home), alice)).toBe(200);
    expect(
      await world.putConnection(
        "reverting",
        { ...runtimeConnection(home), displayName: "Runtime sample, renamed" },
        alice
      )
    ).toBe(200);
    await signInFully("reverting", alice);
    expect(disconnectSchema.parse((await world.disconnect("reverting", alice)).body).state).toBe(
      "revoked"
    );
    expect(await world.revertConnection("reverting", 1, alice)).toBe(200);
    expect(await signInOf("reverting")).toMatchObject({ state: "revoked", tokens: 0 });
    const tested = await world.test("reverting", alice);
    expect(tested.text).toContain("oauth_required");
  });

  it("revokes at the provider when the Connection moves, stops signing in, or is deleted", async () => {
    const alice = await world.signIn("alice");
    const home = `${world.sample}/dcr/mcp`;
    const elsewhere = `http://localhost:${new URL(world.sample).port}/dcr/mcp`;
    const cases: { name: string; change(): Promise<number>; reason: string }[] = [
      {
        name: "moved",
        change: () => world.putConnection("moved", runtimeConnection(elsewhere), alice),
        reason: "origin_changed"
      },
      {
        name: "unsigned",
        change: () => world.putConnection("unsigned", runtimeConnection(home, "none"), alice),
        reason: "scheme_changed"
      },
      {
        name: "deleted",
        change: () => world.deleteConnection("deleted", alice),
        reason: "deleted"
      }
    ];
    for (const { name, change, reason } of cases) {
      expect(await world.putConnection(name, runtimeConnection(home), alice)).toBe(200);
      await signInFully(name, alice);
      let tokensAtRevocation: number | undefined;
      world.provider.beforeRevoke = async () => {
        tokensAtRevocation = (await signInOf(name))?.tokens;
      };
      const before = world.oauth.counts();
      expect(await change(), name).toBe(200);
      expect(world.oauth.counts().revocation - before.revocation, name).toBe(1);
      expect(tokensAtRevocation, name).toBe(0);
      expect(await signInOf(name), name).toMatchObject({ state: "revoked", reason, tokens: 0 });
      expect(await eventsOf("connection.binding_revoked", name), name).toEqual([
        {
          reason,
          metadata: expect.objectContaining({
            connectionName: name,
            providerRevocation: "confirmed"
          })
        }
      ]);
    }
  });

  it("stops a call that waits for another process's refresh once the Connection is deleted", async () => {
    const alice = await world.signIn("alice");
    const home = `${world.sample}/dcr/mcp`;
    expect(await world.putConnection("waiting", runtimeConnection(home), alice)).toBe(200);
    world.oauth.controls.accessTtlSeconds = 30;
    await signInFully("waiting", alice);
    const asset = await world.instance.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name: "waiting"
    });
    if (!asset) throw new Error("No Connection");
    // Another process holds the lease and refreshes for longer than the call may wait.
    const leased = await world.instance.stores.connections.takeConnectionBindingLease({
      clientInstanceId,
      connectionAssetId: asset.id,
      subject: SHARED_CREDENTIAL_SUBJECT,
      owner: "refresh_other_process",
      leaseMs: 60_000
    });
    expect(leased).toBeDefined();
    const started = Date.now();
    const bindings = world.worker.stores.connections;
    const takeLease = bindings.takeConnectionBindingLease.bind(bindings);
    let waitingForLease = false;
    const observed = vi
      .spyOn(bindings, "takeConnectionBindingLease")
      .mockImplementation(async (input) => {
        const result = await takeLease(input);
        if (input.connectionAssetId === asset.id && result === undefined) waitingForLease = true;
        return result;
      });
    try {
      const call = world.call("waiting", "list_customers", alice);
      await waitUntil(() => waitingForLease, "the call waits for the other process's lease");
      expect(await world.deleteConnection("waiting", alice)).toBe(200);
      const outcome = await call;
      expect(failureOf(outcome)).toContain("connection_unavailable");
      // Well before the wait for the lease ran out, which answers connection_busy.
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      observed.mockRestore();
    }
  });

  it("fails a held call as stale where the Connection was signed in again after it was made", async () => {
    const alice = await world.signIn("alice");
    await signInFully("dcr", alice);
    const made = await world.call("dcr", "list_customers", alice);
    expect(made.result).toMatchObject({ status: "done" });
    // The run as one that waited for an approval: decided by another person after it was made.
    await withTestSql(
      (sql) => sql`
        update operation_runs set decision = ${sql.json({
          mode: "approved",
          by: "user-bob",
          at: new Date().toISOString()
        })} where id = ${made.run.id}`
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await signInFully("dcr", alice);

    const calls = await world.calls();
    const definition = await calls.deps.registry.resolve("connection.dcr.list_customers");
    if (!definition) throw new Error("No operation");
    const runId: OperationRunId = made.run.id;
    const actor = await world.identityOf(alice);
    // The execution of the approved call, as the job that runs it makes it.
    await expect(
      definition.execute(
        {},
        {
          runId,
          actor,
          origin: { kind: "cli" },
          correlationId: "corr_held",
          runtime: {},
          access: await calls.deps.authorizer.forActor(actor),
          audit: calls.deps.audit
        }
      )
    ).rejects.toMatchObject({ details: { reason: "approval_stale" } });
  });

  it("keeps idle shared sign-ins alive on its schedule, and never a personal one", async () => {
    const alice = await world.signIn("alice");
    await signInFully("dcr", alice);
    const asset = await world.instance.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name: "dcr"
    });
    if (!asset) throw new Error("No Connection");
    const shared = await world.instance.stores.connections.getConnectionBinding({
      clientInstanceId,
      connectionAssetId: asset.id,
      subject: SHARED_CREDENTIAL_SUBJECT
    });
    if (!shared) throw new Error("No binding");
    // A person's own sign-in of the same Connection, idle as long.
    await world.instance.stores.connections.connectConnectionBinding({
      clientInstanceId,
      connectionAssetId: asset.id,
      subject: "user:alice",
      scheme: "oauth",
      accountLabel: "Alice",
      grantedScopes: [],
      secretHandle: shared.secretHandle,
      secretVersion: shared.secretVersion,
      connectedBy: "alice",
      origin: shared.origin,
      expectedRowVersion: null
    });
    await withTestSql(
      (sql) => sql`
        update connection_bindings set connected_at = now() - interval '8 days',
          last_refreshed_at = null, last_used_on = null
        where state = 'connected'`
    );
    const before = world.oauth.counts();
    const jobs = getTestJobs(world.instance);
    await jobs.runDue();
    await withTestSql(
      (sql) => sql`
        update platform_jobs set run_after = now()
        where kind = 'connection_bindings.keep_alive' and status = 'queued'`
    );
    await jobs.runDue();

    const refreshed = await withTestSql(
      (sql) => sql<{ name: string; subject: string; refreshed: boolean }[]>`
        select a.name, b.subject, b.last_refreshed_at is not null as refreshed
        from connection_bindings b join config_assets a on a.id = b.connection_asset_id
        where b.state = 'connected' order by a.name, b.subject`
    );
    expect(refreshed.filter((row) => row.subject !== "shared")).toEqual([
      { name: "dcr", subject: "user:alice", refreshed: false }
    ]);
    const sharedRows = refreshed.filter((row) => row.subject === "shared");
    expect(sharedRows.length).toBeGreaterThan(0);
    expect(sharedRows.every((row) => row.refreshed)).toBe(true);
    expect(world.oauth.counts().refreshToken - before.refreshToken).toBe(sharedRows.length);
  });
  it("shows the reconnect notice to whoever may write that Connection, though not on the instance", async () => {
    const stores = world.instance.stores;
    const assetOf = async (name: string) => {
      const asset = await stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name
      });
      if (!asset) throw new Error("No Connection");
      return asset;
    };
    const [dcr, registered] = [await assetOf("dcr"), await assetOf("registered")];
    const file = (connectionAssetId: string, connectionName: string) =>
      stores.approvals.createApprovalRequest({
        clientInstanceId,
        kind: CONNECTION_RECONNECT_NOTICE_KIND,
        summary: `The Connection '${connectionName}' needs a new sign-in`,
        payload: { subject: { connectionAssetId, connectionName }, reason: "invalid_grant" },
        requestedBy: { id: "system", displayLabel: "System" }
      });
    const own = await file(dcr.id, "dcr");
    const other = await file(registered.id, "registered");
    const handler = createConnectionReconnectNoticeHandler({ clientInstanceId, stores });
    const workflow = new ApprovalRequestWorkflow({
      clientInstanceId,
      store: stores.approvals,
      handlers: new Map([[handler.kind, handler]]),
      auditRecorder: new NoopAuditRecorder()
    });
    const identity = await world.identityOf(await world.signIn("bob"));
    if (isAuthenticatedServicePrincipal(identity)) throw new Error("No person");
    const user = { ...identity, roles: [], permissions: [], permissionRefs: [] };
    const accessWith = (scope: Pick<PermissionGrant, "scopeKind" | "scopeId">) =>
      createActorAccess(
        { kind: "user", id: user.id, clientInstanceId, roles: [], permissionRefs: [] },
        {
          holderActive: true,
          grants: [
            {
              id: "grant_connection_writer",
              clientInstanceId,
              holderKind: "user",
              holderId: user.id,
              action: CONNECTION_ACTIONS.write,
              effect: "allow",
              ...scope,
              grantedBy: asUserId("user-admin"),
              createdAt: new Date().toISOString()
            }
          ]
        }
      );
    const context = { correlationId: "corr_scoped_notice" };
    // A right on this Connection alone, as a delegated operator holds it.
    const access = accessWith({ scopeKind: "asset", scopeId: dcr.id });
    // The writer may sign the Connection in again, so they see what says it needs it.
    expect(
      access.authorize(CONNECTION_ACTIONS.write, {
        kind: "connection",
        name: "dcr",
        assetId: dcr.id
      }).allowed
    ).toBe(true);
    const listed = await workflow.listRequests(user, access, context, { status: "pending" });
    expect(listed.map((request) => request.id)).toContain(own.id);
    expect(listed.every((request) => request.payload.subject !== undefined)).toBe(true);
    expect(listed.map((request) => request.id)).not.toContain(other.id);
    expect((await workflow.getRequest(user, access, context, own.id)).canDecide).toBe(true);
    await expect(workflow.getRequest(user, access, context, other.id)).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    const counted = await workflow.pendingCount(user, access);
    expect(counted.count).toBe(listed.length);
    expect(counted.canReview).toBe(true);
  });
  it("keeps a Connection's notice out of the Inbox list and counts of whoever is denied it there", async () => {
    const stores = world.instance.stores;
    const hidden = await stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name: "registered"
    });
    if (!hidden) throw new Error("No Connection");
    const file = () =>
      stores.approvals.createApprovalRequest({
        clientInstanceId,
        kind: CONNECTION_RECONNECT_NOTICE_KIND,
        summary: "The Connection 'registered' needs a new sign-in",
        payload: {
          subject: { connectionAssetId: hidden.id, connectionName: "registered" },
          reason: "invalid_grant"
        },
        requestedBy: { id: "system", displayLabel: "System" }
      });
    const notice = await file();
    // Bob may write every Connection on the instance, and is denied this one.
    const bob = await world.signIn("bob");
    const actor = await world.identityOf(bob);
    for (const action of [CONNECTION_ACTIONS.write, CONNECTION_ACTIONS.read]) {
      await stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: actor.id,
        action,
        effect: "deny",
        scopeKind: "asset",
        scopeId: hidden.id,
        grantedBy: asUserId(actor.id)
      });
    }
    const asBob = { headers: { cookie: bob } };
    const listOf = async (query: { status?: "pending"; scope?: "decided" }) => {
      const response = await world.instance.call("approval_requests.list", { query }, asBob);
      return { status: response.statusCode, text: response.body };
    };
    const counts = async () =>
      countSchema.parse(
        (await world.instance.call("approval_requests.count_pending", {}, asBob)).json()
      );
    const direct = await world.instance.call(
      "approval_requests.get",
      { params: { requestId: notice.id } },
      asBob
    );
    expect(direct.statusCode).toBe(404);
    const listed = await listOf({ status: "pending" });
    expect(listed.status).toBe(200);
    expect(listed.text).not.toContain(notice.id);
    expect(listed.text).not.toContain(hidden.id);
    const before = await counts();
    await file();
    const after = await counts();
    expect(after.count).toBe(before.count);
    // Acknowledged by someone who may see it, it stays out of the denied person's decided list.
    const alice = await world.signIn("alice");
    const decided = await world.instance.call(
      "approval_requests.decide",
      { params: { requestId: notice.id }, payload: { decision: "approve" } },
      { headers: { cookie: alice, origin: "http://localhost:5173" } }
    );
    expect(decided.statusCode).toBe(200);
    expect((await listOf({ scope: "decided" })).text).not.toContain(notice.id);
    expect((await counts()).decided).toBe(before.decided);
  });
});
