import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asUserId,
  assetMoveLadderRefusal,
  type AssetOwnerReach,
  type AssetScope,
  type CollaborationWorkspaceId,
  type UserRecord
} from "@work-shape/catalyst-core";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import {
  agent,
  clientInstanceId,
  setupAccessInstance as setup,
  skill,
  type AccessInstance
} from "./support/access-instance";
import { fileTestDatabaseUrl } from "./support/test-database";

// "Teilen mit…" (SHARE-1): `assets.move` moves an asset up the ladder Nur ich → Team → Alle with
// what it uses, at once with the right at the target, otherwise as a request an admin decides.

const moveSchema = z.looseObject({
  status: z.enum(["moved", "requested"]),
  requestId: z.string().optional(),
  path: z.enum(["direct", "request"]),
  moves: z.array(z.looseObject({ kind: z.string(), name: z.string(), id: z.string() })),
  breaks: z.array(z.looseObject({ kind: z.string(), name: z.string() })),
  afterwards: z.looseObject({
    owner: z.looseObject({ rung: z.string() }),
    editors: z.string(),
    users: z.string(),
    callerEdits: z.boolean()
  })
});
const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.looseObject({}) })
});

const team: AssetOwnerReach = { kind: "workspace", workspaceId: "t", workspaceKind: "shared" };
const other: AssetOwnerReach = { kind: "workspace", workspaceId: "o", workspaceKind: "shared" };
const mine: AssetOwnerReach = { kind: "workspace", workspaceId: "m", workspaceKind: "personal" };
const theirs: AssetOwnerReach = { kind: "workspace", workspaceId: "x", workspaceKind: "personal" };
const instance: AssetOwnerReach = { kind: "instance" };

describe("the ladder", () => {
  it("goes up only: never down, never sideways, never to the same place", () => {
    expect(assetMoveLadderRefusal(mine, team)).toBeUndefined();
    expect(assetMoveLadderRefusal(mine, instance)).toBeUndefined();
    expect(assetMoveLadderRefusal(team, instance)).toBeUndefined();
    expect(assetMoveLadderRefusal(mine, mine)).toBe("move_same_place");
    expect(assetMoveLadderRefusal(instance, instance)).toBe("move_same_place");
    expect(assetMoveLadderRefusal(team, mine)).toBe("move_down");
    expect(assetMoveLadderRefusal(instance, team)).toBe("move_down");
    expect(assetMoveLadderRefusal(team, other)).toBe("move_sideways");
    expect(assetMoveLadderRefusal(mine, theirs)).toBe("move_sideways");
  });
});

interface Places {
  t: AccessInstance;
  mine: CollaborationWorkspaceId;
  team: CollaborationWorkspaceId;
  other: CollaborationWorkspaceId;
}

async function places(): Promise<Places> {
  const t = await setup();
  const mine = (
    await t.stores.workspaces.ensurePersonalWorkspace({ clientInstanceId, userId: t.kai.id })
  ).id;
  const team = await t.sharedWorkspace("Team");
  const other = await t.sharedWorkspace("Other");
  await join(t, t.kai, team);
  await join(t, t.kai, other);
  return { t, mine, team, other };
}

async function join(t: AccessInstance, user: UserRecord, workspaceId: CollaborationWorkspaceId) {
  await t.stores.workspaces.addMembership({
    clientInstanceId,
    collaborationWorkspaceId: workspaceId,
    userId: asUserId(user.id),
    role: "member"
  });
}

function put(
  t: AccessInstance,
  userId: string,
  kind: "agent" | "skill",
  name: string,
  workspaceId?: string,
  overrides: Record<string, unknown> = {}
) {
  return t.expectOk(userId, "assets.put", {
    params: { kind, name },
    payload: {
      config: kind === "agent" ? agent(name, overrides) : skill(name),
      ...(workspaceId ? { workspaceId } : {})
    }
  });
}

/**
 * An asset of Kai's Personal Workspace, which he may change. Written to the store, with his
 * rights on the asset, as a person's own building rights are not this test's subject.
 */
async function own(
  t: AccessInstance,
  mine: CollaborationWorkspaceId,
  kind: "agent" | "skill",
  name: string,
  overrides: Record<string, unknown> = {}
) {
  await applyAtCurrentRevisions(t.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind,
        name,
        config: kind === "agent" ? agent(name, overrides) : skill(name),
        scope: { kind: "workspace", workspaceId: mine }
      }
    ]
  });
  const assetId = await t.assetId(kind, name);
  for (const verb of ["read", "write"])
    if (!(await held(t, `${kind}.${verb}`, assetId)))
      await t.grant(t.kai.id, `${kind}.${verb}`, { assetId });
}

