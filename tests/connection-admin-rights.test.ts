import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SHARED_CREDENTIAL_SUBJECT,
  createAuthorizer,
  type ActorAccess,
  type UserRecord
} from "@work-shape/catalyst-core";
import { clientInstanceId, type AccessInstance } from "./support/access-instance";
import { URL_OF_HOST, URL_OF_SECOND_HOST, fixture } from "./support/connection-operations";
import { connection } from "./support/connections";

// RIGHTS-1d: writing, deleting and approving a Connection are grantable on one Connection or on
// all of them, and every check asks the right on the Connection it touches. A right on one
// Connection opens that one and no other, and makes none; a change of the host a Connection
// calls clears its stored key, so a writer of one Connection cannot have its key sent to
// another system (D11). Each test fails while the three rights stay with the role.

const ADMIN_RIGHTS = ["connection.write", "connection.delete", "connection.approve"] as const;

function accessOf(t: AccessInstance, user: UserRecord): Promise<ActorAccess> {
  return createAuthorizer(t.stores.access).forActor({
    id: user.id,
    externalUserId: user.id,
    displayLabel: user.displayLabel,
    roles: user.roles,
    permissions: user.permissions,
    permissionRefs: user.permissionRefs,
    clientInstanceId,
    authSource: "test",
    scopes: ["*"]
  });
}

/** A grant on the whole instance, written by the administrator. */
async function grantOnInstance(t: AccessInstance, holderId: string, action: string) {
  await t.expectOk(t.admin.id, "permissions.grant", {
    payload: { holderKind: "user", holderId, action, effect: "allow", scopeKind: "instance" }
  });
}

/** Two Connections made on the instance, each with its key, and the operations on them. */
async function twoConnections() {
  const t = await fixture();
  const alpha = await t.seed("alpha", { origin: "runtime" });
  const beta = await t.seed("beta", { origin: "runtime" });
  const name = (connectionName: string) => ({ params: { name: connectionName } });
  const asset = (connectionName: string) => ({
    params: { kind: "connection", name: connectionName }
  });
  /** A write of the Connection: switched off, at the address it has, or another one. */
  const changed = (connectionName: string, url = URL_OF_HOST) => ({
    ...asset(connectionName),
    payload: {
      config: connection(connectionName, {
        connectorType: "test",
        settings: { url },
        origin: "runtime",
        enabled: false
      })
    }
  });
  const created = (connectionName: string) => ({
    ...asset(connectionName),
    payload: {
      config: connection(connectionName, {
        connectorType: "test",
        settings: { url: URL_OF_HOST },
        origin: "runtime",
        secretHandle: undefined,
        operations: []
      }),
      expectedRevision: null
    }
  });
  const revisionOf = async (connectionName: string) =>
    z
      .object({ revision: z.number() })
      .parse((await t.expectOk(t.admin.id, "assets.get", asset(connectionName))).json()).revision;
  const secretInput = async (connectionName: string) => ({
    ...name(connectionName),
    payload: {
      value: "entered-again",
      expectedVersion: 1,
      expectedRevision: await revisionOf(connectionName)
    }
  });
  const secretOf = (connectionAssetId: string) =>
    t.stores.connections.findSecret({
      clientInstanceId,
      binding: { connectionAssetId, subject: SHARED_CREDENTIAL_SUBJECT }
    });
  return { ...t, alpha, beta, name, asset, changed, created, secretInput, secretOf };
}

type Two = Awaited<ReturnType<typeof twoConnections>>;

/**
 * Every management call `connection.write` decides, on the named Connection, in order: each
 * input is read when its call is made, so the key is entered over the revision the change wrote.
 */
function writeCalls(t: Two, connectionName: string) {
  return [
    ["assets.put", () => t.changed(connectionName)],
    ["connections.set_secret", () => t.secretInput(connectionName)],
    ["connections.test", () => t.name(connectionName)],
    ["connections.discover", () => t.name(connectionName)]
  ] as const;
}

