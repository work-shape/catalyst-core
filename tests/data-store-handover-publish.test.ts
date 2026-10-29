import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asUserId,
  type CollaborationWorkspaceId,
  type JsonObject
} from "@work-shape/catalyst-core";
import { agent } from "./support/access-instance";
import { required } from "./support/assertions";
import {
  clientInstanceId,
  useDataStoreInstance,
  type DataStoreInstance
} from "./support/data-store-instance";
import { getTestJobs } from "./support/test-instance";

// DS-13c on an assembled instance (check 68): the widening check runs on the server, inside
// every change that widens who reads a store's rows or adds a source. A change that hands a
// source's data to people who may not use it waits in the Inbox until a person who holds
// `connection.write` on the source approves it; that approval is the confirmation. Such a
// person who makes the change themselves confirms it with the token the question gives. A key
// never confirms. The question counts the people and never names them.

const refusalSchema = z.object({
  error: z.object({
    code: z.string(),
    details: z.object({ reason: z.string() }).loose()
  })
});
const heldSchema = z.looseObject({
  status: z.literal("pending_approval"),
  approvalRequestId: z.string()
});
const questionSchema = z.object({
  publishHandover: z.object({
    holds: z.boolean(),
    lines: z.array(z.string()),
    confirmation: z.string().optional()
  })
});

/** A person the development sign-in knows, resolved to the same row as `person` resolves. */
const devUser = (id: string, roles: string[]) => ({
  id,
  externalUserId: id,
  displayLabel: id,
  roles,
  permissionRefs: [],
  authSource: "test"
});
const developmentAuth = {
  enabled: true,
  users: [
    devUser("user-1", ["user", "admin", "superadmin"]),
    devUser("reviewer", ["user"]),
    devUser("keeper", ["user"])
  ]
};
const as = (id: string) => ({ "x-dev-user-id": id });

const importing = (name: string, connection: string, store = "findings"): JsonObject => ({
  name,
  manifest: {
    id: name,
    name: `Import ${connection}`,
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "read",
        name: "Read",
        type: "operation",
        operation: `connection.${connection}.list`,
        input: {}
      },
      {
        id: "store",
        name: "Store",
        type: "operation",
        operation: `data_store.${store}.insert`,
        input: {}
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  }
});
/** A Connection whose one call an agent may be given. */
const connectionOf = (name: string, displayName: string): JsonObject => ({
  name,
  displayName,
  connectorType: "http_api",
  origin: "release",
  enabled: true,
  ownerPrincipalId: "system",
  authScheme: "none",
  credentialMode: "shared",
  settings: { baseUrl: "https://example.com" },
  operations: [
    {
      name: "list",
      enabled: true,
      effect: "reading",
      exposure: ["agent"],
      method: "GET",
      path: "/list"
    }
  ]
});
const overview: JsonObject = {
  title: "Overview",
  manifest: {
    actions: [
      {
        name: "list",
        kind: "sql",
        dataStore: "findings",
        effect: "reading",
        statement: "select * from findings"
      }
    ]
  }
};

