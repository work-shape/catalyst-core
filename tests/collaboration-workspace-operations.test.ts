import { describe, expect, it } from "vitest";
import { z } from "zod";
import { operationRunSchema } from "@work-shape/catalyst-api-contract";
import type {
  CentralPolicySetting,
  CollaborationWorkspaceId,
  UserId
} from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema, setupAccessInstance } from "./support/access-instance";
import type { TestCallInput, TestOperationName } from "./support/operations";
import { getTestJobs } from "./support/test-instance";

// The ten changes of workspaces, members and access requests are registered operations. These
// tests fail without that: the plain routes wrote no Operation Run, answered no run id, knew
// no Idempotency-Key, asked no policy, recorded no refusal and answered a deletion with
// counts or an empty 202.

const TEN = [
  "workspaces.create",
  "workspaces.update",
  "workspaces.delete",
  "workspaces.members.add",
  "workspaces.members.update_role",
  "workspaces.members.remove",
  "workspaces.members.leave",
  "workspaces.access_requests.create",
  "workspaces.access_requests.approve",
  "workspaces.access_requests.decline"
] as const;

/** The audit row each change writes about itself. A deletion writes its rows in its own job. */
const OWN_ROW: Partial<Record<(typeof TEN)[number], string>> = {
  "workspaces.create": "collaboration_workspace.created",
  "workspaces.update": "collaboration_workspace.updated",
  "workspaces.members.add": "collaboration_workspace.member_added",
  "workspaces.members.update_role": "collaboration_workspace.member_role_changed",
  "workspaces.members.remove": "collaboration_workspace.member_removed",
  "workspaces.members.leave": "collaboration_workspace.member_left",
  "workspaces.access_requests.create": "collaboration_workspace.access_requested",
  "workspaces.access_requests.approve": "collaboration_workspace.access_request_approved",
  "workspaces.access_requests.decline": "collaboration_workspace.access_request_declined"
};

const NOT_AVAILABLE = "Collaboration Workspace is not available";