async function held(t: AccessInstance, action: string, assetId: string) {
  const rows = await t.stores.access.listGrants({ clientInstanceId, action, scopeId: assetId });
  return rows.length > 0;
}

function move(
  t: AccessInstance,
  userId: string,
  kind: string,
  name: string,
  from: string | undefined,
  to: { kind: "instance" } | { kind: "workspace"; workspaceId: string },
  extra: Record<string, unknown> = {},
  check = false
) {
  return t.call(userId, check ? "assets.move_check" : "assets.move", {
    params: { kind, name },
    payload: { ...(from ? { workspaceId: from } : {}), to, ...extra }
  });
}

async function scopeOf(t: AccessInstance, kind: string, name: string): Promise<AssetScope> {
  const asset = await t.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
  if (!asset) throw new Error(`No ${kind} '${name}'`);
  return asset.scope;
}

async function movedEvents(t: AccessInstance) {
  return t.stores.audit.listAuditEvents({ clientInstanceId, type: "asset.moved", limit: 200 });
}

function refusalOf(response: { statusCode: number; json(): unknown }) {
  const body = errorSchema.parse(response.json());
  return { status: response.statusCode, code: body.error.code, ...body.error.details };
}

const toTeam = (workspaceId: string) => ({ kind: "workspace" as const, workspaceId });

