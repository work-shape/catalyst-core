import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SKILL_NAME_RULE, validateConfigAssetBundle } from "@work-shape/catalyst-config-schema";
import type { AssetScope, CollaborationWorkspaceId } from "@work-shape/catalyst-core";
import {
  SERVICE_HEADER,
  agent,
  clientInstanceId,
  errorSchema,
  skill,
  type AccessInstance
} from "./support/access-instance";
import { setupWorkspaceHolder as setup } from "./support/asset-operations";
import { required } from "./support/assertions";
import { withTestSql } from "./support/test-sql";
import { applyAtCurrentRevisions } from "./support/asset-revisions";

// What an asset call may reach when a workspace owns assets beside the instance, and what a
// definition is checked for before it is written.

/** A skill a workspace owns, put there through the store. */
async function seedWorkspaceSkill(
  t: AccessInstance,
  workspaceId: CollaborationWorkspaceId,
  name: string
) {
  const scope: AssetScope = { kind: "workspace", workspaceId };
  await applyAtCurrentRevisions(t.stores.configAssets, {
    clientInstanceId,
    mutations: [{ type: "upsert", kind: "skill", name, config: skill(name, "Owned."), scope }]
  });
}

describe("the scope of an asset call", () => {
  it("never reads, lists or writes an asset of another scope without the right on that scope", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Team");
    const otherWorkspaceId = await t.sharedWorkspace("Other team");
    // Two workspaces Kai holds nothing in own a skill each; so do Kai's workspace and the
    // instance.
    await seedWorkspaceSkill(t, workspaceId, "kai-team-notes");
    await seedWorkspaceSkill(t, otherWorkspaceId, "kai-other-notes");
    await t.put(t.kai.id, "skill", "kai-guide", t.kaiTeam);
    await t.put(t.admin.id, "skill", "guide");
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
    expect(await t.names(t.admin.id, "assets.list", skills)).toEqual(["guide"]);
    expect(await t.names(t.admin.id, "assets.list", inWorkspace(workspaceId))).toEqual([
      "kai-team-notes"
    ]);
    expect(await t.names(t.kai.id, "assets.list", inWorkspace(t.kaiTeam))).toEqual(["kai-guide"]);
    // Kai's rights in his own workspace open neither another workspace nor the instance.
    expect(await t.names(t.kai.id, "assets.list", inWorkspace(workspaceId))).toEqual([]);
    expect(await t.names(t.kai.id, "assets.list", skills)).toEqual([]);
    expect(await t.names(t.lena.id, "assets.list", inWorkspace(workspaceId))).toEqual([
      "kai-team-notes"
    ]);
    expect(await t.names(t.lena.id, "assets.list", inWorkspace(otherWorkspaceId))).toEqual([]);
    expect(await t.names(t.lena.id, "assets.list", skills)).toEqual([]);

    // Reads: the asset exists only where its owner is named.
    await t.expectOk(t.admin.id, "assets.get", address("kai-team-notes", workspaceId));
    await t.expectOk(t.lena.id, "assets.get", address("kai-team-notes", workspaceId));
    await t.expectRefused(t.admin.id, "assets.get", address("kai-team-notes"), notFound);
    await t.expectRefused(t.kai.id, "assets.get", address("kai-team-notes", t.kaiTeam), notFound);
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
    await t.expectRefused(
      t.kai.id,
      "assets.revisions.list",
      address("kai-team-notes", t.kaiTeam),
      notFound
    );
    await t.expectOk(t.lena.id, "assets.revisions.list", address("kai-team-notes", workspaceId));

    // Writes: Kai's write right in his own workspace does not reach another workspace's skill.
    const overwrite = (userId: string, id?: string) =>
      t.call(userId, "assets.put", {
        params: { kind: "skill", name: "kai-team-notes" },
        payload: {
          config: skill("kai-team-notes", "Overwritten."),
          expectedRevision: 1,
          ...(id === undefined ? {} : { workspaceId: id })
        }
      });
    // Kai does not read the workspace's skill and is told the name alone, as for any write
    // against another revision. The administrator reads it and is told where the name is.
    const untold = await overwrite(t.kai.id, t.kaiTeam);
    expect(untold.statusCode).toBe(412);
    expect(errorSchema.parse(untold.json()).error.details).toEqual({
      reason: "revision_conflict",
      conflicts: [{ kind: "skill", name: "kai-team-notes" }]
    });
    const told = await overwrite(t.admin.id);
    expect(told.statusCode).toBe(422);
    expect(errorSchema.parse(told.json()).error).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reason: "invalid_scope" }
    });
    expect((await overwrite(t.kai.id, workspaceId)).statusCode).toBe(403);
    expect((await overwrite(t.lena.id, workspaceId)).statusCode).toBe(403);
    // Named with its workspace, the administrator writes it: a workspace owns skills (WS-OWN-1a).
    expect((await overwrite(t.admin.id, workspaceId)).statusCode).toBe(200);
    // Kai holds no delete right on skills; the administrator finds no such asset of the instance.
    for (const [userId, owner, status] of [
      [t.kai.id, { workspaceId: t.kaiTeam }, 403],
      [t.admin.id, {}, 404]
    ] as const) {
      const deleted = await t.call(userId, "assets.delete", {
        params: { kind: "skill", name: "kai-team-notes" },
        payload: { expectedRevision: 1, ...owner }
      });
      expect(deleted.statusCode).toBe(status);
    }
    // A batch of another workspace does not reach it either.
    const batch = await t.call(t.admin.id, "assets.sync", {
      payload: {
        workspaceId: t.kaiTeam,
        items: [{ type: "delete", kind: "skill", name: "kai-team-notes", expectedRevision: 2 }]
      }
    });
    expect(batch.statusCode).toBe(422);
    // The administrator's write of the team's skill is its draft (SKILL-DRAFT-1): live stays.
    expect(await t.stored("skill", "kai-team-notes")).toMatchObject({
      status: "active",
      revision: 1,
      scope: { kind: "workspace", workspaceId }
    });
    expect(
      (
        await t.stores.agentProposals.get({
          clientInstanceId,
          agentId: required(await t.stored("skill", "kai-team-notes")).id
        })
      )?.config
    ).toMatchObject({ content: "Overwritten." });
  });

  it("removes what a workspace owns with the workspace, and refuses a delete that would orphan it", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Team");
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
    const t = await setup();
    const validate = async (userId: string, config: Record<string, unknown>) =>
      z
        .object({ valid: z.boolean(), issues: z.array(z.object({ message: z.string() }).loose()) })
        .parse(
          (
            await t.expectOk(userId, "assets.validate", {
              params: { kind: "agent" },
              payload: { config, workspaceId: t.kaiTeam }
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
      "Agent 'kai-intake' references unavailable tool 'unknown.tool' in toolNames[0]",
      "Agent 'kai-intake' references skills but does not allow 'read_skill'"
    ]);
    const malformed = await validate(t.kai.id, { name: "kai-intake" });
    expect(malformed.valid).toBe(false);
    expect(malformed.issues.length).toBeGreaterThan(0);
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();

    await t.expectRefused(
      t.lena.id,
      "assets.validate",
      {
        params: { kind: "agent" },
        payload: { config: agent("kai-intake"), workspaceId: t.kaiTeam }
      },
      t.forbidden("agent.read", "no_grant")
    );
  });
});

