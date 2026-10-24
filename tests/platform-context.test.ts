import { describe, expect, it } from "vitest";
import {
  PUBLISHED_CLI_VERSION,
  RELEASE_VERSION,
  configAssetReferencesSchema,
  platformContextSchema
} from "@work-shape/catalyst-api-contract";
import { INSTANCE_ASSET_SCOPE } from "@work-shape/catalyst-core";
import {
  SCOPES_HEADER,
  SERVICE_HEADER,
  agent,
  clientInstanceId,
  setupAccessInstance as setup,
  storeTestServicePrincipal
} from "./support/access-instance";
import { personalKeyServer, issuePersonalKey, personalKeyToken } from "./support/personal-api-keys";
import { applyAtCurrentRevisions } from "./support/asset-revisions";

// `platform.context.get` is the first read of an outside editor: where it is, which kinds
// exist, and where the caller may do what.

const kinds = [
  {
    kind: "agent",
    plural: "agents",
    lifecycle: "active",
    representation: "config",
    owners: ["instance", "workspace"],
    actions: {
      read: "agent.read",
      write: "agent.write",
      publish: "agent.publish",
      approve: "agent.approve",
      delete: "agent.delete"
    }
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
  it("answers a user with one workspace grant that workspace with the action, and both kinds", async () => {
    const t = await setup();
    const team = await t.sharedWorkspace("Kai's team");
    await t.sharedWorkspace("Lena's team");
    await t.grant(t.kai.id, "agent.write", { workspaceId: team });

    const context = platformContextSchema.parse(
      (await t.expectOk(t.kai.id, "platform.context.get")).json()
    );

    expect(context.instance).toEqual({
      id: "demo-local",
      name: "Access test",
      timeZone: "UTC",
      timeZoneDefaulted: true
    });
    expect(context.release.version).toMatch(/^\d+\.\d+\.\d+/u);
    // The CLI version Connect a local agent installs is the one on npm this commit names, and
    // none while it names none (CONNECT-1a, check 52); never merely the release's own version.
    expect(context.release).toEqual({
      version: RELEASE_VERSION,
      ...(PUBLISHED_CLI_VERSION === undefined ? {} : { cliVersion: PUBLISHED_CLI_VERSION })
    });
    expect(context.kinds).toEqual(kinds);
    expect(context.workspaces).toEqual([
      { id: team, name: "Kai's team", kind: "shared", member: false, actions: ["agent.write"] }
    ]);
    // A right in one workspace is no right on the instance's assets as a whole.
    expect(context.actions).toEqual([]);
    // No field for modules: the module slice adds it.
    expect(Object.keys(context).sort()).toEqual([
      "actions",
      "assetActions",
      "authoringActions",
      "instance",
      "instanceActions",
      "kinds",
      "release",
      "useActions",
      "visibleSections",
      "workspaces"
    ]);
    // The Workflows module is off here: no section row is named.
    expect(context.visibleSections).toEqual([]);
  });

  it("lists no workspace for a user who holds nothing, and an administrator's actions less a deny", async () => {
    const t = await setup();
    const team = await t.sharedWorkspace("Kai's team");
    await t.grant(t.admin.id, "agent.delete", { workspaceId: team }, "deny");

    const lena = platformContextSchema.parse(
      (await t.expectOk(t.lena.id, "platform.context.get")).json()
    );
    expect(lena.kinds).toEqual(kinds);
    expect(lena.workspaces).toEqual([]);
    expect(lena.actions).toEqual([]);
    expect(lena.assetActions).toEqual([]);
    expect(lena.instanceActions).toEqual([]);
    expect(lena.useActions).toEqual([]);
    expect(lena.authoringActions).toEqual([]);

    const admin = platformContextSchema.parse(
      (await t.expectOk(t.admin.id, "platform.context.get")).json()
    );
    expect(admin.workspaces.find((workspace) => workspace.id === team)?.actions).toEqual([
      "agent.read",
      "agent.write",
      "agent.publish",
      "skill.read",
      "skill.write",
      "skill.delete"
    ]);
    // The role administers service principals (RIGHTS-1a) and the spend limits (LU-2).
    expect(admin.instanceActions).toEqual(["service_principals.manage", "limits.manage"]);
    // Agents and skills are used through no right of their own: no use level is offered.
    expect(admin.useActions).toEqual([]);
    // What the key `catalyst setup` asks for: authoring and publishing, never deleting.
    expect(admin.authoringActions).toEqual([
      "agent.read",
      "agent.write",
      "agent.publish",
      "skill.read",
      "skill.write"
    ]);
    // On the instance's assets as a whole the role holds every action: the deny names one
    // workspace.
    expect(admin.actions).toEqual([
      "agent.read",
      "agent.write",
      "agent.delete",
      "agent.publish",
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
      "agent.publish",
      "skill.read",
      "skill.write",
      "skill.delete"
    ]);
  });

  it("names only the actions the credential's scopes let its holder use", async () => {
    const t = await setup();
    const team = await t.sharedWorkspace("Kai's team");
    await t.sharedWorkspace("Lena's team");
    for (const action of ["agent.read", "agent.write", "agent.delete", "skill.read"]) {
      await t.grant(t.kai.id, action, { workspaceId: team });
    }
    const actionsWith = async (scopes: string) =>
      platformContextSchema
        .parse(
          (
            await t.expectOk(t.kai.id, "platform.context.get", {
              headers: { [SCOPES_HEADER]: scopes }
            })
          ).json()
        )
        .workspaces.map((workspace) => ({ id: workspace.id, actions: workspace.actions }));

    expect(await actionsWith("config_assets:read config_assets:write")).toEqual([
      { id: team, actions: ["agent.read", "agent.write", "agent.delete", "skill.read"] }
    ]);
    // A credential that only reads names no write and no delete, whatever its holder is granted.
    expect(await actionsWith("config_assets:read")).toEqual([
      { id: team, actions: ["agent.read", "skill.read"] }
    ]);
    expect(await actionsWith("config_assets:write")).toEqual([
      { id: team, actions: ["agent.write", "agent.delete"] }
    ]);
    // One that carries neither can use nothing here, so no workspace is listed.
    expect(await actionsWith("chat")).toEqual([]);
  });

  it("answers a service principal with what its grants and its credential open", async () => {
    const t = await setup();
    const kaiTeam = await t.sharedWorkspace("Kai's team");
    const lenaTeam = await t.sharedWorkspace("Lena's team");
    const asService = async (scopes?: string) => {
      const response = await t.instance.call("platform.context.get", {
        headers: { [SERVICE_HEADER]: "sp_test", ...(scopes ? { [SCOPES_HEADER]: scopes } : {}) }
      });
      expect(response.statusCode, response.body).toBe(200);
      return platformContextSchema.parse(response.json());
    };
    /** The actions named per workspace, by the workspace's id. */
    const byWorkspace = (context: { workspaces: { id: string; actions: string[] }[] }) =>
      Object.fromEntries(context.workspaces.map(({ id, actions }) => [id, actions]));

    const before = await asService();
    expect(before.instance.id).toBe(clientInstanceId);
    expect(before.kinds).toEqual(kinds);
    // Its key reads every asset of the instance, so both workspaces are listed for reading.
    const reads = ["agent.read", "skill.read"];
    expect(byWorkspace(before)).toEqual({ [kaiTeam]: reads, [lenaTeam]: reads });

    await storeTestServicePrincipal("sp_test");
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: "sp_test",
      action: "skill.write",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: kaiTeam,
      grantedBy: t.admin.id
    });
    expect(byWorkspace(await asService())).toEqual({
      [kaiTeam]: ["agent.read", "skill.read", "skill.write"],
      [lenaTeam]: reads
    });
    expect(byWorkspace(await asService("config_assets:write"))).toEqual({
      [kaiTeam]: ["skill.write"]
    });
    expect((await asService("chat")).workspaces).toEqual([]);
  });
});

