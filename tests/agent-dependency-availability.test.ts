import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError, asUserId, type PlatformStores } from "@work-shape/catalyst-core";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { required } from "./support/assertions";
import {
  clientInstanceId,
  useDataStoreInstance,
  type DataStoreInstance
} from "./support/data-store-instance";
import { agent } from "./support/access-instance";
const developmentAuth = {
  enabled: true,
  users: [
    {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "Mara",
      roles: ["user", "admin", "superadmin"]
    },
    { id: "member-1", externalUserId: "member-1", displayLabel: "Member", roles: ["user"] }
  ]
};
const agentOf = (knowledgeBases: string[]) => agent("berater", { knowledgeBases });
describe("agent dependency availability (AVAIL-1)", () => {
  const { start, person, publishStore } = useDataStoreInstance();
  async function publishKnowledgeBase(world: DataStoreInstance, name: string) {
    const params = { kind: "knowledge_base", name };
    const put = await world.api.call("assets.put", {
      params,
      payload: {
        expectedRevision: null,
        config: { name, title: "Rules", description: "Guidelines", methods: ["keyword"] }
      }
    });
    expect(put.statusCode, put.body).toBe(200);
    const publish = await world.api.call("assets.publish", { params, payload: { revision: 1 } });
    expect(publish.statusCode, publish.body).toBe(200);
  }
  it("lists missing KBs and Connections before publish and changes availability only by explicit authorized choice (AVAIL-1)", async () => {
    const instance = await start(true, undefined, developmentAuth, undefined, {
      connections: true
    });
    await publishKnowledgeBase(instance, "rules");
    await applyAtCurrentRevisions(instance.stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "accounting",
          config: {
            name: "accounting",
            displayName: "Accounting",
            connectorType: "http_api",
            origin: "release",
            enabled: true,
            ownerPrincipalId: "system",
            authScheme: "none",
            credentialMode: "shared",
            settings: { baseUrl: "https://example.com" },
            operations: [
              {
                name: "facts",
                enabled: true,
                effect: "reading",
                exposure: ["agent"],
                method: "GET",
                path: "/facts"
              }
            ]
          }
        }
      ]
    });
    const admin = await person(instance, "user-1", ["user", "admin", "superadmin"]);
    const workspace = await instance.stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Nordlicht",
      creatorUserId: asUserId(admin.id)
    });
    const params = { kind: "agent", name: "berater" };
    const config = { ...agentOf(["rules"]), toolNames: ["connection.accounting.facts"] };
    const first = await instance.api.call("assets.put", {
      params: { kind: "agent", name: "welcome" },
      payload: { config: { ...agentOf([]), name: "welcome" }, expectedRevision: null }
    });
    expect(first.statusCode, first.body).toBe(200);
    const saved = await instance.api.call("assets.put", {
      params,
      payload: { config, expectedRevision: null }
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const availability = { mode: "selected", collaborationWorkspaceIds: [workspace.id] };
    const place = await instance.api.call("assets.set_availability", {
      params,
      payload: availability
    });
    expect(place.statusCode, place.body).toBe(200);
    const read = await instance.api.call("assets.get", { params });
    expect(read.json()).toMatchObject({
      dependencyAvailability: {
        missing: [
          { kind: "knowledge_base", name: "rules", canMakeAvailable: true },
          {
            kind: "connection",
            name: "accounting",
            displayName: "Accounting",
            canMakeAvailable: true
          }
        ]
      }
    });
    const edited = await instance.api.call("assets.put", {
      params,
      payload: {
        config: { ...config, instructions: "Use the guidelines and accounting facts." },
        expectedRevision: 1,
        expectedDraftRevision: null
      }
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const draft = await instance.api.call("agents.draft.get", { params: { name: "berater" } });
    const revision = z
      .object({
        draft: z.object({
          revision: z.number(),
          dependencyAvailability: z.object({ missing: z.array(z.unknown()) })
        })
      })
      .parse(draft.json()).draft.revision;
    const getAvailability = (kind: string, name: string) =>
      instance.stores.configAssets.listAgentAvailability({
        clientInstanceId,
        kind,
        agentName: name
      });
    expect((await getAvailability("connection", "accounting")).size).toBe(0);
    const memberId = z
      .object({ id: z.string() })
      .parse(
        (await instance.api.call("me.get", { headers: { "x-dev-user-id": "member-1" } })).json()
      ).id;
    const member = required(
      await instance.stores.users.getUser({ clientInstanceId, userId: asUserId(memberId) })
    );
    const agentAsset = required(
      await instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "agent",
        name: "berater"
      })
    );
    for (const action of ["agent.write", "agent.publish"])
      await instance.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: member.id,
        action,
        effect: "allow",
        scopeKind: "asset",
        scopeId: agentAsset.id,
        grantedBy: asUserId(admin.id)
      });
    for (const [kind, name] of [
      ["knowledge_base", "rules"],
      ["connection", "accounting"]
    ] as const) {
      const dependency = required(
        await instance.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name })
      );
      await instance.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: member.id,
        action: `${kind}.write`,
        effect: "allow",
        scopeKind: "asset",
        scopeId: dependency.id,
        grantedBy: asUserId(admin.id)
      });
    }
    const restrictedDraft = await instance.api.call("agents.draft.get", {
      params: { name: "berater" },
      headers: { "x-dev-user-id": "member-1" }
    });
    expect(restrictedDraft.json()).toMatchObject({
      draft: {
        dependencyAvailability: {
          missing: [
            { kind: "knowledge_base", canMakeAvailable: false },
            { kind: "connection", canMakeAvailable: false }
          ]
        }
      }
    });
    const refusedPublish = await instance.api.call("assets.publish", {
      params,
      payload: {
        revision,
        makeDependenciesAvailable: true,
        expectedAvailability: { ...availability, personalWorkspaces: false }
      },
      headers: { "x-dev-user-id": "member-1" }
    });
    expect(refusedPublish.statusCode, refusedPublish.body).toBe(403);
    for (const row of await instance.stores.access.listGrants({
      clientInstanceId,
      holderKind: "user",
      holderId: member.id
    })) {
      if (row.action.endsWith(".write") && row.action !== "agent.write")
        await instance.stores.access.deleteGrant({ clientInstanceId, grantId: row.id });
    }
    for (const [kind, name] of [
      ["knowledge_base", "rules"],
      ["connection", "accounting"]
    ] as const)
      expect((await getAvailability(kind, name)).size).toBe(0);
    const missingPrecondition = await instance.api.call("assets.publish", {
      params,
      payload: { revision, makeDependenciesAvailable: true }
    });
    expect(missingPrecondition.statusCode, missingPrecondition.body).toBe(428);
    const adminCallerId = z
      .object({ id: z.string() })
      .parse((await instance.api.call("me.get")).json()).id;
    const connectionAsset = required(
      await instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name: "accounting"
      })
    );
    const deny = await instance.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: adminCallerId,
      action: "connection.write",
      effect: "deny",
      scopeKind: "asset",
      scopeId: connectionAsset.id,
      grantedBy: asUserId(adminCallerId)
    });
    const deniedDraft = await instance.api.call("agents.draft.get", {
      params: { name: "berater" }
    });
    expect(deniedDraft.json()).toMatchObject({
      draft: {
        dependencyAvailability: {
          missing: [
            { kind: "knowledge_base", canMakeAvailable: true },
            { kind: "connection", canMakeAvailable: false }
          ]
        }
      }
    });
    const deniedPublish = await instance.api.call("assets.publish", {
      params,
      payload: {
        revision,
        makeDependenciesAvailable: true,
        expectedAvailability: { ...availability, personalWorkspaces: false }
      }
    });
    expect(deniedPublish.statusCode, deniedPublish.body).toBe(403);
    expect((await getAvailability("knowledge_base", "rules")).size).toBe(0);
    await instance.stores.access.deleteGrant({ clientInstanceId, grantId: deny.id });
    const stale = await instance.api.call("assets.publish", {
      params,
      payload: {
        revision,
        makeDependenciesAvailable: true,
        expectedAvailability: { ...availability, personalWorkspaces: true }
      }
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect((await getAvailability("connection", "accounting")).size).toBe(0);
    const transaction = instance.stores.transaction.bind(instance.stores);
    const failCommit: PlatformStores["transaction"] = (fn) =>
      transaction(async (stores) => {
        let dependencyChanged = false;
        const result = await fn({
          ...stores,
          configAssets: {
            ...stores.configAssets,
            setAgentAvailability: async (input) => {
              if (input.kind && input.kind !== "agent") dependencyChanged = true;
              return stores.configAssets.setAgentAvailability(input);
            }
          }
        });
        if (dependencyChanged) throw new AppError("CONFLICT", "Synthetic commit refusal");
        return result;
      });
    const transactionFault = vi
      .spyOn(instance.stores, "transaction")
      .mockImplementation(failCommit);
    const rolledBack = await instance.api.call("assets.publish", {
      params,
      payload: {
        revision,
        makeDependenciesAvailable: true,
        expectedAvailability: { ...availability, personalWorkspaces: false }
      }
    });
    transactionFault.mockRestore();
    expect(rolledBack.statusCode, rolledBack.body).toBe(409);
    const failedRun = rolledBack.headers["operation-run-id"];
    const events = await instance.stores.audit.listAuditEvents({ clientInstanceId, limit: 100 });
    expect(
      events.filter(
        (event) =>
          event.metadata?.operationRunId === failedRun &&
          (event.type === "config_asset.updated" || event.type === "config_asset.availability_set")
      )
    ).toEqual([]);
    expect((await getAvailability("connection", "accounting")).size).toBe(0);
    const published = await instance.api.call("assets.publish", {
      params,
      payload: {
        revision,
        makeDependenciesAvailable: true,
        expectedAvailability: { ...availability, personalWorkspaces: false }
      }
    });
    expect(published.statusCode, published.body).toBe(200);
    for (const [kind, name] of [
      ["knowledge_base", "rules"],
      ["connection", "accounting"]
    ] as const)
      expect((await getAvailability(kind, name)).get(name)).toMatchObject({
        mode: "selected",
        collaborationWorkspaceIds: [workspace.id]
      });
    const after = await instance.api.call("assets.get", { params });
    expect(after.json()).toMatchObject({ dependencyAvailability: { missing: [] } });
    const extraWorkspace = await instance.stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "More people",
      creatorUserId: asUserId(admin.id)
    });
    const wider = {
      mode: "selected",
      collaborationWorkspaceIds: [workspace.id, extraWorkspace.id],
      makeDependenciesAvailable: true,
      expectedRevision: z.object({ revision: z.number() }).parse(after.json()).revision
    };
    const conflict = await instance.api.call("assets.set_availability", {
      params,
      payload: { ...wider, expectedAssetId: "gone" }
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(
      (await getAvailability("connection", "accounting")).get("accounting")
        ?.collaborationWorkspaceIds
    ).toEqual([workspace.id]);
    const changedDefinition = await instance.api.call("assets.set_availability", {
      params,
      payload: { ...wider, expectedRevision: 1 }
    });
    expect(changedDefinition.statusCode, changedDefinition.body).toBe(409);
    expect(
      (await getAvailability("connection", "accounting")).get("accounting")
        ?.collaborationWorkspaceIds
    ).toEqual([workspace.id]);
    const extended = await instance.api.call("assets.set_availability", {
      params,
      payload: wider
    });
    expect(extended.statusCode, extended.body).toBe(200);
    expect(
      new Set(
        (await getAvailability("connection", "accounting")).get("accounting")
          ?.collaborationWorkspaceIds
      )
    ).toEqual(new Set([workspace.id, extraWorkspace.id]));
    await instance.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      userId: asUserId(member.id),
      role: "member"
    });
    const settings = await instance.api.call("assets.get", {
      params: { kind: "knowledge_base", name: "rules" },
      headers: { "x-dev-user-id": "member-1" }
    });
    expect(settings.statusCode, settings.body).toBe(403);
  });

  it("counts availability-derived KB readers once, including denies, on the store audience", async () => {
    const world = await start(true, undefined, developmentAuth, undefined, true);
    const store = await publishStore(world);
    const params = { kind: "knowledge_base", name: "reporting" };
    const put = await world.api.call("assets.put", {
      params,
      payload: {
        expectedRevision: null,
        config: {
          name: "reporting",
          title: "Reporting",
          description: "Reports",
          backend: { dataStore: "findings" },
          tables: [{ name: "findings", description: "Findings" }]
        }
      }
    });
    expect(put.statusCode, put.body).toBe(200);
    const published = await world.api.call("assets.publish", { params, payload: { revision: 1 } });
    expect(published.statusCode, published.body).toBe(200);
    const memberId = z
      .object({ id: z.string() })
      .parse(
        (await world.api.call("me.get", { headers: { "x-dev-user-id": "member-1" } })).json()
      ).id;
    const adminId = z.object({ id: z.string() }).parse((await world.api.call("me.get")).json()).id;
    const workspaceIds = [];
    for (const name of ["Nordlicht", "Other team"]) {
      const workspace = await world.stores.workspaces.createWorkspace({
        clientInstanceId,
        name,
        kind: "shared",
        creatorUserId: asUserId(adminId)
      });
      workspaceIds.push(workspace.id);
      await world.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspace.id,
        userId: asUserId(memberId),
        role: "member"
      });
    }
    const availability = await world.api.call("assets.set_availability", {
      params,
      payload: { mode: "selected", collaborationWorkspaceIds: workspaceIds }
    });
    expect(availability.statusCode, availability.body).toBe(200);
    const kb = required(
      await world.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "knowledge_base",
        name: "reporting"
      })
    );
    const audience = async () => {
      const used = await world.api.call("data_stores.used_by", { params: { store: store.name } });
      expect(used.statusCode, used.body).toBe(200);
      return z
        .object({
          knowledgeBases: z.array(
            z.object({
              audience: z.object({
                holders: z.array(z.object({ name: z.string() })),
                hiddenHolders: z.number()
              })
            })
          )
        })
        .parse(used.json()).knowledgeBases[0]?.audience;
    };
    expect(await audience()).toEqual({ holders: [{ name: memberId }], hiddenHolders: 0 });
    const directRight = await world.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: memberId,
      action: "knowledge_base.use",
      effect: "allow",
      scopeKind: "asset",
      scopeId: kb.id,
      grantedBy: asUserId(adminId)
    });
    expect(await audience()).toEqual({ holders: [{ name: memberId }], hiddenHolders: 0 });
    await world.stores.access.deleteGrant({ clientInstanceId, grantId: directRight.id });
    await world.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: memberId,
      action: "knowledge_base.use",
      effect: "deny",
      scopeKind: "asset",
      scopeId: kb.id,
      grantedBy: asUserId(adminId)
    });
    expect(await audience()).toEqual({ holders: [], hiddenHolders: 0 });
  });
});