describe("a grant of writing, deleting or approving a Connection", () => {
  it("is written on one Connection or on the instance, and never on a workspace", async () => {
    const t = await twoConnections();
    const team = await t.sharedWorkspace("Team");
    for (const action of ADMIN_RIGHTS) {
      await t.grant(t.kai.id, action, { assetId: t.alpha });
      await grantOnInstance(t, t.lena.id, action);
      const error = await t.expectRefused(
        t.admin.id,
        "permissions.grant",
        {
          payload: {
            holderKind: "user",
            holderId: t.kai.id,
            action,
            scopeKind: "workspace",
            scopeId: team
          }
        },
        { status: 422, code: "VALIDATION_FAILED" }
      );
      expect(error.details, action).toMatchObject({ reason: "invalid_scope" });
    }
    const rows = await t.stores.access.listGrants({ clientInstanceId });
    expect(
      rows
        .filter((row) => row.action.startsWith("connection."))
        .map((row) => [row.holderId, row.action, row.scopeKind, row.scopeId ?? null])
        .sort()
    ).toEqual(
      [
        ...ADMIN_RIGHTS.map((action) => [t.kai.id, action, "asset", t.alpha]),
        ...ADMIN_RIGHTS.map((action) => [t.lena.id, action, "instance", null])
      ].sort()
    );
  });

  it("on Connection A opens A and is refused on B, with the right named", async () => {
    const t = await twoConnections();
    for (const action of ADMIN_RIGHTS) await t.grant(t.kai.id, action, { assetId: t.alpha });
    const kai = await accessOf(t, t.kai);
    const on = (connectionName: string, assetId: string) => ({
      kind: "connection",
      name: connectionName,
      assetId
    });
    for (const action of ADMIN_RIGHTS) {
      expect(kai.authorize(action, on("alpha", t.alpha)), action).toEqual({
        allowed: true,
        source: "grant"
      });
      expect(kai.authorize(action, on("beta", t.beta)), action).toEqual({
        allowed: false,
        reason: "no_grant"
      });
      // Asked as the right on every Connection, as making one asks it, it is refused.
      expect(kai.authorize(action), action).toEqual({ allowed: false, reason: "no_grant" });
    }

    for (const [operation, input] of writeCalls(t, "alpha")) {
      await t.expectOk(t.kai.id, operation, await input());
    }
    for (const [operation, input] of writeCalls(t, "beta")) {
      await t.expectRefused(
        t.kai.id,
        operation,
        await input(),
        t.forbidden("connection.write", "no_grant")
      );
    }
    // A right on one Connection makes none.
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      t.created("gamma"),
      t.forbidden("connection.write", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "assets.delete",
      t.asset("beta"),
      t.forbidden("connection.delete", "no_grant")
    );
    await t.expectOk(t.kai.id, "assets.delete", t.asset("alpha"));
    expect(await t.secretOf(t.alpha)).toBeUndefined();
    expect(await t.secretOf(t.beta)).toBeDefined();
  });

  it("on the instance opens every Connection and makes new ones", async () => {
    const t = await twoConnections();
    for (const action of ADMIN_RIGHTS) await grantOnInstance(t, t.kai.id, action);
    const kai = await accessOf(t, t.kai);
    for (const action of ADMIN_RIGHTS) {
      expect(kai.authorize(action), action).toEqual({ allowed: true, source: "grant" });
    }
    for (const connectionName of ["alpha", "beta"]) {
      for (const [operation, input] of writeCalls(t, connectionName)) {
        await t.expectOk(t.kai.id, operation, await input());
      }
    }
    await t.expectOk(t.kai.id, "assets.put", t.created("gamma"));
    await t.expectOk(t.kai.id, "assets.delete", t.asset("beta"));
  });

  it("is refused without a grant, and a deny on one Connection takes it from an instance grant", async () => {
    const t = await twoConnections();
    for (const [operation, input] of writeCalls(t, "alpha")) {
      await t.expectRefused(
        t.lena.id,
        operation,
        await input(),
        t.forbidden("connection.write", "no_grant")
      );
    }
    await t.expectRefused(
      t.lena.id,
      "assets.delete",
      t.asset("alpha"),
      t.forbidden("connection.delete", "no_grant")
    );
    await t.expectRefused(
      t.lena.id,
      "connections.connector_types",
      {},
      t.forbidden("connection.write", "no_grant")
    );

    await grantOnInstance(t, t.kai.id, "connection.write");
    await t.grant(t.kai.id, "connection.write", { assetId: t.beta }, "deny");
    await t.expectOk(t.kai.id, "assets.put", t.changed("alpha"));
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      t.changed("beta"),
      t.forbidden("connection.write", "denied")
    );
  });

  it("is given only by a holder of the right where it is given", async () => {
    const t = await twoConnections();
    // A manager of people who holds writing on Connection A alone.
    const manager = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Manager",
      roles: ["user"],
      permissions: ["users.manage"]
    });
    await t.grant(manager.id, "connection.write", { assetId: t.alpha });
    const give = (scope: Record<string, unknown>) => ({
      payload: {
        holderKind: "user",
        holderId: t.lena.id,
        action: "connection.write",
        effect: "allow",
        ...scope
      }
    });
    await t.expectOk(
      manager.id,
      "permissions.grant",
      give({ scopeKind: "asset", scopeId: t.alpha })
    );
    for (const scope of [{ scopeKind: "asset", scopeId: t.beta }, { scopeKind: "instance" }]) {
      const refused = await t.expectRefused(manager.id, "permissions.grant", give(scope), {
        status: 403,
        code: "FORBIDDEN"
      });
      expect(refused.details, JSON.stringify(scope)).toMatchObject({
        action: "connection.write",
        reason: "no_grant"
      });
    }
    // A deny is written only by a holder of what it refuses, as an allow is.
    await t.expectRefused(
      manager.id,
      "permissions.grant",
      {
        payload: {
          holderKind: "user",
          holderId: t.lena.id,
          action: "connection.delete",
          effect: "deny",
          scopeKind: "asset",
          scopeId: t.alpha
        }
      },
      { status: 403, code: "FORBIDDEN" }
    );
    const lenaRows = await t.stores.access.listGrants({ clientInstanceId, holderId: t.lena.id });
    expect(lenaRows.map((row) => [row.action, row.scopeKind, row.scopeId])).toEqual([
      ["connection.write", "asset", t.alpha]
    ]);
  });
});

