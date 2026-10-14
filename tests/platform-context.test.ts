import { describe, expect, it } from "vitest";
import { configAssetReferencesSchema, platformContextSchema } from "@vivd-catalyst/api-contract";
import {
  SCOPES_HEADER,
  SERVICE_HEADER,
  clientInstanceId,
  setupAccessInstance as setup,
  storeTestServicePrincipal
} from "./support/access-instance";

// `platform.context.get` is the first read of an outside editor: where it is, which kinds
// exist, and where the caller may do what.

const kinds = [
  {
    kind: "agent",
    plural: "agents",
    lifecycle: "active",
    representation: "config",
    owners: ["instance", "workspace"],
    actions: { read: "agent.read", write: "agent.write", delete: "agent.delete" }
  },
  {
    kind: "skill",
    plural: "skills",
    lifecycle: "active",
    representation: "config",
    owners: ["instance", "workspace"],
    actions: { read: "skill.read", write: "skill.write", delete: "skill.delete" }
  }
];

describe("platform.context.get", () => {
  it("answers a user with one Namespace grant that Namespace with the action, and both kinds", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.createNamespace("lena-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });

    const context = platformContextSchema.parse(
      (await t.expectOk(t.kai.id, "platform.context.get")).json()
    );

    expect(context.instance).toEqual({ id: "demo-local", name: "Access test" });
    expect(context.release.version).toMatch(/^\d+\.\d+\.\d+/u);
    expect(context.kinds).toEqual(kinds);
    expect(context.namespaces).toEqual([
      { prefix: "kai-", displayName: "kai-", actions: ["agent.write"] }
    ]);
    // A right in one Namespace is no right on the instance's assets as a whole.
    expect(context.actions).toEqual([]);
    // No field for modules: the module slice adds it.
    expect(Object.keys(context).sort()).toEqual([
      "actions",
      "assetActions",
      "instance",
      "instanceActions",
      "kinds",
      "namespaces",
      "release",
      "visibleSections",
      "workspaces"
    ]);
    // The Workflows module is off here: no section row is named.
    expect(context.visibleSections).toEqual([]);
  });

  it("lists no Namespace for a user who holds nothing, and an administrator's actions less a deny", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.admin.id, "agent.delete", { namespace: "kai-" }, "deny");

    const lena = platformContextSchema.parse(
      (await t.expectOk(t.lena.id, "platform.context.get")).json()
    );
    expect(lena.kinds).toEqual(kinds);
    expect(lena.namespaces).toEqual([]);
    expect(lena.actions).toEqual([]);
    expect(lena.assetActions).toEqual([]);
    expect(lena.instanceActions).toEqual([]);

    const admin = platformContextSchema.parse(
      (await t.expectOk(t.admin.id, "platform.context.get")).json()
    );
    expect(admin.namespaces).toEqual([
      {
        prefix: "kai-",
        displayName: "kai-",
        actions: ["agent.read", "agent.write", "skill.read", "skill.write", "skill.delete"]
      }
    ]);
    // The role administers service principals (RIGHTS-1a).
    expect(admin.instanceActions).toEqual(["service_principals.manage"]);
    // On the instance's assets as a whole the role holds every action: the deny names one
    // Namespace.
    expect(admin.actions).toEqual([
      "agent.read",
      "agent.write",
      "agent.delete",
      "skill.read",
      "skill.write",
      "skill.delete"
    ]);
  });

  it("names per workspace the actions the caller holds on what it owns, and no workspace where it holds none", async () => {
    const t = await setup();
    const team = await t.stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Team",
      creatorUserId: t.admin.id
    });
    await t.stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Other team",
      creatorUserId: t.admin.id
    });
    // Kai holds two rights in the one workspace and is no member of it.
    for (const action of ["agent.write", "skill.read"]) {
      await t.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: t.kai.id,
        action,
        effect: "allow",
        scopeKind: "workspace",
        scopeId: team.id,
        grantedBy: t.admin.id
      });
    }
    const workspacesOf = async (userId: string) =>
      platformContextSchema.parse((await t.expectOk(userId, "platform.context.get")).json())
        .workspaces;

    expect(await workspacesOf(t.kai.id)).toEqual([
      {
        id: team.id,
        name: "Team",
        kind: "shared",
        member: false,
        actions: ["agent.write", "skill.read"]
      }
    ]);
    // A right in a workspace is no right on the instance's own assets.
    expect(
      platformContextSchema.parse((await t.expectOk(t.kai.id, "platform.context.get")).json())
        .actions
    ).toEqual([]);
    expect(await workspacesOf(t.lena.id)).toEqual([]);
    // The administrator holds every action of the kinds in every Shared Workspace and in his
    // own personal one; another person's personal workspace is never named.
    const admin = await workspacesOf(t.admin.id);
    expect(admin.map((workspace) => `${workspace.name} (${workspace.kind})`).sort()).toEqual([
      "Other team (shared)",
      "Personal workspace (personal)",
      "Team (shared)"
    ]);
    expect(admin.find((workspace) => workspace.id === team.id)?.member).toBe(true);
    expect(admin.find((workspace) => workspace.id === team.id)?.actions).toEqual([
      "agent.read",
      "agent.write",
      "agent.delete",
      "skill.read",
      "skill.write",
      "skill.delete"
    ]);
  });

  it("names only the actions the credential's scopes let its holder use", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.createNamespace("lena-");
    for (const action of ["agent.read", "agent.write", "agent.delete", "skill.read"]) {
      await t.grant(t.kai.id, action, { namespace: "kai-" });
    }
    const namespacesWith = async (scopes: string) =>
      platformContextSchema.parse(
        (
          await t.expectOk(t.kai.id, "platform.context.get", {
            headers: { [SCOPES_HEADER]: scopes }
          })
        ).json()
      ).namespaces;

    expect(await namespacesWith("config_assets:read config_assets:write")).toEqual([
      {
        prefix: "kai-",
        displayName: "kai-",
        actions: ["agent.read", "agent.write", "agent.delete", "skill.read"]
      }
    ]);
    // A credential that only reads names no write and no delete, whatever its holder is granted.
    expect(await namespacesWith("config_assets:read")).toEqual([
      { prefix: "kai-", displayName: "kai-", actions: ["agent.read", "skill.read"] }
    ]);
    expect(await namespacesWith("config_assets:write")).toEqual([
      { prefix: "kai-", displayName: "kai-", actions: ["agent.write", "agent.delete"] }
    ]);
    // One that carries neither can use nothing here, so no Namespace is listed.
    expect(await namespacesWith("chat")).toEqual([]);
  });

  it("answers a service principal with what its grants and its credential open", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.createNamespace("lena-");
    const asService = async (scopes?: string) => {
      const response = await t.instance.call("platform.context.get", {
        headers: { [SERVICE_HEADER]: "sp_test", ...(scopes ? { [SCOPES_HEADER]: scopes } : {}) }
      });
      expect(response.statusCode, response.body).toBe(200);
      return platformContextSchema.parse(response.json());
    };

    const before = await asService();
    expect(before.instance.id).toBe(clientInstanceId);
    expect(before.kinds).toEqual(kinds);
    // Its key reads every asset of the instance, so both Namespaces are listed for reading.
    const reads = ["agent.read", "skill.read"];
    expect(before.namespaces).toEqual([
      { prefix: "kai-", displayName: "kai-", actions: reads },
      { prefix: "lena-", displayName: "lena-", actions: reads }
    ]);

    await storeTestServicePrincipal("sp_test");
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: "sp_test",
      action: "skill.write",
      effect: "allow",
      scopeKind: "namespace",
      namespace: "kai-",
      grantedBy: t.admin.id
    });
    expect((await asService()).namespaces).toEqual([
      { prefix: "kai-", displayName: "kai-", actions: ["agent.read", "skill.read", "skill.write"] },
      { prefix: "lena-", displayName: "lena-", actions: reads }
    ]);
    expect((await asService("config_assets:write")).namespaces).toEqual([
      { prefix: "kai-", displayName: "kai-", actions: ["skill.write"] }
    ]);
    expect((await asService("chat")).namespaces).toEqual([]);
  });
});