describe("assets.move", () => {
  it("refuses down, sideways and the same place, each with a plain sentence, and moves nothing", async () => {
    const { t, mine, team, other } = await places();
    await own(t, mine, "skill", "notes");
    await put(t, t.admin.id, "skill", "team-notes", team);
    await put(t, t.admin.id, "skill", "everyones");
    const kaiPersonal = toTeam(mine);
    const cases = [
      { user: t.kai.id, name: "notes", from: mine, to: kaiPersonal, reason: "move_same_place" },
      { user: t.admin.id, name: "team-notes", from: team, to: kaiPersonal, reason: "move_down" },
      {
        user: t.admin.id,
        name: "everyones",
        from: undefined,
        to: toTeam(team),
        reason: "move_down"
      },
      {
        user: t.admin.id,
        name: "team-notes",
        from: team,
        to: toTeam(other),
        reason: "move_sideways"
      }
    ];
    for (const { user, name, from, to, reason } of cases) {
      for (const check of [false, true]) {
        const response = await move(t, user, "skill", name, from, to, {}, check);
        expect(refusalOf(response), name).toMatchObject({
          status: 422,
          code: "VALIDATION_FAILED",
          reason
        });
      }
    }
    const de = await t.call(t.admin.id, "assets.move", {
      params: { kind: "skill", name: "team-notes" },
      payload: { workspaceId: team, to: toTeam(other) },
      headers: { "accept-language": "de" }
    });
    expect(errorSchema.parse(de.json()).error.message).toContain("nicht in ein anderes Team");
    expect(await scopeOf(t, "skill", "team-notes")).toEqual({
      kind: "workspace",
      workspaceId: team
    });
    expect(await movedEvents(t)).toEqual([]);
  });

  it("moves at once with the right at the target, with what the asset uses (closure)", async () => {
    const { t, mine, team } = await places();
    for (const action of ["agent.read", "agent.write", "skill.read", "skill.write"])
      await t.grant(t.kai.id, action, { workspaceId: team });
    await own(t, mine, "skill", "kai-skill");
    await own(t, mine, "skill", "unused");
    await own(t, mine, "agent", "kai-agent", { skillNames: ["kai-skill"] });
    const check = await move(t, t.kai.id, "agent", "kai-agent", mine, toTeam(team), {}, true);
    expect(check.statusCode, check.body).toBe(200);
    const dry = moveSchema.omit({ status: true }).parse(check.json());
    expect(dry.path).toBe("direct");
    expect(dry.moves.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      "agent:kai-agent",
      "skill:kai-skill"
    ]);
    expect(dry.afterwards).toMatchObject({
      owner: { kind: "workspace", workspaceId: team, rung: "team", workspaceName: "Team" },
      editors: "workspace_builders",
      users: "workspace_members",
      callerEdits: true
    });
    // The check moved nothing.
    expect(await scopeOf(t, "agent", "kai-agent")).toEqual({
      kind: "workspace",
      workspaceId: mine
    });

    const response = await move(t, t.kai.id, "agent", "kai-agent", mine, toTeam(team));
    expect(response.statusCode, response.body).toBe(200);
    expect(moveSchema.parse(response.json()).status).toBe("moved");
    for (const [kind, name] of [
      ["agent", "kai-agent"],
      ["skill", "kai-skill"]
    ] as const)
      expect(await scopeOf(t, kind, name)).toEqual({ kind: "workspace", workspaceId: team });
    // What the agent does not use stays.
    expect(await scopeOf(t, "skill", "unused")).toEqual({ kind: "workspace", workspaceId: mine });
    const [event] = await movedEvents(t);
    expect(event?.metadata).toEqual({
      assetId: await t.assetId("agent", "kai-agent"),
      kind: "agent",
      from: { kind: "workspace", workspaceId: mine },
      to: { kind: "workspace", workspaceId: team },
      moved: [
        { assetId: await t.assetId("agent", "kai-agent"), kind: "agent" },
        { assetId: await t.assetId("skill", "kai-skill"), kind: "skill" }
      ],
      operationRunId: expect.any(String)
    });
    // Ids only: no name, title or content of a Personal Workspace's asset in the record.
    expect(JSON.stringify(event)).not.toContain("kai-skill");
    expect(JSON.stringify(event)).not.toContain("Guidance");
  });

  it("refuses a team the person is not a member of", async () => {
    const { t, mine } = await places();
    const closed = await t.sharedWorkspace("Closed");
    await own(t, mine, "skill", "kai-skill");
    expect(
      refusalOf(await move(t, t.kai.id, "skill", "kai-skill", mine, toTeam(closed)))
    ).toMatchObject({ status: 422, reason: "move_not_member" });
  });

  it("lists what breaks and moves it only once the caller accepts that", async () => {
    const { t, mine, team } = await places();
    for (const action of ["skill.read", "skill.write"])
      await t.grant(t.kai.id, action, { workspaceId: team });
    await own(t, mine, "skill", "shared-later");
    await own(t, mine, "agent", "stays-mine", { skillNames: ["shared-later"] });
    const refused = await move(t, t.kai.id, "skill", "shared-later", mine, toTeam(team));
    expect(refusalOf(refused)).toMatchObject({
      status: 422,
      reason: "move_breaks",
      breaks: [{ kind: "agent", name: "stays-mine", uses: { kind: "skill", name: "shared-later" } }]
    });
    expect(await scopeOf(t, "skill", "shared-later")).toEqual({
      kind: "workspace",
      workspaceId: mine
    });
    const accepted = await move(t, t.kai.id, "skill", "shared-later", mine, toTeam(team), {
      acceptBreaks: true
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await scopeOf(t, "skill", "shared-later")).toEqual({
      kind: "workspace",
      workspaceId: team
    });
  });

  it("refuses at the target what owner reach refuses there", async () => {
    const { t, mine, team } = await places();
    // A team agent that names a skill of a Personal Workspace, written before the rule held.
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: "private-skill",
          config: skill("private-skill"),
          scope: { kind: "workspace", workspaceId: mine }
        },
        {
          type: "upsert",
          kind: "agent",
          name: "team-agent",
          config: agent("team-agent", { skillNames: ["private-skill"] }),
          scope: { kind: "workspace", workspaceId: team }
        }
      ]
    });
    const response = await move(t, t.admin.id, "agent", "team-agent", team, { kind: "instance" });
    expect(refusalOf(response)).toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
      reason: "invalid_scope"
    });
    expect(await scopeOf(t, "agent", "team-agent")).toEqual({
      kind: "workspace",
      workspaceId: team
    });
    expect(await movedEvents(t)).toEqual([]);
  });

  it("rolls the whole move back when a step of it fails", async () => {
    const { t, mine, team } = await places();
    for (const action of ["agent.read", "agent.write", "skill.read", "skill.write"])
      await t.grant(t.kai.id, action, { workspaceId: team });
    await own(t, mine, "skill", "kai-skill");
    await own(t, mine, "agent", "kai-agent", { skillNames: ["kai-skill"] });
    // The audit row is written after both owners changed, in the same transaction.
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      await sql.unsafe(`
        CREATE FUNCTION refuse_move() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'refused for the test'; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER refuse_move BEFORE INSERT ON audit_events
          FOR EACH ROW WHEN (NEW.type = 'asset.moved') EXECUTE FUNCTION refuse_move();
      `);
      const response = await move(t, t.kai.id, "agent", "kai-agent", mine, toTeam(team));
      expect(response.statusCode).toBe(500);
    } finally {
      await sql.unsafe(`DROP TRIGGER refuse_move ON audit_events; DROP FUNCTION refuse_move();`);
      await sql.end();
    }
    for (const [kind, name] of [
      ["agent", "kai-agent"],
      ["skill", "kai-skill"]
    ] as const)
      expect(await scopeOf(t, kind, name)).toEqual({ kind: "workspace", workspaceId: mine });
    // Afterwards the same move goes through.
    const again = await move(t, t.kai.id, "agent", "kai-agent", mine, toTeam(team));
    expect(again.statusCode, again.body).toBe(200);
  });
});

