import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asUserId,
  type CollaborationWorkspaceId,
  type OperationOrigin,
  type UserRecord
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import {
  agent,
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { guardedEvents } from "./support/guardrails";
import { getTestJobs, getTestOperationCalls } from "./support/test-instance";

// WS-PUB-1b, access acceptance checks 11 and 37: an agent a workspace owns stays a draft until a
// holder of `agent.approve` on it approves its publish. A Publisher without that right files an
// `agent_publish` item and makes nothing live; the approval makes the draft live and, on the
// first publish, offers the agent in its own workspace only. An instance admin's own Publish is
// live at once; an instance-owned agent's publish is held by nothing. Rights are real grants.

const heldSchema = z.object({
  id: z.string(),
  status: z.literal("pending_approval"),
  approvalRequestId: z.string()
});
const requestSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  canDecide: z.boolean(),
  preview: z.looseObject({ review: z.looseObject({}).optional() })
});
const listedSchema = z.object({ items: z.array(z.object({ name: z.string() })) });
const requestsSchema = z.object({ items: z.array(z.looseObject({ id: z.string() })) });

const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
});

/**
 * Kai (Fabian's part) is Builder and Publisher in Kai Spezis without being a member; Lena is a
 * member of Kai Spezis and of Other. The shipped publish guardrail runs.
 */
async function setup() {
  const t = await setupAccessInstance({
    storedAssetSource: true,
    furtherToolNames: ["read_skill"],
    server: (stores) => ({
      operations: { events: guardedEvents(stores, {}, { shipped: true }).events }
    })
  });
  instances.push(t);
  const team = await t.sharedWorkspace("Kai Spezis");
  const other = await t.sharedWorkspace("Other");
  for (const workspaceId of [team, other]) await join(t, t.lena, workspaceId);
  for (const bundle of ["builder", "publisher"])
    await t.grant(t.kai.id, bundle, { workspaceId: team });

  const live = async (name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "agent", name });
  const create = async (userId: string, name: string, workspaceId?: string) =>
    t.expectOk(userId, "assets.put", {
      params: { kind: "agent", name },
      payload: {
        config: agent(name),
        expectedRevision: null,
        ...(workspaceId === undefined ? {} : { workspaceId })
      }
    });
  /** Writes the agent's draft over its live revision, as a push or Save draft does. */
  const push = async (userId: string, name: string, overrides: Record<string, unknown>) => {
    const asset = await live(name);
    if (!asset) throw new Error(`No agent '${name}'`);
    const response = await t.call(userId, "assets.put", {
      params: { kind: "agent", name },
      payload: {
        config: { ...asset.config, ...overrides },
        expectedRevision: asset.revision,
        ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
      }
    });
    expect(response.statusCode, response.body).toBe(200);
  };
  /** The owner travels with the call, as the agent page and the CLI bound to it send it. */
  const ownerOf = async (name: string) => {
    const scope = (await live(name))?.scope;
    return scope?.kind === "workspace" ? { workspaceId: scope.workspaceId } : {};
  };
  const publish = async (userId: string, name: string, revision: number) =>
    t.call(userId, "assets.publish", {
      params: { kind: "agent", name },
      payload: { revision, ...(await ownerOf(name)) }
    });
  const listed = async (userId: string, workspaceId: CollaborationWorkspaceId) =>
    listedSchema
      .parse(
        (
          await t.expectOk(userId, "workspaces.agents.list", {
            params: { collaborationWorkspaceId: workspaceId }
          })
        ).json()
      )
      .items.map((item) => item.name);
  const request = async (userId: string, requestId: string) =>
    requestSchema.parse(
      (await t.expectOk(userId, "approval_requests.get", { params: { requestId } })).json()
    );
  /** Approves, then runs the held call it resumed, as the worker does. */
  const decide = async (userId: string, requestId: string) => {
    const response = await t.call(userId, "approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    });
    await getTestJobs(t.instance).runDue();
    return response;
  };
  const inbox = async (userId: string) =>
    requestsSchema
      .parse((await t.expectOk(userId, "approval_requests.list")).json())
      .items.map((item) => item.id);
  const asAdmin = async (name: string, revision: number, origin: OperationOrigin) => {
    const calls = await getTestOperationCalls(t.instance);
    return runOperation(
      {
        operation: "assets.publish",
        effect: "changing",
        input: { kind: "agent", name, revision, ...(await ownerOf(name)) },
        actor: { ...t.admin, externalUserId: t.admin.id, authSource: "test", scopes: ["*"] },
        origin,
        correlationId: `corr_${name}_${origin.kind}`
      },
      calls.deps
    );
  };
  return { t, team, other, live, create, push, publish, listed, request, decide, inbox, asAdmin };
}