// `platform.references.get` is what an editor offers for a definition. It is for whoever can
// use an action of a registered kind somewhere, which is who the context lists a Namespace for.
describe("platform.references.get", () => {
  const references = {
    modelProviderIds: ["local"],
    modelBindingIds: ["plain", "other"],
    modelBindings: [
      { id: "plain", model: "local" },
      { id: "other", model: "local" }
    ],
    fastModeModelBindingIds: [],
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    enabledToolNames: ["known.tool", "second.tool"],
    moduleOffTools: []
  };
  const refused = { status: 403, code: "FORBIDDEN" };

  it("answers the holder of one right in one Namespace, and the administrator, the same as the overview", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });

    const read = async (userId: string) =>
      configAssetReferencesSchema.parse(
        (await t.expectOk(userId, "platform.references.get")).json()
      );
    expect(await read(t.kai.id)).toEqual(references);
    expect(await read(t.admin.id)).toEqual(references);
    // The overview stays closed to the Namespace holder, and tells the administrator the same.
    await t.expectRefused(t.kai.id, "config_assets.get_overview", {}, refused);
    const overview = (await t.expectOk(t.admin.id, "config_assets.get_overview")).json();
    expect(overview).toMatchObject({ references });
  });

  it("refuses a user who holds no right on any kind anywhere", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });

    const error = await t.expectRefused(t.lena.id, "platform.references.get", {}, refused);
    // The refusal tells nothing of the instance.
    expect(JSON.stringify(error)).not.toContain("known.tool");
  });

  it("refuses a credential whose scopes open no action its holder is granted", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, "agent.read", { namespace: "kai-" });
    const withScopes = (userId: string, scopes: string) =>
      t.call(userId, "platform.references.get", { headers: { [SCOPES_HEADER]: scopes } });

    expect((await withScopes(t.kai.id, "config_assets:read")).statusCode).toBe(200);
    // Without `config_assets:read` nobody reads it, the administrator included.
    expect((await withScopes(t.kai.id, "chat")).statusCode).toBe(403);
    expect((await withScopes(t.admin.id, "config_assets:write")).statusCode).toBe(403);
    expect((await withScopes(t.admin.id, "config_assets:read")).statusCode).toBe(200);
  });

  it("writes no Operation Run", async () => {
    const t = await setup();
    const runs = () => t.stores.operationRuns.list({ clientInstanceId });
    const before = (await runs()).length;
    await t.expectOk(t.admin.id, "platform.references.get");
    expect((await runs()).length).toBe(before);
    // The context is a registered read, and an allowed one leaves no run either.
    await t.expectOk(t.admin.id, "platform.context.get");
    expect((await runs()).length).toBe(before);
  });
});