describe("a move without the right at the target", () => {
  async function requested(p: Places) {
    const { t, mine, team } = p;
    await own(t, mine, "skill", "kai-skill");
    await own(t, mine, "agent", "kai-agent", { skillNames: ["kai-skill"] });
    const check = await move(t, t.kai.id, "agent", "kai-agent", mine, toTeam(team), {}, true);
    expect(moveSchema.omit({ status: true }).parse(check.json()).path).toBe("request");
    const response = await move(t, t.kai.id, "agent", "kai-agent", mine, toTeam(team));
    expect(response.statusCode, response.body).toBe(200);
    const body = moveSchema.parse(response.json());
    expect(body.status).toBe("requested");
    expect(body.requestId).toEqual(expect.any(String));
    // Nothing moved yet, and asking again answers the same request.
    expect(await scopeOf(t, "agent", "kai-agent")).toEqual({
      kind: "workspace",
      workspaceId: mine
    });
    const again = moveSchema.parse(
      (await move(t, t.kai.id, "agent", "kai-agent", mine, toTeam(team))).json()
    );
    expect(again.requestId).toBe(body.requestId);
    return z.string().parse(body.requestId);
  }

  it("files a request an admin accepts in the Inbox; the move is then made", async () => {
    const p = await places();
    const { t, mine, team } = p;
    const requestId = await requested(p);
    const inbox = await t.expectOk(t.admin.id, "approval_requests.list", {
      query: { status: "pending" }
    });
    expect(JSON.stringify(inbox.json())).toContain(requestId);
    // The requester cannot decide it.
    expect(
      (
        await t.call(t.kai.id, "approval_requests.decide", {
          params: { requestId },
          payload: { decision: "approve" }
        })
      ).statusCode
    ).toBe(403);
    const decided = await t.expectOk(t.admin.id, "approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    });
    expect(decided.json()).toMatchObject({ status: "approved" });
    for (const [kind, name] of [
      ["agent", "kai-agent"],
      ["skill", "kai-skill"]
    ] as const)
      expect(await scopeOf(t, kind, name)).toEqual({ kind: "workspace", workspaceId: team });
    const [event] = await movedEvents(t);
    expect(event?.metadata).toMatchObject({ requestId, from: { workspaceId: mine } });
    expect(event?.actor).toMatchObject({ userId: t.admin.id });
    const requestEvents = (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 }))
      .filter((entry) => entry.type.startsWith("approval_request."))
      .map((entry) => JSON.stringify(entry.metadata));
    expect(requestEvents.length).toBeGreaterThan(0);
    for (const metadata of requestEvents) expect(metadata).not.toContain("Guidance");
  });

  it("lets a builder of the team decide it, and an admin decline it: then nothing moves", async () => {
    const p = await places();
    const { t, mine, team } = p;
    for (const action of ["agent.read", "agent.write", "skill.read", "skill.write"])
      await t.grant(t.lena.id, action, { workspaceId: team });
    const requestId = await requested(p);
    const lenaInbox = await t.expectOk(t.lena.id, "approval_requests.list", {
      query: { status: "pending" }
    });
    expect(JSON.stringify(lenaInbox.json())).toContain(requestId);
    const declined = await t.expectOk(t.admin.id, "approval_requests.decide", {
      params: { requestId },
      payload: { decision: "reject", comment: "Not yet." }
    });
    expect(declined.json()).toMatchObject({ status: "rejected" });
    expect(await scopeOf(t, "agent", "kai-agent")).toEqual({
      kind: "workspace",
      workspaceId: mine
    });
    expect(await movedEvents(t)).toEqual([]);
    // A declined request leaves the way open for a new one.
    const response = await move(t, t.kai.id, "agent", "kai-agent", mine, toTeam(team));
    expect(moveSchema.parse(response.json()).requestId).not.toBe(requestId);
  });

  it("ends a request as superseded when the asset changed in between", async () => {
    const p = await places();
    const { t, mine } = p;
    const requestId = await requested(p);
    await own(t, mine, "skill", "late-skill");
    await own(t, mine, "agent", "kai-agent", { skillNames: ["kai-skill", "late-skill"] });
    const decided = await t.expectOk(t.admin.id, "approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    });
    expect(decided.json()).toMatchObject({ status: "superseded" });
    expect(await scopeOf(t, "agent", "kai-agent")).toEqual({
      kind: "workspace",
      workspaceId: mine
    });
  });
});
