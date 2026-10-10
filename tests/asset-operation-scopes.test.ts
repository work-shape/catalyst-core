import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateConfigAssetBundle } from "@vivd-catalyst/config-schema";
import type { AssetScope, CollaborationWorkspaceId } from "@vivd-catalyst/core";
import {
  SERVICE_HEADER,
  agent,
  clientInstanceId,
  errorSchema,
  skill,
  type AccessInstance
} from "./support/access-instance";
import { setupNamespaceHolder as setupNamespace } from "./support/asset-operations";
import { withTestSql } from "./support/test-sql";

// What an asset call may reach when a workspace owns assets beside the instance, and what a
// definition is checked for before it is written.

async function createWorkspace(t: AccessInstance, name: string): Promise<CollaborationWorkspaceId> {
  const workspace = await t.stores.workspaces.createWorkspace({
    clientInstanceId,
    kind: "shared",
    name,
    creatorUserId: t.admin.id
  });
  return workspace.id;
}

/** What no kind lets a caller write yet: a skill a workspace owns, put there through the store. */
async function seedWorkspaceSkill(
  t: AccessInstance,
  workspaceId: CollaborationWorkspaceId,
  name: string
) {
  const scope: AssetScope = { kind: "workspace", workspaceId };
  await t.stores.configAssets.applyConfigAssetMutations({
    clientInstanceId,
    mutations: [{ type: "upsert", kind: "skill", name, config: skill(name, "Owned."), scope }]
  });
}