describe("assets.check_name", () => {
  it("says before a create whether the name breaks the kind's rule or is taken, and writes nothing", async () => {
    const t = await setup();
    const inKai = { workspaceId: t.kaiTeam };
    const check = async (userId: string, kind: "agent" | "skill", name: string) =>
      (
        await t.expectOk(userId, "assets.check_name", {
          params: { kind },
          payload: { name, ...inKai }
        })
      ).json();

    expect(await check(t.kai.id, "skill", "kai-guide")).toEqual({ available: true });
    expect(await t.stored("skill", "kai-guide")).toBeUndefined();
    // The skill's own rule decides, in the words a refused put uses.
    expect(await check(t.kai.id, "skill", "kai-two words")).toEqual({
      available: false,
      reason: "name_invalid",
      message: SKILL_NAME_RULE
    });
    const put = await t.put(t.kai.id, "agent", "kai-helper", t.kaiTeam);
    expect(await check(t.kai.id, "agent", "kai-helper")).toEqual({
      available: false,
      reason: "name_taken",
      message: "Config agent 'kai-helper' is not at the revision the call names"
    });
    // A fresh create names null, so a deleted asset still reserves its name.
    const { revision } = z.object({ revision: z.number() }).parse(put.json());
    await t.expectOk(t.kai.id, "assets.delete", {
      params: { kind: "agent", name: "kai-helper" },
      payload: { expectedRevision: revision, ...inKai }
    });
    expect(await check(t.kai.id, "agent", "kai-helper")).toMatchObject({
      available: false,
      reason: "name_taken"
    });

    // The right is the one a create asks, in the owner the call names.
    for (const owner of [{ workspaceId: t.lenaTeam }, {}]) {
      await t.expectRefused(
        t.kai.id,
        "assets.check_name",
        { params: { kind: "agent" }, payload: { name: "lena-helper", ...owner } },
        t.forbidden("agent.write", "no_grant")
      );
    }
    // The put still refuses what the check refused.
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      {
        params: { kind: "skill", name: "kai-two words" },
        payload: { config: skill("kai-two words"), expectedRevision: null, ...inKai }
      },
      { status: 422, code: "VALIDATION_FAILED" }
    );
  });

  it("tells a write-only caller exactly the create refusal for unreadable active and deleted names", async () => {
    const t = await setup();
    const inLena = { workspaceId: t.lenaTeam };
    const check = (name: string) =>
      t.call(t.lena.id, "assets.check_name", {
        params: { kind: "agent" },
        payload: { name, ...inLena }
      });
    for (const name of ["lena-private", "lena-free"]) {
      await t.expectRefused(
        t.lena.id,
        "assets.check_name",
        { params: { kind: "agent" }, payload: { name, ...inLena } },
        t.forbidden("agent.write", "no_grant")
      );
    }
    // Lena writes the agents of her workspace and reads none.
    await t.grant(t.lena.id, "agent.write", inLena);
    const workspaceId = await t.sharedWorkspace("Confidential workspace");
    for (const owner of [t.lenaTeam, workspaceId]) {
      const name = owner === t.lenaTeam ? "lena-private" : "lena-private-elsewhere";
      const scope = { workspaceId: owner };
      const params = { kind: "agent", name };
      await t.expectOk(t.admin.id, "assets.put", {
        params,
        payload: {
          ...scope,
          config: agent(name, { displayName: "Confidential title" }),
          expectedRevision: null
        }
      });
      await t.expectRefused(
        t.lena.id,
        "assets.get",
        { params, query: inLena },
        t.forbidden("agent.read", "no_grant")
      );
      const create = () =>
        t.expectRefused(
          t.lena.id,
          "assets.put",
          { params, payload: { config: agent(name), expectedRevision: null, ...inLena } },
          { status: 412, code: "REVISION_CONFLICT" }
        );
      const activeCreate = await create();
      const activeCheck = await check(name);
      expect(activeCheck.statusCode).toBe(200);
      expect(activeCheck.json()).toEqual({
        available: false,
        reason: "name_taken",
        message: activeCreate.message
      });
      const stored = await t.stored("agent", name);
      await t.expectOk(t.admin.id, "assets.delete", {
        params,
        payload: { ...scope, expectedRevision: stored?.revision }
      });
      expect(await create()).toEqual(activeCreate);
      expect((await check(name)).json()).toEqual(activeCheck.json());
    }
    expect((await check("lena-free")).json()).toEqual({ available: true });
    await t.expectOk(t.lena.id, "assets.put", {
      params: { kind: "agent", name: "lena-free" },
      payload: { config: agent("lena-free"), expectedRevision: null, ...inLena }
    });
  });

  it("uses creation's name validation and reason, including dot names and unstorable text", async () => {
    const t = await setup();
    for (const name of [".", "..", "", "bad\ud800name"]) {
      const validation = z
        .object({ valid: z.literal(false), issues: z.array(z.object({ message: z.string() })) })
        .parse(
          (
            await t.expectOk(t.admin.id, "assets.validate", {
              params: { kind: "agent" },
              payload: { config: agent(name) }
            })
          ).json()
        );
      const answer = await t.expectOk(t.admin.id, "assets.check_name", {
        params: { kind: "agent" },
        payload: { name }
      });
      expect(answer.json()).toEqual({
        available: false,
        reason: "name_invalid",
        message: validation.issues[0]?.message
      });
    }
    // The check has no extra length rule: an agent may use a long name, while a skill still
    // refuses a space beyond the old check-only cap with creation's own reason.
    const longName = "a".repeat(201);
    expect(
      (
        await t.expectOk(t.admin.id, "assets.validate", {
          params: { kind: "agent" },
          payload: { config: agent(longName) }
        })
      ).json()
    ).toMatchObject({ valid: true });
    expect(
      (
        await t.expectOk(t.admin.id, "assets.check_name", {
          params: { kind: "agent" },
          payload: { name: longName }
        })
      ).json()
    ).toEqual({ available: true });
    const invalidSkillName = `${longName} `;
    const invalidSkill = z.object({ issues: z.array(z.object({ message: z.string() })) }).parse(
      (
        await t.expectOk(t.admin.id, "assets.validate", {
          params: { kind: "skill" },
          payload: { config: skill(invalidSkillName) }
        })
      ).json()
    );
    expect(
      (
        await t.expectOk(t.admin.id, "assets.check_name", {
          params: { kind: "skill" },
          payload: { name: invalidSkillName }
        })
      ).json()
    ).toEqual({
      available: false,
      reason: "name_invalid",
      message: invalidSkill.issues[0]?.message
    });
    const name = "bad\u0000name";
    const validateError = await t.expectRefused(
      t.admin.id,
      "assets.validate",
      {
        params: { kind: "agent" },
        payload: { config: agent(name) }
      },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    const checkError = await t.expectRefused(
      t.admin.id,
      "assets.check_name",
      {
        params: { kind: "agent" },
        payload: { name }
      },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    const reasons = (details: unknown) =>
      z
        .object({ issues: z.array(z.object({ message: z.string() })) })
        .parse(details)
        .issues.map(({ message }) => message);
    expect(reasons(checkError.details)).toEqual(reasons(validateError.details));
  });
});

describe("the validation of a set of assets", () => {
  it("names the issues of a release in the order and words of the bundle check", async () => {
    const t = await setup();
    // Everything a batch can carry at once: schema and name issues of both kinds, a default
    // that is no agent, and every reference an agent can miss.
    const bundle = {
      agents: [
        agent("first", { toolNames: ["unknown.tool"], skillNames: ["missing"] }),
        agent("second", { instructions: "" }),
        agent("third", { modelProviderId: "nowhere" }),
        agent("fourth", { modelProviderId: undefined, modelBindingId: "gone" }),
        agent("fifth", { modelBindingId: "plain" })
      ],
      skills: [skill("guide"), { ...skill("empty"), content: "" }, skill("-first")],
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
        // The assets the instance holds beside the batch.
        agents: [...bundle.agents, agent("assistant"), agent("kai-old")],
        skills: [...bundle.skills, skill("kai-guide")],
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
    expect(expected.length).toBeGreaterThan(6);

    // The check of a release reads the same set through the registered kinds.
    const response = await t.instance.call("assets.sync_check", {
      payload: {
        items: [
          ...bundle.agents.map((config) => ({
            type: "put",
            kind: "agent",
            config,
            expectedRevision: null
          })),
          ...bundle.skills.map((config) => ({
            type: "put",
            kind: "skill",
            config,
            expectedRevision: null
          }))
        ],
        defaultAgentName: bundle.defaultAgentName
      },
      headers: { [SERVICE_HEADER]: "sp_test" }
    });
    expect(response.statusCode, response.body).toBe(422);
    const error = errorSchema.parse(response.json()).error;
    // What is wrong with one definition refuses its item, and what is wrong with the set is
    // an issue of the batch: together they are the bundle check's issues, in its order.
    const refused = z
      .object({
        items: z.array(
          z.object({
            kind: z.string(),
            name: z.string().optional(),
            error: z.object({ message: z.string() }).optional()
          })
        )
      })
      .parse(error.details)
      .items.flatMap((item) =>
        item.error ? [`${item.kind} ${item.name}: ${item.error.message}`] : []
      );
    const ofOneAsset = expected.filter((issue) => "assetKind" in issue);
    expect(refused).toEqual(
      ofOneAsset.map(
        (issue) =>
          `${String(issue.assetKind)} ${String(issue.assetName)}: ${z.array(z.string()).parse(issue.path).join(".")}: ${String(issue.message)}`
      )
    );
    expect(refused).toHaveLength(3);
    expect(issuesOf(error)).toEqual(expected.filter((issue) => !("assetKind" in issue)));
  });
});