describe("a writer of one Connection", () => {
  it("clears its key by moving it to another host, and keeps it by any other change (D11)", async () => {
    const t = await twoConnections();
    await t.grant(t.kai.id, "connection.write", { assetId: t.alpha });
    await t.grant(t.kai.id, "connection.read", { assetId: t.alpha });

    // A change that keeps the host keeps the key.
    await t.expectOk(t.kai.id, "assets.put", t.changed("alpha"));
    expect(await t.secretOf(t.alpha)).toMatchObject({ version: 1 });

    await t.expectOk(t.kai.id, "assets.put", t.changed("alpha", URL_OF_SECOND_HOST));
    expect(await t.secretOf(t.alpha)).toBeUndefined();
    const detail = await t.expectOk(t.kai.id, "connections.get", t.name("alpha"));
    expect(detail.json()).toMatchObject({ secret: { state: "not_set" } });
    // The other Connection and its key are untouched.
    expect(await t.secretOf(t.beta)).toMatchObject({ version: 1 });
  });

  it("accepts tools and sets who may call them on that Connection only", async () => {
    const t = await twoConnections();
    await t.grant(t.kai.id, "connection.write", { assetId: t.alpha });
    const approved = (connectionName: string) => ({
      ...t.asset(connectionName),
      payload: {
        config: connection(connectionName, {
          connectorType: "test",
          settings: { url: URL_OF_HOST },
          origin: "runtime",
          operations: [
            {
              name: "echo",
              effect: "reading",
              exposure: ["agent", "bridge", "workflow", "outside"],
              enabled: true
            }
          ]
        })
      }
    });
    await t.expectOk(t.kai.id, "assets.put", approved("alpha"));
    const stored = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name: "alpha"
    });
    expect(stored?.config).toMatchObject({
      operations: [{ name: "echo", exposure: ["agent", "bridge", "workflow", "outside"] }]
    });
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      approved("beta"),
      t.forbidden("connection.write", "no_grant")
    );
  });

  it("reads the Connector types for the form of that Connection's page", async () => {
    const t = await twoConnections();
    await t.grant(t.kai.id, "connection.write", { assetId: t.alpha });
    const types = await t.expectOk(t.kai.id, "connections.connector_types");
    expect(types.json<{ types: { type: string }[] }>().types.map((type) => type.type)).toEqual([
      "discovering"
    ]);
    // A right to read or use one Connection is no reason to read them.
    await t.grant(t.lena.id, "connection.read", { assetId: t.alpha });
    await t.grant(t.lena.id, "connection.use", { assetId: t.alpha });
    await t.expectRefused(
      t.lena.id,
      "connections.connector_types",
      {},
      t.forbidden("connection.write", "no_grant")
    );
  });
});