describe("the scope of an asset call", () => {
  it("never reads, lists or writes an asset of another scope without the right on that scope", async () => {
    const t = await setupNamespace();
    const workspaceId = await createWorkspace(t, "Team");
    const otherWorkspaceId = await createWorkspace(t, "Other team");
    // The names lie in Kai's Namespace: only the owner tells them from Kai's own assets.
    await seedWorkspaceSkill(t, workspaceId, "kai-team-notes");
    await seedWorkspaceSkill(t, otherWorkspaceId, "kai-other-notes");
    await t.put(t.kai.id, "skill", "kai-guide");
    // Lena holds the read right on the one workspace, and nothing on the instance.
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.lena.id,
      action: "skill.read",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: workspaceId,
      grantedBy: t.admin.id
    });
    const skills = { params: { kind: "skill" } };
    const inWorkspace = (id: string) => ({ ...skills, query: { workspaceId: id } });
    const address = (name: string, id?: string) => ({
      params: { kind: "skill", name },
      ...(id === undefined ? {} : { query: { workspaceId: id } })
    });
    const notFound = { status: 404, code: "NOT_FOUND" };
    const noRead = t.forbidden("skill.read", "no_grant");

    // Lists: each scope is its own list.
    expect(await t.names(t.admin.id, "assets.list", skills)).toEqual(["kai-guide"]);
    expect(await t.names(t.admin.id, "assets.list", inWorkspace(workspaceId))).toEqual([
      "kai-team-notes"
    ]);
    expect(await t.names(t.kai.id, "assets.list", skills)).toEqual(["kai-guide"]);
    // A Namespace is a prefix among the instance's own assets: it opens no workspace's.
    expect(await t.names(t.kai.id, "assets.list", inWorkspace(workspaceId))).toEqual([]);
    expect(await t.names(t.lena.id, "assets.list", inWorkspace(workspaceId))).toEqual([
      "kai-team-notes"
    ]);
    expect(await t.names(t.lena.id, "assets.list", inWorkspace(otherWorkspaceId))).toEqual([]);
    expect(await t.names(t.lena.id, "assets.list", skills)).toEqual([]);

    // Reads: the asset exists only where its owner is named.
    await t.expectOk(t.admin.id, "assets.get", address("kai-team-notes", workspaceId));
    await t.expectOk(t.lena.id, "assets.get", address("kai-team-notes", workspaceId));
    await t.expectRefused(t.admin.id, "assets.get", address("kai-team-notes"), notFound);
    await t.expectRefused(t.kai.id, "assets.get", address("kai-team-notes"), notFound);
    await t.expectRefused(t.kai.id, "assets.get", address("kai-team-notes", workspaceId), noRead);
    await t.expectRefused(t.lena.id, "assets.get", address("kai-team-notes"), noRead);
    await t.expectRefused(
      t.lena.id,
      "assets.get",
      address("kai-other-notes", otherWorkspaceId),
      noRead
    );
    // Named with the wrong workspace it is not there either.
    await t.expectRefused(
      t.admin.id,
      "assets.get",
      address("kai-team-notes", otherWorkspaceId),
      notFound
    );
    await t.expectRefused(t.kai.id, "assets.revisions.list", address("kai-team-notes"), notFound);
    await t.expectOk(t.lena.id, "assets.revisions.list", address("kai-team-notes", workspaceId));

    // Writes: Kai's write right in the Namespace does not reach the workspace's skill.
    const overwrite = (userId: string, id?: string) =>
      t.call(userId, "assets.put", {
        params: { kind: "skill", name: "kai-team-notes" },
        payload: {
          config: skill("kai-team-notes", "Overwritten."),
          expectedRevision: 1,
          ...(id === undefined ? {} : { workspaceId: id })
        }
      });
    for (const refused of [await overwrite(t.kai.id), await overwrite(t.admin.id)]) {
      expect(refused.statusCode).toBe(422);
      expect(errorSchema.parse(refused.json()).error).toMatchObject({
        code: "VALIDATION_FAILED",
        details: { reason: "invalid_scope" }
      });
    }
    expect((await overwrite(t.kai.id, workspaceId)).statusCode).toBe(403);
    expect((await overwrite(t.lena.id, workspaceId)).statusCode).toBe(403);
    // No kind may be owned by a workspace yet, so the write is refused for the administrator too.
    expect(
      errorSchema.parse((await overwrite(t.admin.id, workspaceId)).json()).error
    ).toMatchObject({ code: "VALIDATION_FAILED", details: { reason: "invalid_scope" } });
    // Kai holds no delete right on skills; the administrator finds no such asset of the instance.
    for (const [userId, status] of [
      [t.kai.id, 403],
      [t.admin.id, 404]
    ] as const) {
      const deleted = await t.call(userId, "assets.delete", {
        params: { kind: "skill", name: "kai-team-notes" },
        payload: { expectedRevision: 1 }
      });
      expect(deleted.statusCode).toBe(status);
    }
    const batch = await t.call(t.admin.id, "assets.sync", {
      payload: {
        namespace: "kai-",
        items: [{ type: "delete", kind: "skill", name: "kai-team-notes", expectedRevision: 1 }]
      }
    });
    expect(batch.statusCode).toBe(422);
    expect(await t.stored("skill", "kai-team-notes")).toMatchObject({
      status: "active",
      revision: 1,
      config: { content: "Owned." },
      scope: { kind: "workspace", workspaceId }
    });
  });

  it("removes what a workspace owns with the workspace, and refuses a delete that would orphan it", async () => {
    const t = await setupNamespace();
    const workspaceId = await createWorkspace(t, "Team");
    await seedWorkspaceSkill(t, workspaceId, "team-notes");
    await t.put(t.admin.id, "skill", "kai-guide");
    const owned = await t.stored("skill", "team-notes");
    if (!owned) throw new Error("The workspace's skill was not stored");
    await t.grant(t.kai.id, "skill.read", { assetId: owned.id }, "deny");
    const versionBefore = (await t.stores.configAssets.getConfigAssetState({ clientInstanceId }))
      .version;

    // The foreign key alone refuses to leave the asset without its owner.
    await expect(
      withTestSql((sql) => sql`delete from collaboration_workspaces where id = ${workspaceId}`)
    ).rejects.toThrow("config_assets_scope_workspace_fk");

    await t.stores.workspaces.deleteWorkspace({
      clientInstanceId,
      collaborationWorkspaceId: workspaceId
    });
    expect(await t.stored("skill", "team-notes")).toBeUndefined();
    expect(await t.stored("skill", "kai-guide")).toMatchObject({ status: "active" });
    const left = await withTestSql(
      (sql) => sql`
        select
          (select count(*)::int from config_asset_revisions where asset_id = ${owned.id}) as revisions,
          (select count(*)::int from permission_grants where scope_id = ${owned.id}) as grants`
    );
    expect({ ...left[0] }).toEqual({ revisions: 0, grants: 0 });
    expect((await t.stores.configAssets.getConfigAssetState({ clientInstanceId })).version).toBe(
      versionBefore + 1
    );
  });
});