/**
 * A push of the agent's draft that lands once, right after the publish's guardrails read the
 * draft and before the publish runs: the race a publisher could make by hand.
 */
function sneakAfterCheck(
  t: AccessInstance,
  name: string,
  expectedDraftRevision: number | null,
  instructions: string
) {
  const drafts = t.stores.agentProposals;
  const read = drafts.get.bind(drafts);
  let sneaked = false;
  drafts.get = async (input) => {
    const found = await read(input);
    if (sneaked || !new Error().stack?.includes("publishEvents")) return found;
    sneaked = true;
    const asset = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "agent",
      name
    });
    if (!asset || asset.id !== input.agentId) return found;
    await drafts.save({
      clientInstanceId,
      agentId: asset.id,
      baseRevision: asset.revision,
      expectedDraftRevision,
      config: { ...asset.config, instructions },
      savedAt: new Date().toISOString()
    });
    return found;
  };
}

async function join(t: AccessInstance, user: UserRecord, workspaceId: CollaborationWorkspaceId) {
  await t.stores.workspaces.addMembership({
    clientInstanceId,
    collaborationWorkspaceId: workspaceId,
    userId: asUserId(user.id),
    role: "member"
  });
}

describe("publishing an agent a workspace owns (WS-PUB-1b)", () => {
  it("waits for agent.approve, then makes the draft live and offers it in its workspace only", async () => {
    const { t, team, other, live, create, push, publish, listed, request, decide, inbox } =
      await setup();
    await create(t.kai.id, "kai-helper", team);
    await push(t.kai.id, "kai-helper", { instructions: "Draft.", toolNames: ["known.tool"] });
    // The push leaves the live revision and every member's agent list as they were.
    expect(await live("kai-helper")).toMatchObject({
      revision: 1,
      config: { instructions: "Help." }
    });
    expect(await listed(t.lena.id, team)).not.toContain("kai-helper");

    const response = await publish(t.kai.id, "kai-helper", 1);
    expect(response.statusCode, response.body).toBe(202);
    const held = heldSchema.parse(response.json());
    expect(await live("kai-helper")).toMatchObject({
      revision: 1,
      config: { instructions: "Help." }
    });
    expect(await listed(t.lena.id, team)).not.toContain("kai-helper");

    // The publisher cannot decide it; an instance admin reads the review and can.
    expect(await request(t.kai.id, held.approvalRequestId)).toMatchObject({ canDecide: false });
    expect((await decide(t.kai.id, held.approvalRequestId)).statusCode).toBe(403);
    const item = await request(t.admin.id, held.approvalRequestId);
    expect(item).toMatchObject({ kind: "agent_publish", canDecide: true });
    expect(item.preview.review).toMatchObject({
      kind: "agent",
      name: "kai-helper",
      revision: 1,
      liveRevision: 1,
      agent: {
        workspace: { id: team, name: "Kai Spezis" },
        offers: true,
        toolsAdded: ["known.tool"],
        toolsRemoved: [],
        instructions: { after: "Draft.", before: "Help." }
      }
    });
    expect(await inbox(t.admin.id)).toContain(held.approvalRequestId);

    const approved = await decide(t.admin.id, held.approvalRequestId);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await live("kai-helper")).toMatchObject({
      revision: 2,
      config: { instructions: "Draft." }
    });
    expect(await listed(t.lena.id, team)).toContain("kai-helper");
    expect(await listed(t.lena.id, other)).not.toContain("kai-helper");
    const offered = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "config_asset.availability_set"
    });
    expect(offered.map((event) => event.metadata)).toContainEqual(
      expect.objectContaining({ name: "kai-helper", reason: "first_publish" })
    );

    // A later push changes only the draft; its approved publish keeps the offering as it is.
    await push(t.kai.id, "kai-helper", { instructions: "Second." });
    expect(await live("kai-helper")).toMatchObject({
      revision: 2,
      config: { instructions: "Draft." }
    });
    const again = heldSchema.parse((await publish(t.kai.id, "kai-helper", 2)).json());
    expect((await request(t.admin.id, again.approvalRequestId)).preview.review).toMatchObject({
      agent: { offers: false }
    });
    expect((await decide(t.admin.id, again.approvalRequestId)).statusCode).toBe(200);
    expect(await live("kai-helper")).toMatchObject({
      revision: 3,
      config: { instructions: "Second." }
    });
    expect(await listed(t.lena.id, team)).toContain("kai-helper");
    expect(await listed(t.lena.id, other)).not.toContain("kai-helper");
  });

  it("is live at once on an instance admin's own Publish, and waits on the admin's CLI publish", async () => {
    const { t, team, other, live, create, push, publish, listed, asAdmin } = await setup();
    // Created by a builder who is no member, so it starts hidden (the admin owns the workspace).
    await create(t.kai.id, "admin-helper", team);
    await push(t.admin.id, "admin-helper", { instructions: "Admin draft." });
    const response = await publish(t.admin.id, "admin-helper", 1);
    expect(response.statusCode, response.body).toBe(200);
    expect(await live("admin-helper")).toMatchObject({ revision: 2 });
    expect(await listed(t.lena.id, team)).toContain("admin-helper");
    expect(await listed(t.lena.id, other)).not.toContain("admin-helper");

    // The answer to the CLI's prompt is no approver's click; without a terminal it is a confirmation.
    await create(t.kai.id, "cli-helper", team);
    await push(t.admin.id, "cli-helper", { instructions: "CLI draft." });
    expect((await asAdmin("cli-helper", 1, { kind: "cli" })).result.status).toBe(
      "pending_approval"
    );
    expect((await asAdmin("cli-helper", 1, { kind: "cli", unattended: true })).result.status).toBe(
      "pending_confirmation"
    );
    expect(await live("cli-helper")).toMatchObject({ revision: 1 });
    expect(await listed(t.lena.id, team)).not.toContain("cli-helper");
  });

  it("holds nothing for an instance-owned agent: the CLI makes it live without asking", async () => {
    const { t, live, create, push, asAdmin } = await setup();
    await create(t.admin.id, "house-helper");
    await push(t.admin.id, "house-helper", { instructions: "House draft." });
    expect((await asAdmin("house-helper", 1, { kind: "cli" })).result.status).toBe("done");
    expect(await live("house-helper")).toMatchObject({
      revision: 2,
      config: { instructions: "House draft." }
    });
  });

  it("lets agent.approve on a workspace decide that workspace's items and no other's", async () => {
    const { t, team, other, live, create, push, publish, request, decide, inbox } = await setup();
    for (const bundle of ["builder", "publisher"])
      await t.grant(t.kai.id, bundle, { workspaceId: other });
    await t.grant(t.lena.id, "agent.approve", { workspaceId: team });
    await create(t.kai.id, "team-agent", team);
    await create(t.kai.id, "other-agent", other);
    await push(t.kai.id, "team-agent", { instructions: "Team draft." });
    await push(t.kai.id, "other-agent", { instructions: "Other draft." });
    const ownItem = heldSchema.parse((await publish(t.kai.id, "team-agent", 1)).json());
    const otherItem = heldSchema.parse((await publish(t.kai.id, "other-agent", 1)).json());

    expect(await inbox(t.lena.id)).toContain(ownItem.approvalRequestId);
    expect(await inbox(t.lena.id)).not.toContain(otherItem.approvalRequestId);
    expect(await request(t.lena.id, ownItem.approvalRequestId)).toMatchObject({ canDecide: true });
    // Another workspace's item is answered as one that does not exist.
    expect((await decide(t.lena.id, otherItem.approvalRequestId)).statusCode).toBe(404);
    expect(await live("other-agent")).toMatchObject({ revision: 1 });

    const approved = await decide(t.lena.id, ownItem.approvalRequestId);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await live("team-agent")).toMatchObject({ revision: 2 });
  });

  it("holds an instance admin's own Publish where a deny on the workspace takes agent.approve", async () => {
    const { t, team, live, create, push, publish, request } = await setup();
    await create(t.kai.id, "denied-agent", team);
    await push(t.kai.id, "denied-agent", { instructions: "Denied draft." });
    await t.grant(t.admin.id, "agent.approve", { workspaceId: team }, "deny");
    const response = await publish(t.admin.id, "denied-agent", 1);
    expect(response.statusCode, response.body).toBe(202);
    const held = heldSchema.parse(response.json());
    expect(await live("denied-agent")).toMatchObject({ revision: 1 });
    expect(await request(t.root.id, held.approvalRequestId)).toMatchObject({ canDecide: true });
  });

  it("starts an agent a member without agent.approve made offered nowhere, and approves its first version", async () => {
    const { t, team, other, live, publish, listed, request, decide } = await setup();
    // Lena is a member of Kai Spezis and its Builder and Publisher, without agent.approve.
    for (const bundle of ["builder", "publisher"])
      await t.grant(t.lena.id, bundle, { workspaceId: team });
    const made = await t.call(t.lena.id, "assets.put", {
      params: { kind: "agent", name: "lena-made" },
      payload: { config: agent("lena-made"), expectedRevision: null, workspaceId: team },
      headers: { "x-test-key": "personal" }
    });
    expect(made.statusCode, made.body).toBe(200);
    expect(await live("lena-made")).toMatchObject({ revision: 1 });
    expect(await listed(t.lena.id, team)).not.toContain("lena-made");

    // Its first publish needs no draft: version 1 waits for an approver, reviewed alone.
    const response = await publish(t.lena.id, "lena-made", 1);
    expect(response.statusCode, response.body).toBe(202);
    const held = heldSchema.parse(response.json());
    expect(await listed(t.lena.id, team)).not.toContain("lena-made");
    const item = await request(t.admin.id, held.approvalRequestId);
    expect(item).toMatchObject({ kind: "agent_publish", canDecide: true });
    expect(item.preview.review).toMatchObject({
      kind: "agent",
      name: "lena-made",
      revision: 1,
      agent: { workspace: { id: team }, offers: true, instructions: { after: "Help." } }
    });
    expect(item.preview.review).not.toHaveProperty("liveRevision");
    expect(item.preview.review?.agent).not.toHaveProperty("fields");
    expect(item.preview.review?.agent).not.toHaveProperty("instructions.before");

    const approved = await decide(t.admin.id, held.approvalRequestId);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await live("lena-made")).toMatchObject({ revision: 1 });
    expect(await listed(t.lena.id, team)).toContain("lena-made");
    expect(await listed(t.lena.id, other)).not.toContain("lena-made");

    // A second publish without a draft is no first one: there is nothing to publish.
    expect((await publish(t.lena.id, "lena-made", 1)).statusCode).toBe(412);
  });

  it("keeps a creator who holds agent.approve offering the agent in the workspace at once", async () => {
    const { t, team, live, create, listed } = await setup();
    // The administrator made Kai Spezis and is its member.
    await create(t.admin.id, "admin-made", team);
    expect(await live("admin-made")).toMatchObject({ revision: 1 });
    expect(await listed(t.lena.id, team)).toContain("admin-made");
  });

  it("offers on approval only an agent the creation rule hid, never one an admin or its maker kept hidden", async () => {
    const { t, team, other, create, push, publish, listed, request, decide } = await setup();
    await t.grant(t.lena.id, "agent.approve", { workspaceId: team });
    const approve = async (name: string) => {
      await push(t.kai.id, name, { instructions: `${name} draft.` });
      const held = heldSchema.parse((await publish(t.kai.id, name, 1)).json());
      expect((await request(t.lena.id, held.approvalRequestId)).preview.review).toMatchObject({
        agent: { offers: false }
      });
      const approved = await decide(t.lena.id, held.approvalRequestId);
      expect(approved.statusCode, approved.body).toBe(200);
    };
    const hide = async (name: string, collaborationWorkspaceIds: string[] = []) =>
      t.expectOk(t.admin.id, "assets.set_availability", {
        params: { kind: "agent", name },
        payload: { mode: "selected", collaborationWorkspaceIds }
      });

    // Made by an approver and offered in the workspace, then hidden by an instance admin.
    await create(t.admin.id, "admin-hid", team);
    expect(await listed(t.lena.id, team)).toContain("admin-hid");
    await hide("admin-hid");
    await approve("admin-hid");
    expect(await listed(t.lena.id, team)).not.toContain("admin-hid");

    // Made by an approver who is no member of the workspace: hidden, but by no rule of WS-PUB-1b.
    for (const action of ["builder", "publisher", "agent.approve"])
      await t.grant(t.kai.id, action, { workspaceId: other });
    await t.grant(t.lena.id, "agent.approve", { workspaceId: other });
    await create(t.kai.id, "kept-hidden", other);
    expect(await listed(t.lena.id, other)).not.toContain("kept-hidden");
    await approve("kept-hidden");
    expect(await listed(t.lena.id, other)).not.toContain("kept-hidden");

    // Hidden by the creation rule, then placed by an admin: the admin's choice stands.
    await create(t.kai.id, "admin-placed", team);
    await hide("admin-placed", [other]);
    await hide("admin-placed");
    await approve("admin-placed");
    expect(await listed(t.lena.id, team)).not.toContain("admin-placed");
  });

  it("shows an approver who may not read the agent no instructions, only that they are withheld", async () => {
    const { t, team, create, push, publish, request } = await setup();
    await t.grant(t.lena.id, "agent.approve", { workspaceId: team });
    await t.grant(t.lena.id, "agent.read", { workspaceId: team }, "deny");
    await create(t.kai.id, "secret-helper", team);
    await push(t.kai.id, "secret-helper", { instructions: "Secret draft." });
    const held = heldSchema.parse((await publish(t.kai.id, "secret-helper", 1)).json());

    const withheld = await request(t.lena.id, held.approvalRequestId);
    expect(withheld).toMatchObject({ canDecide: true });
    expect(withheld.preview.review).toMatchObject({ agent: { instructionsWithheld: true } });
    expect(withheld.preview.review?.agent).not.toHaveProperty("instructions");
    expect(JSON.stringify(withheld)).not.toContain("Secret draft.");
    expect(JSON.stringify(withheld)).not.toContain("Help.");

    // An approver who may read the agent reads both.
    expect((await request(t.admin.id, held.approvalRequestId)).preview.review).toMatchObject({
      agent: { instructions: { after: "Secret draft.", before: "Help." } }
    });
  });

  it("refuses a publish whose draft its guardrails did not read, though a push lands before it runs", async () => {
    const { t, team, live, create, push, publish, inbox } = await setup();
    await create(t.kai.id, "raced", team);
    await push(t.kai.id, "raced", { instructions: "Reviewed draft." });
    // Kai names the draft revision his next push will make; it lands right after the check.
    sneakAfterCheck(t, "raced", 1, "Unreviewed.");
    const response = await publish(t.kai.id, "raced", 2);
    expect(response.statusCode, response.body).toBe(412);
    expect(await live("raced")).toMatchObject({ revision: 1, config: { instructions: "Help." } });
    expect(await inbox(t.admin.id)).toEqual([]);
  });

  it("publishes the first version its guardrails read, never a draft written after the check", async () => {
    const { t, team, live, publish, listed } = await setup();
    for (const bundle of ["builder", "publisher"])
      await t.grant(t.lena.id, bundle, { workspaceId: team });
    const made = await t.call(t.lena.id, "assets.put", {
      params: { kind: "agent", name: "first-raced" },
      payload: { config: agent("first-raced"), expectedRevision: null, workspaceId: team }
    });
    expect(made.statusCode, made.body).toBe(200);
    // The admin's own Publish of version 1 is checked as the first version; a draft 1 follows.
    sneakAfterCheck(t, "first-raced", null, "Unreviewed.");
    const response = await publish(t.admin.id, "first-raced", 1);
    expect(response.statusCode, response.body).toBe(412);
    expect(await live("first-raced")).toMatchObject({
      revision: 1,
      config: { instructions: "Help." }
    });
    expect(await listed(t.lena.id, team)).not.toContain("first-raced");
  });

  it("files no first version where a draft stands beside it, and none for an instance agent", async () => {
    const { t, team, create, push, publish } = await setup();
    await create(t.kai.id, "drafted", team);
    await push(t.kai.id, "drafted", { instructions: "Draft." });
    // Revision 1 names the draft here, not the stored version: that is the ordinary publish.
    const held = await publish(t.kai.id, "drafted", 1);
    expect(held.statusCode, held.body).toBe(202);
    await create(t.admin.id, "house-plain");
    expect((await publish(t.admin.id, "house-plain", 1)).statusCode).toBe(412);
  });
});