describe("workspaces and members: every change is an Operation Run", () => {
  it("leaves one run per call, with the caller, the workspace and the rows of the run", async () => {
    const f = await setup();
    const params = { collaborationWorkspaceId: f.workspaceId };
    const calls: { operation: (typeof TEN)[number]; actor: UserId; answer: Answer }[] = [];
    const change = async (
      operation: (typeof TEN)[number],
      actor: UserId,
      input: TestCallInput = {}
    ) => {
      const answer = await f.t.call(actor, operation, input);
      expect({ operation, status: answer.statusCode }).toEqual({ operation, status: 200 });
      calls.push({ operation, actor, answer });
      return answer;
    };

    const created = await change("workspaces.create", f.owner.id, { payload: { name: "Second" } });
    const secondId = z.object({ id: z.string() }).parse(created.json()).id;
    await change("workspaces.update", f.owner.id, { params, payload: { name: "Lab renamed" } });
    // Joining, three ways: added by an Admin, asked and approved, asked and declined.
    await change("workspaces.members.add", f.admin.id, {
      params,
      payload: { email: "joiner@example.test" }
    });
    await change("workspaces.members.update_role", f.owner.id, {
      params: { ...params, userId: f.joiner.id },
      payload: { role: "admin" }
    });
    await change("workspaces.access_requests.create", f.outsider.id, { params });
    await change("workspaces.access_requests.approve", f.owner.id, {
      params: { ...params, userId: f.outsider.id }
    });
    await change("workspaces.access_requests.create", f.stranger.id, { params });
    await change("workspaces.access_requests.decline", f.admin.id, {
      params: { ...params, userId: f.stranger.id }
    });
    await change("workspaces.members.remove", f.owner.id, {
      params: { ...params, userId: f.joiner.id }
    });
    await change("workspaces.members.leave", f.member.id, { params });
    const deleted = await change("workspaces.delete", f.owner.id, {
      params,
      payload: { confirmName: "Lab renamed" }
    });
    // Nothing was left to wait for, so the rows are gone when the call answers.
    expect(deleted.json()).toEqual({ state: "deleted" });
    expect(await f.workspaceName()).toBeUndefined();

    const events = await f.audit();
    for (const operation of TEN) {
      const made = calls.filter((call) => call.operation === operation);
      const runs = await f.runs(operation);
      expect({ operation, runs: runs.length }).toEqual({ operation, runs: made.length });
      for (const [index, run] of runs.entries()) {
        const call = made[index];
        // A creation names no workspace yet: there is none before it ran.
        const workspaceId = operation === "workspaces.create" ? undefined : f.workspaceId;
        expect({ operation, run }).toMatchObject({
          run: {
            status: "done",
            actor: { kind: "user", id: call?.actor },
            decision: { mode: "direct" }
          }
        });
        expect({ operation, workspaceId: run.workspaceId }).toEqual({ operation, workspaceId });
        expect(call?.answer.headers["operation-run-id"]).toBe(run.id);
        const ofRun = events.filter((event) => event.metadata?.operationRunId === run.id);
        expect(ofRun.map((event) => `${event.type}:${event.status}`)).toEqual(
          expect.arrayContaining([
            "operation.authorization_checked:success",
            "operation.started:success",
            "operation.completed:success"
          ])
        );
        const subjects = ofRun
          .filter((event) => event.type.startsWith("operation."))
          .map((event) => event.subject);
        expect(new Set(subjects)).toEqual(new Set([workspaceId ?? "workspaces.create"]));
        // What the change says about itself is still written, now with its run.
        const own = OWN_ROW[operation];
        if (own) {
          expect({ operation, own: ofRun.filter((event) => event.type === own).length }).toEqual({
            operation,
            own: 1
          });
        }
      }
    }
    expect(secondId).not.toBe(f.workspaceId);
  });

  // The acceptance check of the ticket, by itself: leaving and joining.
  it("names the workspace in the one run of leaving and in the one run of joining", async () => {
    const f = await setup();
    const params = { collaborationWorkspaceId: f.workspaceId };
    await f.t.expectOk(f.owner.id, "workspaces.members.add", {
      params,
      payload: { email: "joiner@example.test" }
    });
    await f.t.expectOk(f.joiner.id, "workspaces.members.leave", { params });
    for (const [operation, actor] of [
      ["workspaces.members.add", f.owner.id],
      ["workspaces.members.leave", f.joiner.id]
    ] as const) {
      const runs = await f.runs(operation);
      expect(runs.map((run) => ({ workspaceId: run.workspaceId, actor: run.actor.id }))).toEqual([
        { workspaceId: f.workspaceId, actor }
      ]);
    }
  });

  it("leaves no run for the personal workspace the interface asks for on every load", async () => {
    const f = await setup();
    const before = await f.t.stores.operationRuns.list({ clientInstanceId });
    for (let load = 0; load < 3; load += 1) {
      await f.t.expectOk(f.member.id, "workspaces.ensure_personal");
    }
    expect(await f.t.stores.operationRuns.list({ clientInstanceId })).toHaveLength(before.length);
  });

  it("answers a repeated creation from its run and creates one workspace", async () => {
    const f = await setup();
    const create = () =>
      f.t.call(f.owner.id, "workspaces.create", {
        headers: { "idempotency-key": "create-once" },
        payload: { name: "Once" }
      });
    const first = await create();
    const again = await create();
    expect(again.statusCode).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json()).toEqual(first.json());
    expect(await f.runs("workspaces.create")).toHaveLength(1);
    const named = (await f.t.stores.workspaces.listSharedWorkspaces({ clientInstanceId })).filter(
      (workspace) => workspace.name === "Once"
    );
    expect(named).toHaveLength(1);
  });
});

