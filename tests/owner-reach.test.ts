import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  asCollaborationWorkspaceId,
  asUserId,
  type AssetScope,
  type JsonObject
} from "@work-shape/catalyst-core";
import { agent, errorSchema, skill } from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";
import type { DataStoreInstance } from "./support/data-store-instance";
import { auth, kb, put, seed, store } from "./support/reference-owners";
import { withTestSql } from "./support/test-sql";
import { dataFlowManifest } from "./support/workflow-data-flows";

// The owner check of the 2026-10-28 cross-scope reference audit: something shared never relies
// on or exposes something a Personal Workspace owns. Gaps G1 to G4 each refused here; every one
// of these calls was answered 200 before. A Shared Workspace's asset offered beyond it stays
// allowed (decision, 2026-10-28).

describe("owner reach through the assembled API", () => {
  const { start, person } = useDataStoreInstance();

  async function setup() {
    const world = await start(true, undefined, auth, undefined, true, true);
    const admin = await person(world, "admin", ["user", "admin", "superadmin"]);
    const owner = await person(world, "owner", ["user"]);
    await seed(world, "agent", agent("default"));
    await applyAtCurrentRevisions(world.stores.configAssets, {
      clientInstanceId,
      mutations: [{ type: "setDefaultAgent", agentName: "default" }]
    });
    const shared = (name: string) =>
      world.stores.workspaces.createWorkspace({
        clientInstanceId,
        name,
        kind: "shared",
        creatorUserId: asUserId(admin.id)
      });
    const team = await shared("Team");
    const other = await shared("Other team");
    const personal = await world.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: asUserId(owner.id)
    });
    const mine: AssetScope = { kind: "workspace", workspaceId: personal.id };
    // A person's own agent with their own skill, Knowledge Base, store and a subagent.
    await seed(world, "skill", skill("own-notes"), mine);
    await seed(world, "knowledge_base", kb("own-kb"), mine, true);
    await seed(world, "data_store", store("own-store"), mine);
    await seedHidden(world, agent("own-sub"), mine);
    await seedHidden(
      world,
      agent("own-helper", {
        skillNames: ["own-notes"],
        knowledgeBases: ["own-kb"],
        subagentNames: ["own-sub"]
      }),
      mine
    );
    // The administrator who calls, a member of Team, who may make agents there.
    const caller = asUserId((await world.api.call("me.get", {})).json<{ id: string }>().id);
    const membership = { clientInstanceId, collaborationWorkspaceId: team.id, userId: caller };
    if (!(await world.stores.workspaces.getMembership(membership)))
      await world.stores.workspaces.addMembership({ ...membership, role: "member" });
    return { world, caller, team, other, personal, mine };
  }

  const hidden = { mode: "selected", personalWorkspaces: false, collaborationWorkspaceIds: [] };

  /** An agent stored offered nowhere, as one made in a Personal Workspace starts. */
  async function seedHidden(world: DataStoreInstance, config: JsonObject, scope?: AssetScope) {
    const asset = await seed(world, "agent", config, scope);
    await world.stores.configAssets.setAgentAvailability({
      clientInstanceId,
      kind: "agent",
      agentName: asset.name,
      expectedAssetId: asset.id,
      availability: { mode: "selected", personalWorkspaces: false, collaborationWorkspaceIds: [] }
    });
    return asset;
  }

  const availabilityOf = async (world: DataStoreInstance, kind: string, name: string) =>
    (
      await world.stores.configAssets.listAgentAvailability({
        clientInstanceId,
        kind,
        agentName: name
      })
    ).get(name);

  const setAvailability = (
    world: DataStoreInstance,
    kind: string,
    name: string,
    payload: JsonObject,
    headers: Record<string, string> = {}
  ) => world.api.call("assets.set_availability", { params: { kind, name }, payload, headers });

  it("G1/G2: refuses offering a Personal Workspace's agent, subagent or Knowledge Base in a team, everywhere or in every Personal Workspace", async () => {
    const { world, team } = await setup();
    const offers: JsonObject[] = [
      { mode: "selected", collaborationWorkspaceIds: [team.id] },
      { mode: "all" },
      { mode: "selected", personalWorkspaces: true }
    ];
    for (const [kind, name] of [
      ["agent", "own-helper"],
      ["agent", "own-sub"],
      ["knowledge_base", "own-kb"]
    ] as const) {
      for (const payload of offers) {
        const refused = await setAvailability(world, kind, name, payload);
        expect(refused.statusCode, `${name} ${JSON.stringify(payload)}: ${refused.body}`).toBe(422);
        expect(errorSchema.parse(refused.json()).error.details).toMatchObject({
          reason: "owner_reach",
          asset: { kind, name }
        });
      }
      // Nothing was offered: Team's members see no agent of it and hold no use of the KB.
      const left = await availabilityOf(world, kind, name);
      if (kind === "agent") expect(left).toEqual(hidden);
      else expect(left).toBeUndefined();
      // Offered nowhere is still a change an admin may make, such as to take a legacy offer back.
      const nowhere = await setAvailability(world, kind, name, { mode: "selected" });
      expect(nowhere.statusCode, nowhere.body).toBe(200);
    }
  });

  it("G1: words the refusal with the ladder's words and the next step, in EN and DE", async () => {
    const { world, team } = await setup();
    const say = async (locale: string) =>
      errorSchema.parse(
        (
          await setAvailability(
            world,
            "agent",
            "own-helper",
            { mode: "selected", collaborationWorkspaceIds: [team.id] },
            { "accept-language": locale }
          )
        ).json()
      ).error.message;
    expect(await say("en")).toBe(
      `Agent 'own-helper' is in a Personal Workspace ("Only me") and is used only there, not in a team or by everyone. Create it in a Shared Workspace or for everyone, or ask an admin.`
    );
    expect(await say("de")).toBe(
      "Agent 'own-helper' liegt unter „Nur ich“, in einem persönlichen Arbeitsbereich, und wird nur dort genutzt, nicht in einem Team oder von Allen. Lege das in einem Team-Arbeitsbereich oder für Alle an, oder bitte einen Admin darum."
    );
  });

  it("G2: the dependency branch never widens a Personal Workspace's Knowledge Base, and rolls the agent back", async () => {
    const { world, team } = await setup();
    // A legacy agent of the instance that names the personal KB: no save makes one any more.
    const legacy = await seedHidden(world, agent("legacy-agent", { knowledgeBases: ["own-kb"] }));
    const refused = await setAvailability(world, "agent", "legacy-agent", {
      mode: "selected",
      collaborationWorkspaceIds: [team.id],
      makeDependenciesAvailable: true,
      expectedRevision: legacy.revision
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(errorSchema.parse(refused.json()).error.details).toMatchObject({
      reason: "owner_reach",
      asset: { kind: "knowledge_base", name: "own-kb" }
    });
    expect(await availabilityOf(world, "knowledge_base", "own-kb")).toBeUndefined();
    expect(await availabilityOf(world, "agent", "legacy-agent")).toEqual(hidden);
  });

  it("G1: refuses creating a Personal Workspace's agent offered everywhere or in a team", async () => {
    const { world, caller, team } = await setup();
    const own = await world.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: caller
    });
    const create = (name: string, availableIn?: JsonObject | "all") =>
      world.api.call("assets.put", {
        params: { kind: "agent", name },
        payload: {
          config: agent(name),
          expectedRevision: null,
          workspaceId: own.id,
          ...(availableIn === undefined ? {} : { availableIn })
        }
      });
    for (const availableIn of ["all", { workspaceId: team.id }] as const) {
      const refused = await create("admin-own", availableIn);
      expect(refused.statusCode, refused.body).toBe(422);
      expect(errorSchema.parse(refused.json()).error.details).toMatchObject({
        reason: "owner_reach"
      });
      expect(
        await world.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "agent",
          name: "admin-own"
        })
      ).toBeUndefined();
    }
    // Made where it belongs, it starts hidden, as before.
    const made = await create("admin-own");
    expect(made.statusCode, made.body).toBe(200);
    expect(await availabilityOf(world, "agent", "admin-own")).toEqual(hidden);
  });

  it("keeps a Shared Workspace's agent offered in another Shared Workspace or everywhere (decision, not a gap)", async () => {
    const { world, team, other } = await setup();
    const scope: AssetScope = { kind: "workspace", workspaceId: team.id };
    await seed(world, "skill", skill("team-notes"), scope);
    await seed(world, "agent", agent("team-helper", { skillNames: ["team-notes"] }), scope);
    const offers: JsonObject[] = [
      { mode: "selected", collaborationWorkspaceIds: [other.id] },
      { mode: "all" }
    ];
    for (const payload of offers) {
      const offered = await setAvailability(world, "agent", "team-helper", payload);
      expect(offered.statusCode, offered.body).toBe(200);
    }
  });

  it("counts existing owner-reach violations read-only: offers and instance Workflow references", async () => {
    const { world, team, other } = await setup();
    const offer = async (kind: string, name: string, availability: JsonObject) => {
      const asset = await world.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind,
        name
      });
      await world.stores.configAssets.setAgentAvailability({
        clientInstanceId,
        kind,
        agentName: name,
        ...(asset ? { expectedAssetId: asset.id } : {}),
        availability: {
          mode: availability.mode === "all" ? "all" : "selected",
          personalWorkspaces: availability.personalWorkspaces === true,
          collaborationWorkspaceIds: Array.isArray(availability.collaborationWorkspaceIds)
            ? availability.collaborationWorkspaceIds.map((id) =>
                asCollaborationWorkspaceId(String(id))
              )
            : []
        }
      });
    };
    // Legacy state no write makes any more, stored as it was left.
    await offer("agent", "own-helper", { mode: "all" });
    await offer("agent", "own-sub", { personalWorkspaces: true });
    await offer("knowledge_base", "own-kb", { collaborationWorkspaceIds: [team.id] });
    await seed(world, "workflow", {
      name: "reaching-flow",
      manifest: dataFlowManifest("reaching-flow", [
        "data_store.own-store.query",
        "knowledge.own-kb.search"
      ])
    });
    // Allowed and so not counted: offered nowhere, a team's agent offered in another team, an
    // instance Workflow reaching a team's store.
    await offer("agent", "default", { mode: "all" });
    const teamScope: AssetScope = { kind: "workspace", workspaceId: team.id };
    await seed(world, "agent", agent("team-helper"), teamScope);
    await offer("agent", "team-helper", { collaborationWorkspaceIds: [other.id] });
    await seed(world, "data_store", store("team-store"), teamScope);
    await seed(world, "workflow", {
      name: "team-flow",
      manifest: dataFlowManifest("team-flow", ["data_store.team-store.query"])
    });
    const query = await readFile(
      new URL("../scripts/preflight-owner-reach.sql", import.meta.url),
      "utf8"
    );
    const rows = await withTestSql(async (sql) =>
      sql.begin("read only", (transaction) =>
        transaction.unsafe(query.replace("BEGIN READ ONLY;", "").replace("COMMIT;", ""))
      )
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      offers: "3",
      references: "2",
      violations: [
        { violation: "offer", source_kind: "agent", source_name: "own-helper", offered_in: "all" },
        {
          violation: "offer",
          source_kind: "agent",
          source_name: "own-sub",
          offered_in: "personal_workspaces"
        },
        {
          violation: "offer",
          source_kind: "knowledge_base",
          source_name: "own-kb",
          offered_in: "shared_workspaces"
        },
        {
          violation: "reference",
          source_name: "reaching-flow",
          target_kind: "data_store",
          target_name: "own-store"
        },
        {
          violation: "reference",
          source_name: "reaching-flow",
          target_kind: "knowledge_base",
          target_name: "own-kb"
        }
      ]
    });
    // The references preflight counts the same Workflow pairs, and still not the team's.
    const references = await readFile(
      new URL("../scripts/preflight-reference-owners.sql", import.meta.url),
      "utf8"
    );
    const counted = await withTestSql(async (sql) =>
      sql.begin("read only", (transaction) =>
        transaction.unsafe(references.replace("BEGIN READ ONLY;", "").replace("COMMIT;", ""))
      )
    );
    expect(counted[0]).toMatchObject({ refused_references: "2", affected_assets: "1" });
  });

  it("G4: refuses an instance Workflow naming a Personal Workspace's Data Store, Knowledge Base, App action or App link", async () => {
    const { world, personal, mine } = await setup();
    await seed(
      world,
      "app",
      {
        name: "own-app",
        title: "Own App",
        manifest: {
          actions: [
            {
              name: "load",
              file: "actions/load.action.yaml",
              kind: "connection",
              effect: "reading",
              connection: "source",
              operation: "echo",
              input: { schema: { type: "object", properties: {} }, mapping: {} }
            }
          ]
        }
      },
      mine,
      true
    );
    const calling = (name: string, operation: string) =>
      dataFlowManifest(name, [operation], { kind: "process" });
    const linking: JsonObject = {
      ...dataFlowManifest("flow-link", [], { kind: "process" }),
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "tell",
          name: "Tell",
          type: "notify",
          to: { users: ["admin"] },
          channels: ["inbox"],
          title: { value: "Ready" },
          text: { value: "Ready" },
          link: { kind: "app", app: "own-app", workspaceId: personal.id }
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    };
    const flows: { name: string; target: { kind: string; name: string }; manifest: JsonObject }[] =
      [
        {
          name: "flow-store",
          target: { kind: "data_store", name: "own-store" },
          manifest: calling("flow-store", "data_store.own-store.query")
        },
        {
          name: "flow-kb",
          target: { kind: "knowledge_base", name: "own-kb" },
          manifest: calling("flow-kb", "knowledge.own-kb.search")
        },
        {
          name: "flow-app",
          target: { kind: "app", name: "own-app" },
          manifest: calling("flow-app", "app.own-app.load")
        },
        { name: "flow-link", target: { kind: "app", name: "own-app" }, manifest: linking }
      ];
    for (const { name, target, manifest } of flows) {
      for (const locale of ["en", "de"]) {
        const refused = await put(world, "workflow", { name, manifest }, undefined, {
          "accept-language": locale
        });
        expect(refused.statusCode, `${name}: ${refused.body}`).toBe(422);
        const error = errorSchema.parse(refused.json()).error;
        expect(error.details).toMatchObject({
          reason: "invalid_scope",
          reference: { ...target, owner: mine, reach: "personal" }
        });
        expect(error.message).toContain(locale === "de" ? "„Nur ich“" : `"Only me"`);
      }
    }
  });
});
