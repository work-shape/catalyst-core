import { afterEach, describe, expect, it } from "vitest";
import {
  assetRightsCheckSchema,
  holderRightsSchema,
  roleSchema
} from "@work-shape/catalyst-api-contract";
import type { AccessEntry } from "@work-shape/catalyst-core";
import { decideAssetActions, decideHeldRights } from "@work-shape/catalyst-server";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance } from "./support/app-instance";
import { fixtureConnectionKind, seedConnection } from "./support/connections";

// AP-5b2: the User screen and the Check tab show each right with where it comes from, decided
// on the server by the evaluator's own rule, so the interface never decides itself.

const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
});

async function setup(): Promise<AccessInstance> {
  const t = await setupAccessInstance();
  instances.push(t);
  return t;
}

async function rightsOf(t: AccessInstance, readerId: string, holderId: string) {
  return holderRightsSchema.parse(
    (
      await t.expectOk(readerId, "permissions.rights", {
        query: { holderKind: "user", holderId }
      })
    ).json()
  );
}

const entry = (overrides: Partial<AccessEntry> & Pick<AccessEntry, "action">): AccessEntry => ({
  effect: "allow",
  scopeKind: "instance",
  source: "grant",
  ...overrides
});

describe("a custom role's rights on the User screen (acceptance check 5)", () => {
  it("are exactly what the role lists, each with the role as its origin", async () => {
    const t = await setupAppInstance({
      modules: { connections: { enabled: true } },
      furtherKinds: [fixtureConnectionKind()]
    });
    instances.push(t);
    const apps: string[] = [];
    for (const name of ["ledger", "invoices"]) {
      expectStatus(await t.putApp(t.admin.id, name, appFiles(name, { name })), 200);
      const listed = await t.listed(name);
      expectStatus(await t.publish(t.admin.id, name, listed.draftRevision ?? listed.revision), 200);
      apps.push(await t.assetId("app", name));
    }
    const crm = await seedConnection(t, "crm");
    const buchhaltung = roleSchema.parse(
      (
        await t.expectOk(t.admin.id, "roles.create", {
          payload: {
            name: "Buchhaltung",
            grants: [
              { action: "connection.use", scopeKind: "asset", scopeId: crm },
              ...apps.map((scopeId) => ({ action: "app.use", scopeKind: "asset", scopeId }))
            ]
          }
        })
      ).json()
    );
    await t.expectOk(t.admin.id, "users.update", {
      params: { userId: t.lena.id },
      payload: { roles: ["user", buchhaltung.id] }
    });

    const read = await rightsOf(t, t.admin.id, t.lena.id);
    const fromRole = read.rights.filter((right) =>
      right.grantedBy.some((origin) => origin.source === "role")
    );
    expect(
      fromRole.map((right) => [right.action, right.scopeAsset?.name, right.allowed]).sort()
    ).toEqual([
      ["app.use", "invoices", true],
      ["app.use", "ledger", true],
      ["connection.use", "crm", true]
    ]);
    for (const right of fromRole) {
      expect(right.grantedBy).toEqual([
        expect.objectContaining({ source: "role", roleId: buchhaltung.id, effect: "allow" })
      ]);
    }
    expect(read.roles).toEqual([{ id: buchhaltung.id, name: "Buchhaltung", builtIn: false }]);
    // Everything else the person holds comes from somewhere other than a role.
    expect(
      read.rights.filter((right) => !fromRole.includes(right)).flatMap((right) => right.grantedBy)
    ).not.toContainEqual(expect.objectContaining({ source: "role" }));

    // The Check tab answers from the same rule: the use of one App is the role's.
    const check = assetRightsCheckSchema.parse(
      (
        await t.expectOk(t.admin.id, "permissions.check", {
          query: { holderKind: "user", holderId: t.lena.id, kind: "app", assetId: apps[0] }
        })
      ).json()
    );
    expect(check.actions.find((action) => action.verb === "use")).toMatchObject({
      allowed: true,
      decidedBy: { source: "role", roleId: buchhaltung.id }
    });
    expect(check.roles).toEqual([{ id: buchhaltung.id, name: "Buchhaltung", builtIn: false }]);
  });
});