describe("workspaces and members: the role is asked before the policy", () => {
  // Without the registration the policy is never asked: the Owner's call below added the member.
  it("refuses a member's members.add before the policy is asked", async () => {
    const f = await setup([{ operation: "workspaces.members.add", value: "deny" }]);
    const input = {
      params: { collaborationWorkspaceId: f.workspaceId },
      payload: { email: "joiner@example.test" }
    };
    const policyAsked = f.asked.policy;
    const refused = await f.t.call(f.member.id, "workspaces.members.add", input);
    expect(refused.statusCode).toBe(403);
    expect(errorOf(refused)).toEqual({
      code: "FORBIDDEN",
      message: "Workspace Owner or Admin access is required",
      details: { action: "workspaces.members.add", reason: "no_grant" }
    });
    expect(f.asked.policy).toBe(policyAsked);
    const [run] = await f.runs("workspaces.members.add");
    expect(run).toMatchObject({
      status: "denied",
      workspaceId: f.workspaceId,
      actor: { id: f.member.id },
      denial: { kind: "forbidden", action: "workspaces.members.add" }
    });
    expect(refused.headers["operation-run-id"]).toBe(run?.id);
    expect(await f.rowsOfRun(run?.id)).toEqual([
      "operation.authorization_checked:denied",
      "operation.denied:denied"
    ]);

    // The policy is there, and is what an Owner meets.
    const denied = await f.t.call(f.owner.id, "workspaces.members.add", input);
    expect(denied.statusCode).toBe(403);
    expect(errorOf(denied).code).toBe("POLICY_DENIED");
    expect(f.asked.policy).toBeGreaterThan(policyAsked);
    expect(await f.memberIds()).toEqual(f.members);
  });

  it("refuses a member every change that asks a higher role, and changes nothing", async () => {
    const f = await setup();
    const params = { collaborationWorkspaceId: f.workspaceId };
    await f.t.stores.workspaces.createAccessRequest({ ...f.scope, userId: f.outsider.id });
    const policyAsked = f.asked.policy;
    const refusedByRole: [(typeof TEN)[number], TestCallInput, string][] = [
      ["workspaces.update", { params, payload: { name: "Taken" } }, "Owner or Admin"],
      ["workspaces.delete", { params, payload: { confirmName: "Lab" } }, "Owner"],
      [
        "workspaces.members.add",
        { params, payload: { email: "joiner@example.test" } },
        "Owner or Admin"
      ],
      [
        "workspaces.members.update_role",
        { params: { ...params, userId: f.admin.id }, payload: { role: "member" } },
        "Owner or Admin"
      ],
      [
        "workspaces.members.remove",
        { params: { ...params, userId: f.admin.id } },
        "Owner or Admin"
      ],
      [
        "workspaces.access_requests.approve",
        { params: { ...params, userId: f.outsider.id } },
        "Owner or Admin"
      ],
      [
        "workspaces.access_requests.decline",
        { params: { ...params, userId: f.outsider.id } },
        "Owner or Admin"
      ]
    ];
    for (const [operation, input, role] of refusedByRole) {
      const refused = await f.t.call(f.member.id, operation, input);
      expect({ operation, status: refused.statusCode }).toEqual({ operation, status: 403 });
      expect(errorOf(refused)).toEqual({
        code: "FORBIDDEN",
        message: `Workspace ${role} access is required`,
        details: { action: operation, reason: "no_grant" }
      });
      const [run] = await f.runs(operation);
      expect({ operation, run }).toMatchObject({
        run: { status: "denied", workspaceId: f.workspaceId }
      });
      expect(await f.rowsOfRun(run?.id)).toEqual([
        "operation.authorization_checked:denied",
        "operation.denied:denied"
      ]);
    }
    expect(f.asked.policy).toBe(policyAsked);
    expect(await f.memberIds()).toEqual(f.members);
    expect(await f.workspaceName()).toBe("Lab");
    expect(
      await f.t.stores.workspaces.getAccessRequest({ ...f.scope, userId: f.outsider.id })
    ).toBeDefined();
  });

  // The rule depends on the member the call names, so the operation itself refuses.
  it("ends an Admin's change of an Owner as a refusal that names the operation", async () => {
    const f = await setup();
    const refused = await f.t.call(f.admin.id, "workspaces.members.remove", {
      params: { collaborationWorkspaceId: f.workspaceId, userId: f.owner.id }
    });
    expect(refused.statusCode).toBe(403);
    expect(errorOf(refused)).toEqual({
      code: "FORBIDDEN",
      message: "Workspace Admins may remove regular Members only",
      details: { action: "workspaces.members.remove", reason: "no_grant" }
    });
    const [run] = await f.runs("workspaces.members.remove");
    expect(run).toMatchObject({ status: "denied", workspaceId: f.workspaceId });
    expect(await f.memberIds()).toEqual(f.members);

    // The last active Owner stays, as before: the operation's own answer, so the run failed.
    const last = await f.t.call(f.owner.id, "workspaces.members.leave", {
      params: { collaborationWorkspaceId: f.workspaceId }
    });
    expect(last.statusCode).toBe(409);
    expect((await f.runs("workspaces.members.leave")).map((left) => left.error?.code)).toEqual([
      "CONFLICT"
    ]);
    expect(await f.memberIds()).toEqual(f.members);
  });

  it("does not show a workspace to somebody outside it, and asks no policy for them", async () => {
    const f = await setup();
    const hidden = await f.t.stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Hidden",
      visibility: "private",
      creatorUserId: f.owner.id
    });
    const policyAsked = f.asked.policy;
    const outside: [(typeof TEN)[number], TestCallInput][] = [
      [
        "workspaces.update",
        { params: { collaborationWorkspaceId: f.workspaceId }, payload: { name: "Taken" } }
      ],
      [
        "workspaces.delete",
        { params: { collaborationWorkspaceId: f.workspaceId }, payload: { confirmName: "Lab" } }
      ],
      ["workspaces.members.leave", { params: { collaborationWorkspaceId: f.workspaceId } }],
      [
        "workspaces.members.add",
        {
          params: { collaborationWorkspaceId: "cws_missing" },
          payload: { email: "a@example.test" }
        }
      ],
      // A workspace that cannot be found takes no request to join.
      ["workspaces.access_requests.create", { params: { collaborationWorkspaceId: hidden.id } }]
    ];
    for (const [operation, input] of outside) {
      const answer = await f.t.call(f.outsider.id, operation, input);
      expect({ operation, status: answer.statusCode }).toEqual({ operation, status: 404 });
      expect(errorOf(answer)).toMatchObject({ code: "NOT_FOUND", message: NOT_AVAILABLE });
      const [run] = await f.runs(operation);
      // Nothing of the operation ran: the check before it ended the call.
      expect({ operation, run }).toMatchObject({
        run: { status: "failed", error: { code: "NOT_FOUND", unexecuted: true } }
      });
    }
    expect(f.asked.policy).toBe(policyAsked);
    expect(await f.workspaceName()).toBe("Lab");
    expect(await f.memberIds()).toEqual(f.members);
  });

  // Fails without the registration: the member was added at once.
  it("holds a change the instance wants approved, names the workspace and adds nobody", async () => {
    const f = await setup([{ operation: "workspaces.members.add", value: "approval" }]);
    const held = await f.t.call(f.owner.id, "workspaces.members.add", {
      params: { collaborationWorkspaceId: f.workspaceId },
      payload: { email: "joiner@example.test" }
    });
    expect(held.statusCode).toBe(202);
    const run = operationRunSchema.parse(held.json());
    expect(run).toMatchObject({
      operation: "workspaces.members.add",
      status: "pending_approval"
    });
    expect((await f.runs("workspaces.members.add"))[0]?.workspaceId).toBe(f.workspaceId);
    expect(await f.memberIds()).toEqual(f.members);
  });

  // Fails without the fix: before an approved call ran, membership of the run's workspace was
  // asked for every operation, so a request to join could never be approved.
  it("applies an approved request to join of a person who is not a member", async () => {
    const f = await setup([{ operation: "workspaces.access_requests.create", value: "approval" }]);
    const held = await f.t.call(f.outsider.id, "workspaces.access_requests.create", {
      params: { collaborationWorkspaceId: f.workspaceId }
    });
    expect(held.statusCode).toBe(202);
    const requested = () =>
      f.t.stores.workspaces.getAccessRequest({ ...f.scope, userId: f.outsider.id });
    expect(await requested()).toBeUndefined();

    await f.approve(held);

    expect(await requested()).toMatchObject({ userId: f.outsider.id });
    const [run] = await f.runs("workspaces.access_requests.create");
    expect(run).toMatchObject({ status: "done", decision: { mode: "approved" } });
    // Asking to join makes nobody a member.
    expect(await f.memberIds()).toEqual(f.members);
  });

  it("does not apply an approved change of a person who left the workspace meanwhile", async () => {
    const f = await setup([{ operation: "workspaces.members.add", value: "approval" }]);
    const held = await f.t.call(f.admin.id, "workspaces.members.add", {
      params: { collaborationWorkspaceId: f.workspaceId },
      payload: { email: "joiner@example.test" }
    });
    expect(held.statusCode).toBe(202);
    await f.t.stores.workspaces.removeMembership({ ...f.scope, userId: f.admin.id });

    await f.approve(held);

    const [run] = await f.runs("workspaces.members.add");
    // The workspace is not found for somebody outside it, as on a call made now.
    expect(run).toMatchObject({
      status: "failed",
      error: { code: "NOT_FOUND", message: NOT_AVAILABLE, unexecuted: true }
    });
    expect(await f.memberIds()).toEqual([f.owner.id, f.member.id].sort());
  });

  it("keeps neither the email nor the workspace name on a refused and on a failed run", async () => {
    const f = await setup();
    const params = { collaborationWorkspaceId: f.workspaceId };
    // Refused: a Member may not add anybody. Failed: the workspace is not found for an outsider.
    const refused = await f.t.call(f.member.id, "workspaces.members.add", {
      params,
      payload: { email: "joiner@example.test" }
    });
    const failedAdd = await f.t.call(f.outsider.id, "workspaces.members.add", {
      params,
      payload: { email: "joiner@example.test" }
    });
    const failedDelete = await f.t.call(f.outsider.id, "workspaces.delete", {
      params,
      payload: { confirmName: "Lab" }
    });
    expect([refused.statusCode, failedAdd.statusCode, failedDelete.statusCode]).toEqual([
      403, 404, 404
    ]);
    const runs = [
      ...(await f.runs("workspaces.members.add")),
      ...(await f.runs("workspaces.delete"))
    ];
    expect(runs.map((run) => run.status).sort()).toEqual(["denied", "failed", "failed"]);
    const rows = (await f.audit()).filter((event) =>
      runs.some((run) => run.id === event.metadata?.operationRunId)
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const kept of [...runs, ...rows, refused.json(), failedAdd.json(), failedDelete.json()]) {
      const text = JSON.stringify(kept);
      expect(text).not.toContain("joiner@example.test");
      // As a value: `displayLabel` is a key of every row.
      expect(text).not.toContain('"Lab"');
    }
  });
});