describe("assets.validate", () => {
  it("says what a put would be refused for and writes nothing", async () => {
    const t = await setupNamespace();
    const validate = async (userId: string, config: Record<string, unknown>) =>
      z
        .object({ valid: z.boolean(), issues: z.array(z.object({ message: z.string() }).loose()) })
        .parse(
          (
            await t.expectOk(userId, "assets.validate", {
              params: { kind: "agent" },
              payload: { config }
            })
          ).json()
        );

    expect(await validate(t.kai.id, agent("kai-intake"))).toEqual({ valid: true, issues: [] });
    const invalid = await validate(
      t.kai.id,
      agent("kai-intake", { toolNames: ["unknown.tool"], skillNames: ["missing"] })
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.map((issue) => issue.message)).toEqual([
      "Agent 'kai-intake' references missing skill 'missing'",
      "Agent 'kai-intake' references unavailable tool 'unknown.tool'",
      "Agent 'kai-intake' references skills but does not allow 'read_skill'"
    ]);
    const malformed = await validate(t.kai.id, { name: "kai-intake" });
    expect(malformed.valid).toBe(false);
    expect(malformed.issues.length).toBeGreaterThan(0);
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();

    await t.expectRefused(
      t.lena.id,
      "assets.validate",
      { params: { kind: "agent" }, payload: { config: agent("kai-intake") } },
      t.forbidden("agent.read", "no_grant")
    );
  });
});

describe("the validation of a set of assets", () => {
  it("names the issues of a set the registered kinds read in the order and words of the bundle check", async () => {
    const t = await setupNamespace();
    // Everything at once: schema and name issues of both kinds, doubled names, a default that
    // is no agent, and every reference an agent can miss.
    const bundle = {
      agents: [
        agent("first", { toolNames: ["unknown.tool"], skillNames: ["missing"] }),
        agent("first"),
        agent("second", { instructions: "" }),
        agent("third", { modelProviderId: "nowhere" }),
        agent("fourth", { modelProviderId: undefined, modelBindingId: "gone" }),
        agent("fifth", { modelBindingId: "plain" }),
        { displayName: "No name" }
      ],
      skills: [skill("guide"), skill("guide"), { ...skill("empty"), content: "" }, skill("1st")],
      defaultAgentName: "nobody"
    };
    const issuesOf = (error: unknown) =>
      z
        .object({ details: z.object({ issues: z.array(z.record(z.string(), z.unknown())) }) })
        .parse(error).details.issues;

    let expected: Array<Record<string, unknown>> = [];
    try {
      validateConfigAssetBundle({
        ...bundle,
        refs: {
          modelProviderIds: ["local"],
          modelBindingIds: ["plain", "other"],
          fastModeModelBindingIds: [],
          enabledToolNames: ["known.tool", "second.tool"]
        }
      });
    } catch (error) {
      expected = issuesOf(error);
    }
    expect(expected.length).toBeGreaterThan(10);

    // The release check is a service principal's call.
    const refused = await t.instance.call("config_assets.validate", {
      payload: bundle,
      headers: { [SERVICE_HEADER]: "sp_test" }
    });
    expect(refused.statusCode).toBe(422);
    const error = errorSchema.parse(refused.json()).error;
    expect(error.message).toBe("Config asset bundle is invalid");
    expect(issuesOf(error)).toEqual(expected);
  });
});