// `platform.references.get` is what an editor offers for a definition. It is for whoever can
// use an action of a registered kind on the instance's assets, or read one in a workspace or on
// one asset.
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
    // No code of this instance registers them, so they are listed by their names alone.
    tools: [{ name: "known.tool" }, { name: "second.tool" }],
    unavailableTools: [],
    moduleOffTools: []
  };
  const refused = { status: 403, code: "FORBIDDEN" };

  it("answers the holder of one right in one workspace, and the administrator, the same as the overview", async () => {
    const t = await setup();
    await t.grant(t.kai.id, "agent.read", { workspaceId: await t.sharedWorkspace("Kai's team") });

    const read = async (userId: string) =>
      configAssetReferencesSchema.parse(
        (await t.expectOk(userId, "platform.references.get")).json()
      );
    expect(await read(t.kai.id)).toEqual(references);
    expect(await read(t.admin.id)).toEqual(references);
    // The overview stays closed to the workspace's holder, and tells the administrator the same.
    await t.expectRefused(t.kai.id, "config_assets.get_overview", {}, refused);
    const overview = (await t.expectOk(t.admin.id, "config_assets.get_overview")).json();
    expect(overview).toMatchObject({ references });
  });

  it("refuses a user who holds no right on any kind anywhere", async () => {
    const t = await setup();
    await t.grant(t.kai.id, "agent.write", { workspaceId: await t.sharedWorkspace("Kai's team") });

    const error = await t.expectRefused(t.lena.id, "platform.references.get", {}, refused);
    // The refusal tells nothing of the instance.
    expect(JSON.stringify(error)).not.toContain("known.tool");
  });

  it.each(["asset", "workspace"] as const)(
    "answers an agent reader granted access to one %s without opening other agents",
    async (scopeKind) => {
      const t = await setup();
      const scope =
        scopeKind === "asset"
          ? INSTANCE_ASSET_SCOPE
          : { kind: "workspace" as const, workspaceId: await t.sharedWorkspace("Reader team") };
      await applyAtCurrentRevisions(t.stores.configAssets, {
        clientInstanceId,
        mutations: ["readable-agent", "hidden-agent"].map((name) => ({
          type: "upsert",
          kind: "agent",
          name,
          config: agent(name, { instructions: `${name} private instructions` }),
          scope
        }))
      });
      await t.grant(
        t.kai.id,
        "agent.read",
        scope.kind === "workspace"
          ? { workspaceId: scope.workspaceId }
          : { assetId: await t.assetId("agent", "readable-agent") }
      );
      await t.grant(
        t.kai.id,
        "agent.read",
        { assetId: await t.assetId("agent", "hidden-agent") },
        "deny"
      );
      const headers = { [SCOPES_HEADER]: "config_assets:read" };
      const query = scope.kind === "workspace" ? { workspaceId: scope.workspaceId } : {};
      await t.expectOk(t.kai.id, "assets.get", {
        params: { kind: "agent", name: "readable-agent" },
        query,
        headers
      });

      // Release metadata supplies the reader's model/tool labels, never other agents' data.
      const response = await t.expectOk(t.kai.id, "platform.references.get", { headers });
      expect(response.json()).toEqual({
        ...references,
        registeredToolNames: ["known.tool", "second.tool"]
      });
      await t.expectRefused(
        t.kai.id,
        "assets.get",
        { params: { kind: "agent", name: "hidden-agent" }, query, headers },
        t.forbidden("agent.read", "denied")
      );
      // A right to references grants no right on another agent. An ungranted name and an
      // unknown name keep the same refusal; neither response carries agent configuration.
      const unreadable = await t.expectRefused(
        t.kai.id,
        "assets.get",
        { params: { kind: "agent", name: "assistant" }, headers },
        t.forbidden("agent.read", "no_grant")
      );
      const missing = await t.expectRefused(
        t.kai.id,
        "assets.get",
        { params: { kind: "agent", name: "missing-agent" }, headers },
        t.forbidden("agent.read", "no_grant")
      );
      expect(unreadable).toEqual(missing);
      if (scope.kind === "workspace") {
        // In the readable scope, a name owned elsewhere is absent just like an unknown one.
        for (const name of ["assistant", "missing-agent"]) {
          const error = await t.expectRefused(
            t.kai.id,
            "assets.get",
            { params: { kind: "agent", name }, query, headers },
            { status: 404, code: "NOT_FOUND" }
          );
          expect(error.message).toBe(`Config agent '${name}' was not found`);
        }
      }
      await t.expectRefused(
        t.kai.id,
        "platform.references.get",
        { headers: { [SCOPES_HEADER]: "chat" } },
        refused
      );
    }
  );

  it("refuses a credential whose scopes open no action its holder is granted", async () => {
    const t = await setup();
    await t.grant(t.kai.id, "agent.read", { workspaceId: await t.sharedWorkspace("Kai's team") });
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

describe("credential discovery (ADISC-1 check 70)", () => {
  const setupKeys = () =>
    setup({
      modules: { personalApiKeys: { enabled: true } },
      server: (stores) => personalKeyServer(stores)
    });

  it("narrows an admin's instanceActions while retaining the existing key issuance choices", async () => {
    const t = await setupKeys();
    const owner = platformContextSchema.parse(
      (await t.expectOk(t.admin.id, "platform.context.get")).json()
    );
    const narrowed = platformContextSchema.parse(
      (
        await t.expectOk(t.admin.id, "platform.context.get", {
          headers: { [SCOPES_HEADER]: "config_assets:read" }
        })
      ).json()
    );
    expect(narrowed.instanceActions).toEqual([]);
    expect(narrowed.useActions).toEqual(owner.useActions);
    expect(narrowed.authoringActions).toEqual(owner.authoringActions);
    const key = await issuePersonalKey(t, ["skill.read"], t.admin.id);
    const headers = await personalKeyToken(t, key.secret);
    const context = platformContextSchema.parse(
      (await t.instance.call("platform.context.get", { headers })).json()
    );
    expect(context.instanceActions).toEqual([]);
    expect(context.actions).toEqual(["skill.read"]);
    // Existing issuance choices still come from the evaluator, not the operation scope filter.
    expect(context.useActions).toEqual([]);
    expect(context.authoringActions).toEqual(["skill.read"]);
    expect(
      (await t.instance.call("assets.list", { headers, params: { kind: "skill" } })).statusCode
    ).toBe(200);
  });

  it("lists only callable actions for workspace and single-skill keys and a service principal", async () => {
    const t = await setupKeys();
    const workspace = await t.stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Readable workspace",
      creatorUserId: t.admin.id
    });
    await t.grant(t.kai.id, "skill.read", { workspaceId: workspace.id });
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: "workspace-guide",
          scope: { kind: "workspace", workspaceId: workspace.id },
          config: {
            name: "workspace-guide",
            title: "Guide",
            description: "Guide",
            content: "Read me"
          }
        },
        {
          type: "upsert",
          kind: "skill",
          name: "one-guide",
          config: { name: "one-guide", title: "Guide", description: "Guide", content: "Read one" }
        }
      ]
    });
    const workspaceKey = await issuePersonalKey(t, ["skill.read"]);
    const workspaceHeaders = await personalKeyToken(t, workspaceKey.secret);
    const workspaceContext = platformContextSchema.parse(
      (await t.instance.call("platform.context.get", { headers: workspaceHeaders })).json()
    );
    expect(workspaceContext.actions).toEqual([]);
    expect(workspaceContext.instanceActions).toEqual([]);
    expect(workspaceContext.assetActions).toEqual(["skill.read"]);
    expect(workspaceContext.workspaces).toEqual([
      {
        id: workspace.id,
        name: workspace.name,
        kind: "shared",
        member: false,
        actions: ["skill.read"]
      }
    ]);
    for (const action of workspaceContext.workspaces.flatMap((row) => row.actions)) {
      expect(action).toBe("skill.read");
      expect(
        (
          await t.instance.call("assets.list", {
            headers: workspaceHeaders,
            params: { kind: "skill" },
            query: { workspaceId: workspace.id }
          })
        ).statusCode
      ).toBe(200);
    }
    const one = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "skill",
      name: "one-guide"
    });
    if (!one) throw new Error("Missing fixture skill");
    await t.grant(t.lena.id, "skill.read", { assetId: one.id });
    const assetKey = await issuePersonalKey(t, ["skill.read"], t.lena.id);
    const assetHeaders = await personalKeyToken(t, assetKey.secret);
    const assetContext = platformContextSchema.parse(
      (await t.instance.call("platform.context.get", { headers: assetHeaders })).json()
    );
    expect(assetContext.actions).toEqual([]);
    expect(assetContext.instanceActions).toEqual([]);
    expect(assetContext.workspaces).toEqual([]);
    expect(assetContext.assetActions).toEqual(["skill.read"]);
    expect(
      (
        await t.instance.call("assets.get", {
          headers: assetHeaders,
          params: { kind: "skill", name: "one-guide" }
        })
      ).statusCode
    ).toBe(200);

    await storeTestServicePrincipal("sp_discovery");
    const serviceHeaders = {
      [SERVICE_HEADER]: "sp_discovery",
      [SCOPES_HEADER]: "config_assets:read"
    };
    const service = platformContextSchema.parse(
      (await t.instance.call("platform.context.get", { headers: serviceHeaders })).json()
    );
    expect(service.instanceActions).toEqual([]);
    expect(service.actions).toEqual(["agent.read", "skill.read"]);
    for (const action of service.actions) {
      expect(
        (
          await t.instance.call("assets.list", {
            headers: serviceHeaders,
            params: { kind: action.slice(0, action.indexOf(".")) }
          })
        ).statusCode
      ).toBe(200);
    }
  });

  it("hides skill names from a key without skill.read and rejects its next call after revocation", async () => {
    const t = await setupKeys();
    const sentinel = "hidden-sentinel-adisc-one";
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: sentinel,
          config: { name: sentinel, title: sentinel, description: sentinel, content: sentinel }
        }
      ]
    });
    const key = await issuePersonalKey(t, ["agent.read"], t.admin.id);
    const headers = await personalKeyToken(t, key.secret);
    const context = await t.instance.call("platform.context.get", { headers });
    const list = await t.instance.call("assets.list", { headers, params: { kind: "skill" } });
    const show = await t.instance.call("assets.get", {
      headers,
      params: { kind: "skill", name: sentinel }
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject({ items: [] });
    expect(show.statusCode, show.body).toBe(404);
    expect(JSON.stringify([context.json(), list.json(), show.json()])).not.toContain(sentinel);
    const assistant = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "agent",
      name: "assistant"
    });
    if (!assistant) throw new Error("Missing fixture agent");
    await t.grant(t.kai.id, "agent.read", { assetId: assistant.id });
    const ungrantedKey = await issuePersonalKey(t, ["agent.read"]);
    const ungrantedHeaders = await personalKeyToken(t, ungrantedKey.secret);
    const ungranted = await t.instance.call("assets.get", {
      headers: ungrantedHeaders,
      params: { kind: "skill", name: sentinel }
    });
    expect(ungranted.statusCode, ungranted.body).toBe(404);
    expect(ungranted.body).not.toContain(sentinel);
    await t.expectOk(t.admin.id, "me.api_keys.revoke", { params: { keyId: key.key.id } });
    expect((await t.instance.call("platform.context.get", { headers })).statusCode).toBe(401);
  });
});