type Answer = Awaited<ReturnType<Awaited<ReturnType<typeof setupAccessInstance>>["call"]>>;

const errorOf = (response: { json(): unknown }) => errorSchema.parse(response.json()).error;

/**
 * A Shared Workspace "Lab" that can be found, with an Owner, an Admin and a Member, and three
 * people outside it. Written through the stores, so every run of a test is a call of the test.
 */
async function setup(settings: CentralPolicySetting[] = []) {
  const asked = { policy: 0 };
  const t = await setupAccessInstance({
    operations: {
      centralPolicySettings: () => {
        asked.policy += 1;
        return settings;
      }
    }
  });
  const person = (displayLabel: string, email: string) =>
    t.stores.users.createUser({ clientInstanceId, displayLabel, email, roles: ["user"] });
  const owner = await person("Owner", "owner@example.test");
  const admin = await person("Workspace admin", "workspace-admin@example.test");
  const member = await person("Member", "member@example.test");
  const joiner = await person("Joiner", "joiner@example.test");
  const outsider = await person("Outsider", "outsider@example.test");
  const stranger = await person("Stranger", "stranger@example.test");
  const workspace = await t.stores.workspaces.createWorkspace({
    clientInstanceId,
    kind: "shared",
    name: "Lab",
    visibility: "discoverable",
    creatorUserId: owner.id
  });
  const workspaceId: CollaborationWorkspaceId = workspace.id;
  const scope = { clientInstanceId, collaborationWorkspaceId: workspaceId };
  await t.stores.workspaces.addMembership({ ...scope, userId: admin.id, role: "admin" });
  await t.stores.workspaces.addMembership({ ...scope, userId: member.id, role: "member" });
  const audit = () => t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 });
  const memberIds = async () =>
    (await t.stores.workspaces.listMemberships(scope))
      .map((membership) => membership.userId)
      .sort();
  return {
    t,
    asked,
    scope,
    workspaceId,
    owner,
    admin,
    member,
    joiner,
    outsider,
    stranger,
    /** The instance administrator approves a held call and the job that executes it runs. */
    approve: async (held: Answer) => {
      const { approvalRequestId: requestId = "" } = operationRunSchema.parse(held.json());
      const decided = await t.call(t.admin.id, "approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" }
      });
      expect(decided.statusCode).toBe(200);
      await getTestJobs(t.instance).runDue();
    },
    /** The members the workspace starts with. */
    members: [owner.id, admin.id, member.id].sort(),
    audit,
    memberIds,
    workspaceName: async () =>
      (await t.stores.workspaces.getWorkspace(clientInstanceId, workspaceId))?.name,
    runs: async (operation: TestOperationName) =>
      (await t.stores.operationRuns.list({ clientInstanceId }))
        .filter((run) => run.operation === operation)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    rowsOfRun: async (runId: string | undefined) =>
      (await audit())
        .filter((event) => event.metadata?.operationRunId === runId)
        .map((event) => `${event.type}:${event.status}`)
        .sort()
  };
}