describe("where a refusal comes from", () => {
  it("names the role whose deny takes away a right granted directly", async () => {
    const t = await setup();
    const manager = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Manager",
      roles: ["user"],
      permissions: ["usage.view"]
    });
    const noUsage = roleSchema.parse(
      (
        await t.expectOk(t.root.id, "roles.create", {
          payload: {
            name: "No usage",
            grants: [{ action: "usage.view", effect: "deny", scopeKind: "instance" }]
          }
        })
      ).json()
    );
    await t.expectOk(t.root.id, "users.update", {
      params: { userId: manager.id },
      payload: { roles: ["user", noUsage.id] }
    });

    const read = await rightsOf(t, t.admin.id, manager.id);
    expect(read.rights.filter((right) => right.action === "usage.view")).toEqual([
      expect.objectContaining({
        scopeKind: "instance",
        allowed: false,
        reason: "denied",
        grantedBy: [expect.objectContaining({ source: "grant", effect: "allow" })],
        deniedBy: expect.objectContaining({ source: "role", roleId: noUsage.id, effect: "deny" })
      })
    ]);
    expect(read.roles).toEqual([{ id: noUsage.id, name: "No usage", builtIn: false }]);
  });

  it("names a deny given directly on one asset, and the role that allows everywhere else", async () => {
    const t = await setup();
    await t.putAgent(t.admin.id, "helper");
    const helper = await t.assetId("agent", "helper");
    // `admin` holds the release's default of the role; a deny on one agent is the person's own.
    const person = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Second admin",
      roles: ["user", "admin"]
    });
    await t.grant(person.id, "agent.delete", { assetId: helper }, "deny");

    const read = await rightsOf(t, t.root.id, person.id);
    const deletes = read.rights.filter((right) => right.action === "agent.delete");
    expect(deletes).toEqual([
      expect.objectContaining({
        scopeKind: "instance",
        allowed: true,
        grantedBy: [expect.objectContaining({ source: "role", roleId: "admin" })]
      }),
      expect.objectContaining({
        scopeKind: "asset",
        scopeId: helper,
        scopeAsset: { kind: "agent", name: "helper", active: true },
        allowed: false,
        reason: "denied",
        grantedBy: [],
        deniedBy: expect.objectContaining({ source: "grant", effect: "deny", scopeId: helper })
      })
    ]);
    expect(read.roles).toContainEqual({ id: "admin", name: "admin", builtIn: true });

    const check = assetRightsCheckSchema.parse(
      (
        await t.expectOk(t.root.id, "permissions.check", {
          query: { holderKind: "user", holderId: person.id, kind: "agent", assetId: helper }
        })
      ).json()
    );
    expect(check.actions.map((action) => [action.verb, action.allowed])).toEqual([
      ["read", true],
      ["write", true],
      ["delete", false]
    ]);
    expect(check.actions.find((action) => action.verb === "write")?.decidedBy).toMatchObject({
      source: "role",
      roleId: "admin"
    });
    expect(check.actions.find((action) => action.verb === "delete")).toMatchObject({
      reason: "denied",
      decidedBy: { source: "grant", effect: "deny", scopeKind: "asset", scopeId: helper }
    });
  });
});

