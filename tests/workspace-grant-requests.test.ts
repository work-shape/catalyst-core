import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asUserId,
  type CollaborationWorkspaceId,
  type UserRecord
} from "@work-shape/catalyst-core";
import {
  agent,
  clientInstanceId,
  errorSchema,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";

// AP-3: Builder and Publisher per member on Workspace > Members. An Owner asks; an instance
// admin who holds the bundle decides the `grant_request` in the Inbox or gives it at once; the
// Owner takes it back (access acceptance checks 3, 3a and 4). Kai owns the workspace, Lena is
// a member, Mia administers people without holding Builder.

const bundleSchema = z.object({
  state: z.enum(["none", "requested", "held", "inherited"]),
  change: z.enum(["grant", "request", "revoke", "withdraw"]).optional(),
  requestId: z.string().optional()
});
const listSchema = z.object({
  items: z.array(z.object({ userId: z.string(), builder: bundleSchema, publisher: bundleSchema }))
});
const requestSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  preview: z.looseObject({})
});

describe("Builder and Publisher of a member, asked for and decided", () => {
  let t: AccessInstance;
  let team: CollaborationWorkspaceId;
  let mia: UserRecord;

  beforeAll(async () => {
    t = await setupAccessInstance();
    team = (
      await t.stores.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Sales",
        creatorUserId: t.kai.id
      })
    ).id;
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: t.lena.id,
      role: "member"
    });
    mia = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Mia",
      roles: ["user"]
    });
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: mia.id,
      action: "users.manage",
      effect: "allow",
      scopeKind: "instance",
      grantedBy: asUserId(t.root.id)
    });
  });

  const bundlePath = (userId: string, bundle: string) => ({
    collaborationWorkspaceId: team,
    userId,
    bundle
  });
  const ask = (by: string, userId: string, bundle: string, reason?: string) =>
    t.call(by, "workspaces.member_bundles.request", {
      params: bundlePath(userId, bundle),
      payload: reason === undefined ? {} : { reason }
    });
  const list = async (by: string) =>
    listSchema.parse(
      (
        await t.expectOk(by, "workspaces.member_bundles.list", {
          params: { collaborationWorkspaceId: team }
        })
      ).json()
    ).items;
  const lenaOf = async (by: string) => {
    const row = (await list(by)).find((item) => item.userId === t.lena.id);
    if (!row) throw new Error("Lena is not listed");
    return row;
  };
  const writeAgent = (name: string) =>
    t.call(t.lena.id, "assets.put", {
      params: { kind: "agent", name },
      payload: { config: agent(name), expectedRevision: null, workspaceId: team }
    });
  const decide = (by: string, requestId: string, decision: "approve" | "reject") =>
    t.call(by, "approval_requests.decide", { params: { requestId }, payload: { decision } });
  const events = async (type: string) =>
    (await t.stores.audit.listAuditEvents({ clientInstanceId, type, limit: 200 })).map(
      (event) => event.metadata ?? {}
    );

  let builderRequest: string;

  it("shows the Owner each member's bundles, and refuses a plain member the list", async () => {
    expect(await lenaOf(t.kai.id)).toEqual({
      userId: t.lena.id,
      builder: { state: "none", change: "request" },
      publisher: { state: "none", change: "request" }
    });
    const refused = await t.call(t.lena.id, "workspaces.member_bundles.list", {
      params: { collaborationWorkspaceId: team }
    });
    expect(refused.statusCode).toBe(403);
  });

  it("files the Owner's request, which gives nothing until it is approved", async () => {
    const asked = await ask(t.kai.id, t.lena.id, "builder", "Builds the offer app");
    expect(asked.statusCode).toBe(200);
    const bundle = bundleSchema.parse(asked.json());
    expect(bundle).toMatchObject({ state: "requested", change: "withdraw" });
    builderRequest = z.string().parse(bundle.requestId);
    // A second ask answers the open request.
    expect(bundleSchema.parse((await ask(t.kai.id, t.lena.id, "builder")).json()).requestId).toBe(
      builderRequest
    );
    expect((await lenaOf(t.kai.id)).builder).toEqual({
      state: "requested",
      requestId: builderRequest,
      change: "withdraw"
    });
    expect(errorSchema.parse((await writeAgent("lena-before")).json()).error.details).toMatchObject(
      { action: "agent.write" }
    );
  });

  it("lets a member ask for themselves, and nobody else ask without the role", async () => {
    expect((await ask(t.lena.id, t.kai.id, "builder")).statusCode).toBe(403);
    // Not a member: answered as a workspace that is not there.
    expect((await ask(t.admin.id, t.lena.id, "builder")).statusCode).toBe(404);
    const own = await ask(t.lena.id, t.lena.id, "publisher");
    expect(bundleSchema.parse(own.json())).toMatchObject({ state: "requested" });
  });

  it("is decided only by who administers people and holds the bundle", async () => {
    const inbox = await t.expectOk(t.admin.id, "approval_requests.list", {
      query: { status: "pending" }
    });
    const item = z
      .object({ items: z.array(requestSchema) })
      .parse(inbox.json())
      .items.find((request) => request.id === builderRequest);
    expect(item).toMatchObject({
      kind: "grant_request",
      preview: {
        workspace: { id: team, name: "Sales" },
        member: { id: t.lena.id, label: "Lena" },
        bundle: "builder"
      }
    });
    expect((await decide(t.kai.id, builderRequest, "approve")).statusCode).toBe(403);
    // Mia administers people but holds no Builder in the workspace: she gives nothing she lacks.
    const refused = await decide(mia.id, builderRequest, "approve");
    expect(refused.statusCode).toBe(403);
    expect(errorSchema.parse(refused.json()).error.details).toMatchObject({ action: "builder" });
  });

  it("gives the bundle once an instance admin approves, and audits it without the reason", async () => {
    const decided = await decide(t.admin.id, builderRequest, "approve");
    expect(decided.json()).toMatchObject({ status: "approved" });
    expect((await writeAgent("lena-after")).statusCode).toBe(200);
    expect((await lenaOf(t.kai.id)).builder).toEqual({ state: "held", change: "revoke" });
    const [granted] = await events("permission.granted");
    expect(granted).toMatchObject({
      requestId: builderRequest,
      holderId: t.lena.id,
      action: "builder",
      scopeKind: "workspace",
      scopeId: team
    });
    const requestEvents = [
      ...(await events("approval_request.created")),
      ...(await events("approval_request.decided"))
    ].filter((metadata) => metadata.requestId === builderRequest);
    expect(requestEvents.map((metadata) => metadata.kind)).toEqual([
      "grant_request",
      "grant_request"
    ]);
    for (const metadata of [granted, ...requestEvents])
      expect(JSON.stringify(metadata)).not.toContain("offer app");
  });

  it("declines without a reason and grants nothing; the requester sees the decision", async () => {
    const pending = (await lenaOf(t.kai.id)).publisher;
    const requestId = z.string().parse(pending.requestId);
    // Kai did not ask, so his switch does not withdraw Lena's own request.
    expect(pending.change).toBeUndefined();
    expect((await decide(t.admin.id, requestId, "reject")).json()).toMatchObject({
      status: "rejected"
    });
    const mine = await t.expectOk(t.lena.id, "approval_requests.list_mine");
    expect(JSON.stringify(mine.json())).toContain(requestId);
    expect((await lenaOf(t.kai.id)).publisher).toEqual({ state: "none", change: "request" });
  });

  it("lets the Owner take a bundle back at once; the next write is refused", async () => {
    const revoked = await t.call(t.kai.id, "workspaces.member_bundles.revoke", {
      params: bundlePath(t.lena.id, "builder")
    });
    expect(bundleSchema.parse(revoked.json())).toEqual({ state: "none", change: "request" });
    expect(errorSchema.parse((await writeAgent("lena-later")).json()).error.details).toMatchObject({
      action: "agent.write"
    });
    const [event] = await events("permission.revoked");
    expect(event).toMatchObject({ holderId: t.lena.id, action: "builder", scopeId: team });
  });

  it("lets an instance admin who holds it give a bundle at once, and nobody else", async () => {
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: t.admin.id,
      role: "admin"
    });
    expect((await lenaOf(t.admin.id)).publisher).toEqual({ state: "none", change: "grant" });
    const kaiGrant = await t.call(t.kai.id, "workspaces.member_bundles.grant", {
      params: bundlePath(t.lena.id, "publisher")
    });
    expect(kaiGrant.statusCode).toBe(403);
    const miaGrant = await t.call(mia.id, "workspaces.member_bundles.grant", {
      params: bundlePath(t.lena.id, "publisher")
    });
    expect(miaGrant.statusCode).toBe(403);
    const granted = await t.call(t.admin.id, "workspaces.member_bundles.grant", {
      params: bundlePath(t.lena.id, "publisher")
    });
    expect(bundleSchema.parse(granted.json())).toEqual({ state: "held", change: "revoke" });
    expect((await lenaOf(t.kai.id)).publisher).toMatchObject({ state: "held" });
    // An instance admin holds both by role: there is nothing to take back on this screen.
    const admin = (await list(t.kai.id)).find((item) => item.userId === t.admin.id);
    expect(admin?.builder).toEqual({ state: "inherited" });
  });

  it("ends a request as outdated once the member left the workspace", async () => {
    const asked = bundleSchema.parse((await ask(t.kai.id, t.lena.id, "builder")).json());
    const requestId = z.string().parse(asked.requestId);
    await t.stores.workspaces.removeMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: t.lena.id
    });
    const decided = await decide(t.admin.id, requestId, "approve");
    expect(decided.json()).toMatchObject({
      status: "superseded",
      applyResult: { reason: "member_left" }
    });
    const rows = await t.stores.access.listGrants({
      clientInstanceId,
      holderId: t.lena.id,
      action: "builder"
    });
    expect(rows).toEqual([]);
  });
});