describe("the widening check inside a change", () => {
  const { start, publishStore, person } = useDataStoreInstance();

  /** A team of three who read the store through an App, and the instance's Connections. */
  async function team(world: DataStoreInstance) {
    await publishStore(world);
    const { stores } = world;
    const members = await Promise.all(
      ["member-a", "member-b", "member-c"].map((name) => person(world, name, ["user"]))
    );
    const workspace = await stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Team",
      creatorUserId: asUserId(required(members[0]).id)
    });
    for (const member of members.slice(1)) {
      await stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspace.id,
        userId: asUserId(member.id),
        role: "member"
      });
    }
    const connections = await stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "connection:exampledata": null, "connection:crm": null },
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "exampledata",
          config: connectionOf("exampledata", "Exampledata")
        },
        { type: "upsert", kind: "connection", name: "crm", config: connectionOf("crm", "CRM") }
      ]
    });

    /** Writes an asset's revision, and makes it live where `live`. */
    async function write(
      kind: string,
      name: string,
      config: JsonObject,
      live?: { workspaceId?: CollaborationWorkspaceId }
    ) {
      const key = `${kind}:${name}`;
      const current = await stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
      const saved = await stores.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { [key]: current?.revision ?? null },
        mutations: [
          {
            type: "upsert",
            kind,
            name,
            config,
            draft: true,
            ...(live?.workspaceId
              ? { scope: { kind: "workspace", workspaceId: live.workspaceId } }
              : {})
          }
        ]
      });
      const revision = required(saved.revisions[key]);
      if (live) {
        const stored = required(
          await stores.configAssets.getConfigAssetRevision({
            clientInstanceId,
            kind,
            name,
            revision
          })
        );
        await stores.configAssets.publishConfigAssetRevision({
          clientInstanceId,
          kind,
          name,
          assetId: required(saved.assetIds[key]),
          revision,
          revisionId: stored.id,
          ...(live.workspaceId && kind === "app" ? { audience: "workspace" as const } : {})
        });
      }
      return revision;
    }

    const grant = async (name: string, action: string, scopeId?: string) =>
      stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: (await person(world, name, ["user"])).id,
        action,
        effect: "allow",
        scopeKind: scopeId ? "asset" : "instance",
        ...(scopeId ? { scopeId } : {}),
        grantedBy: asUserId("usr_handover_admin")
      });
    const handedOver = async () =>
      (await stores.audit.listAuditEvents({ clientInstanceId })).filter(
        (event) => event.type === "data_store.handover_confirmed"
      );
    return {
      members,
      workspace,
      write,
      grant,
      handedOver,
      exampledata: required(connections.assetIds["connection:exampledata"]),
      crm: required(connections.assetIds["connection:crm"])
    };
  }

  it("holds an unconfirmed hand-over for a person who may change the source, and lets only a person confirm", async () => {
    const world = await start(
      true,
      undefined,
      developmentAuth,
      undefined,
      { apiAccess: true },
      true
    );
    const { stores } = world;
    const { members, workspace, write, grant, handedOver, crm } = await team(world);
    // The team reads the store's rows through its App.
    await write("app", "overview", overview, { workspaceId: workspace.id });
    // A Workflow would add rows to the store from a Connection the team may not use.
    const revision = await write("workflow", "import", importing("import", "exampledata"));

    // The question names how many of the team may not use the source, and the confirmation.
    const read = await world.api.call("assets.get", {
      params: { kind: "workflow", name: "import" },
      query: { revision: String(revision) }
    });
    expect(read.statusCode, read.body).toBe(200);
    const question = questionSchema.parse(read.json()).publishHandover;
    // In the instance's language, here its English.
    expect(question).toMatchObject({
      holds: false,
      lines: [
        "3 people who read “Findings” after this publish may not use “Exampledata”. Publishing confirms the hand-over."
      ]
    });
    const confirmation = required(question.confirmation);
    for (const member of members) {
      expect(read.body).not.toContain(member.id);
      expect(read.body).not.toContain(member.displayLabel);
    }

    const publish = (
      name: string,
      at: number,
      confirmHandover?: string,
      headers: Record<string, string> = as("user-1")
    ) =>
      world.api.call("assets.publish", {
        params: { kind: "workflow", name },
        payload: { revision: at, ...(confirmHandover ? { confirmHandover } : {}) },
        headers
      });
    const live = async (name: string) =>
      (await stores.configAssets.getConfigAsset({ clientInstanceId, kind: "workflow", name }))
        ?.publishedRevisionId;

    // A confirmation of another hand-over is refused with the current one.
    const other = await publish("import", revision, "0".repeat(64));
    expect(other.statusCode, other.body).toBe(409);
    expect(refusalSchema.parse(other.json()).error).toMatchObject({
      code: "CONFLICT",
      details: {
        reason: "data_handover_unconfirmed",
        dataStore: "findings",
        readers: 3,
        connection: "exampledata",
        confirmation
      }
    });

    // A key confirms nothing, though its holder holds connection.write.
    const issued = await world.api.call("me.api_keys.create", {
      payload: {
        name: "Publisher key",
        scopes: [
          "workflow.read",
          "workflow.publish",
          "data_store.read",
          "data_store.insert",
          "connection.use"
        ],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      },
      headers: as("user-1")
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const exchanged = await world.api.call("access_tokens.exchange", {
      headers: { authorization: `Bearer ${issued.json<{ secret: string }>().secret}` }
    });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    const byKey = await publish("import", revision, confirmation, {
      authorization: `Bearer ${exchanged.json<{ accessToken: string }>().accessToken}`
    });
    expect(byKey.statusCode, byKey.body).toBe(403);
    expect(refusalSchema.parse(byKey.json()).error.details.reason).toBe(
      "data_handover_person_only"
    );
    expect(await live("import")).toBeFalsy();

    // The person who may change the source confirms it with the token: it goes live at once and
    // the hand-over is audited by how many, never whom.
    const confirmed = await publish("import", revision, confirmation);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(await live("import")).toBeTruthy();
    const direct = await handedOver();
    expect(direct).toHaveLength(1);
    expect(JSON.stringify(direct)).toContain('"people":3');
    expect(JSON.stringify(direct)).toContain('"confirmedBy":"caller"');
    for (const member of members) expect(JSON.stringify(direct)).not.toContain(member.id);

    // Published again, the Workflow hands nothing on anew: the question holds in one line.
    const again = await world.api.call("assets.get", {
      params: { kind: "workflow", name: "import" },
      query: { revision: String(revision) }
    });
    expect(again.json()).toMatchObject({
      publishHandover: {
        holds: true,
        lines: ["This publish hands data from “Exampledata” to nobody new who may not use it."]
      }
    });

    // A second source, published without a confirmation, waits in the Inbox: no policy lets it
    // through, and the instance admin who filed it is no exception.
    const second = await write("workflow", "import-crm", importing("import-crm", "crm"));
    const held = await publish("import-crm", second);
    expect(held.statusCode, held.body).toBe(202);
    const { approvalRequestId } = heldSchema.parse(held.json());
    expect(await live("import-crm")).toBeFalsy();

    const decide = async (userId: string) => {
      const response = await world.api.call("approval_requests.decide", {
        params: { requestId: approvalRequestId },
        payload: { decision: "approve" },
        headers: as(userId)
      });
      await getTestJobs(world.api).runDue();
      return response;
    };
    // The Workflow's publish review asks its approver; one who may not change the source
    // cannot decide it.
    await grant("reviewer", "workflow.approve");
    const refused = await decide("reviewer");
    expect(refused.statusCode, refused.body).toBe(403);
    expect(await live("import-crm")).toBeFalsy();
    // One who holds connection.write on it can: the approval is the confirmation.
    await grant("keeper", "workflow.approve");
    await grant("keeper", "connection.write", crm);
    const approved = await decide("keeper");
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await live("import-crm")).toBeTruthy();
    const both = await handedOver();
    expect(both).toHaveLength(2);
    const byApprover = JSON.stringify(both.find((event) => event.id !== direct[0]?.id));
    expect(byApprover).toContain('"confirmedBy":"approver"');
    expect(byApprover).toContain('"connection":"crm"');
    expect(byApprover).toContain('"people":3');
  });

  it("holds a Knowledge Base offered to more readers and a Data Store moved to the team", async () => {
    const world = await start(
      true,
      undefined,
      developmentAuth,
      undefined,
      { apiAccess: true },
      true
    );
    const { stores } = world;
    const { members, workspace, write, handedOver } = await team(world);
    await write("workflow", "import", importing("import", "exampledata"), {});

    // A Data Store of the admin's own workspace that a Workflow fills from the source, moved to
    // the team, where a member reads what the team owns.
    const admin = asUserId((await person(world, "user-1", ["user", "admin", "superadmin"])).id);
    const own = await stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: admin
    });
    await write(
      "data_store",
      "orders",
      { name: "orders", title: "Orders", migrations: [] },
      {
        workspaceId: own.id
      }
    );
    await write(
      "workflow",
      "import-orders",
      importing("import-orders", "exampledata", "orders"),
      {}
    );
    await stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: required(members[1]).id,
      action: "data_store.read",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: workspace.id,
      grantedBy: admin
    });
    const moved = await world.api.call("assets.move", {
      params: { kind: "data_store", name: "orders" },
      payload: { workspaceId: own.id, to: { kind: "workspace", workspaceId: workspace.id } },
      headers: as("user-1")
    });
    expect(moved.statusCode, moved.body).toBe(202);
    heldSchema.parse(moved.json());
    expect(
      await stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "data_store",
        name: "orders"
      })
    ).toMatchObject({ scope: { kind: "workspace", workspaceId: own.id } });

    // A Knowledge Base on the store, offered in no workspace yet.
    await write(
      "knowledge_base",
      "guide",
      { title: "Guide", backend: { dataStore: "findings" } },
      {}
    );
    const offer = (confirmHandover?: string) =>
      world.api.call("assets.set_availability", {
        params: { kind: "knowledge_base", name: "guide" },
        payload: { mode: "all", ...(confirmHandover ? { confirmHandover } : {}) },
        headers: as("user-1")
      });
    const offered = await offer();
    expect(offered.statusCode, offered.body).toBe(202);
    heldSchema.parse(offered.json());
    expect(
      await stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "knowledge_base",
        name: "guide"
      })
    ).not.toMatchObject({ availability: { mode: "all" } });
    const stale = await offer("0".repeat(64));
    expect(stale.statusCode, stale.body).toBe(409);
    const token = z
      .object({ error: z.object({ details: z.object({ confirmation: z.string() }) }) })
      .parse(stale.json()).error.details.confirmation;
    const confirmed = await offer(token);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(await handedOver()).toHaveLength(1);
  });

  it("holds an agent made or given tools that add a source, and shows its approver what it hands on", async () => {
    const world = await start(
      true,
      undefined,
      developmentAuth,
      undefined,
      { apiAccess: true, connections: true },
      true
    );
    const { stores } = world;
    const { members, workspace, write, grant, handedOver, crm, exampledata } = await team(world);
    await write("app", "overview", overview, { workspaceId: workspace.id });
    await grant("keeper", "operations.approve");
    await grant("keeper", "connection.write", crm);
    const agentOf = async (name: string) =>
      stores.configAssets.getConfigAsset({ clientInstanceId, kind: "agent", name });
    const approve = async (requestId: string) => {
      const response = await world.api.call("approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" },
        headers: as("keeper")
      });
      await getTestJobs(world.api).runDue();
      return response;
    };
    const tools = ["data_store.findings.insert", "connection.crm.list"];
    // The instance's own agent, which has no tools yet.
    await stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "agent:helper": null },
      baseDefaultAgentName: null,
      mutations: [
        { type: "upsert", kind: "agent", name: "helper", config: agent("helper") },
        { type: "setDefaultAgent", agentName: "helper" }
      ]
    });

    // An agent made with the store's row tools and a Connection's call at once is live at once:
    // nothing of it was there before, so its source is new, and it waits for a person.
    const made = await world.api.call("assets.put", {
      params: { kind: "agent", name: "assistant" },
      payload: {
        expectedRevision: null,
        config: agent("assistant", { toolNames: tools })
      },
      headers: as("user-1")
    });
    expect(made.statusCode, made.body).toBe(202);
    const madeRequest = heldSchema.parse(made.json()).approvalRequestId;
    expect(await agentOf("assistant")).toBeUndefined();

    // Who decides it reads what the caller was told: how many people, the store only where
    // they may see it, and the source they may change.
    const opened = await world.api.call("approval_requests.get", {
      params: { requestId: madeRequest },
      headers: as("keeper")
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json()).toMatchObject({
      preview: {
        handover: [
          "3 people who read a store hidden from you afterwards may not use “CRM”.",
          "Approving confirms the hand-over."
        ]
      }
    });
    for (const member of members) expect(opened.body).not.toContain(member.id);

    const approved = await approve(madeRequest);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await agentOf("assistant")).toMatchObject({ config: { toolNames: tools } });
    const created = await handedOver();
    expect(created).toHaveLength(1);
    expect(JSON.stringify(created)).toContain('"change":"create"');
    expect(JSON.stringify(created)).toContain('"confirmedBy":"approver"');

    // Tools given to a live agent are a publish of them: one that adds a source waits as well.
    await grant("keeper", "connection.write", exampledata);
    const giving = ["data_store.findings.insert", "connection.exampledata.list"];
    const helper = required(await agentOf("helper"));
    const given = await world.api.call("agents.give_tools", {
      params: { name: "helper" },
      payload: { agentId: helper.id, toolNames: giving, expectedLiveRevision: helper.revision },
      headers: as("user-1")
    });
    expect(given.statusCode, given.body).toBe(202);
    expect(await agentOf("helper")).toMatchObject({ config: { toolNames: [] } });
    const givenApproved = await approve(heldSchema.parse(given.json()).approvalRequestId);
    expect(givenApproved.statusCode, givenApproved.body).toBe(200);
    expect(await agentOf("helper")).toMatchObject({ config: { toolNames: giving } });
    const both = await handedOver();
    expect(both).toHaveLength(2);
    expect(JSON.stringify(both)).toContain('"change":"give_tools"');
    expect(JSON.stringify(both)).toContain('"connection":"exampledata"');

    // An agent offered everywhere with the consent to offer what it uses offers its Knowledge
    // Base on the store as well: a reader of another team reads the rows through it now, so it
    // waits as the Knowledge Base's own availability does.
    const other = await stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Other",
      creatorUserId: asUserId((await person(world, "reviewer", ["user"])).id)
    });
    expect(other.id).toBeTruthy();
    await write(
      "knowledge_base",
      "guide",
      { title: "Guide", backend: { dataStore: "findings" } },
      {}
    );
    const saved = await stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "agent:berater": null },
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "berater",
          config: agent("berater", { knowledgeBases: ["guide"] })
        }
      ]
    });
    const offered = await world.api.call("assets.set_availability", {
      params: { kind: "agent", name: "berater" },
      payload: {
        mode: "all",
        makeDependenciesAvailable: true,
        expectedRevision: required(saved.revisions["agent:berater"])
      },
      headers: as("user-1")
    });
    expect(offered.statusCode, offered.body).toBe(202);
    heldSchema.parse(offered.json());
    const guideOffered = await stores.configAssets.listAgentAvailability({
      clientInstanceId,
      kind: "knowledge_base",
      agentName: "guide"
    });
    expect(guideOffered.get("guide")?.mode).not.toBe("all");
  });
});