describe("who reads the rights of a holder", () => {
  it("is the holder, or who administers people, under the read of effective rights", async () => {
    const t = await setup();
    await t.expectOk(t.kai.id, "permissions.rights", {
      query: { holderKind: "user", holderId: t.kai.id }
    });
    await t.expectOk(t.kai.id, "permissions.check", {
      query: { holderKind: "user", holderId: t.kai.id, kind: "agent" }
    });
    for (const operation of ["permissions.rights", "permissions.check"] as const) {
      const query = (holderKind: string, holderId: string) => ({
        query: {
          holderKind,
          holderId,
          ...(operation === "permissions.check" ? { kind: "agent" } : {})
        }
      });
      await t.expectRefused(
        t.kai.id,
        operation,
        query("user", t.lena.id),
        t.forbidden("users.manage", "no_grant")
      );
      // The user list hides a superadmin from everyone else, and so does this.
      await t.expectRefused(t.admin.id, operation, query("user", t.root.id), {
        status: 404,
        code: "NOT_FOUND",
        details: { reason: "unknown_holder" }
      });
      // A service principal's rights are read by who administers service principals.
      await t.expectRefused(
        t.kai.id,
        operation,
        query("service_principal", "principal"),
        t.forbidden("service_principals.manage", "no_grant")
      );
    }
    await t.expectRefused(
      t.admin.id,
      "permissions.check",
      { query: { holderKind: "user", holderId: t.kai.id, kind: "not_a_kind" } },
      { status: 404, code: "NOT_FOUND", details: { reason: "unknown_kind" } }
    );
  });

  it("leaves out the name of an asset the reader may not read", async () => {
    const t = await setup();
    await t.putAgent(t.admin.id, "secret-helper");
    const helper = await t.assetId("agent", "secret-helper");
    await t.grant(t.kai.id, "agent.write", { assetId: helper });
    const own = await rightsOf(t, t.kai.id, t.kai.id);
    expect(own.rights.find((right) => right.action === "agent.write")?.scopeAsset).toEqual({
      kind: "agent",
      active: true
    });
    const administered = await rightsOf(t, t.admin.id, t.kai.id);
    expect(administered.rights.find((right) => right.action === "agent.write")?.scopeAsset).toEqual(
      { kind: "agent", name: "secret-helper", active: true }
    );
  });
});

describe("deciding entries", () => {
  it("refuses everything for a holder who is not active, and lists the rights all the same", () => {
    const rights = decideHeldRights([entry({ action: "usage.view" })], false, () => undefined);
    expect(rights).toEqual([
      expect.objectContaining({ action: "usage.view", allowed: false, reason: "holder_inactive" })
    ]);
    expect(
      decideAssetActions(
        [entry({ action: "agent.read" })],
        false,
        { read: "agent.read", write: "agent.write", delete: "agent.delete" },
        { kind: "agent", assetId: "a" }
      ).map((action) => action.reason)
    ).toEqual(["holder_inactive", "holder_inactive", "holder_inactive"]);
  });

  it("lets a deny on a workspace reach an asset the workspace owns", () => {
    const entries = [
      entry({ action: "agent.write", scopeKind: "asset", scopeId: "a" }),
      entry({ action: "agent.write", scopeKind: "workspace", scopeId: "w", effect: "deny" })
    ];
    const [right] = decideHeldRights(entries, true, (assetId) =>
      assetId === "a" ? "w" : undefined
    ).filter((candidate) => candidate.scopeKind === "asset");
    expect(right).toMatchObject({
      allowed: false,
      reason: "denied",
      deniedBy: { scopeKind: "workspace", scopeId: "w" }
    });
    expect(
      decideAssetActions(
        entries,
        true,
        { read: "agent.read", write: "agent.write", delete: "agent.delete" },
        { kind: "agent", assetId: "a", workspaceId: "w" }
      ).find((action) => action.verb === "write")
    ).toMatchObject({ allowed: false, reason: "denied" });
  });

  it("refuses a delete where writing is denied, naming the verb", () => {
    const actions = decideAssetActions(
      [
        entry({ action: "agent.delete" }),
        entry({ action: "agent.write" }),
        entry({ action: "agent.write", scopeKind: "asset", scopeId: "a", effect: "deny" })
      ],
      true,
      { read: "agent.read", write: "agent.write", delete: "agent.delete" },
      { kind: "agent", assetId: "a" }
    );
    expect(actions.find((action) => action.verb === "delete")).toMatchObject({
      allowed: false,
      reason: "denied",
      deniedThrough: "write",
      decidedBy: { action: "agent.write", effect: "deny" }
    });
  });

  it("shows a reference nowhere: it is set and read on the person", () => {
    expect(
      decideHeldRights([entry({ action: "ref:crm", source: "legacy_ref" })], true, () => undefined)
    ).toEqual([]);
  });
});
