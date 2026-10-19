import { describe, expect, it } from "vitest";
import {
  ROLE_DEFAULT_ACTIONS,
  asUserId,
  asCollaborationWorkspaceId,
  createPlatformId,
  type AuthenticatedUser,
  type DataStoreRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
import {
  createToolOperationRunner,
  ToolRegistry,
  runOperation
} from "@work-shape/catalyst-tool-execution";
import {
  clientInstanceId,
  useDataStoreInstance,
  type DataStoreInstance
} from "./support/data-store-instance";
import { getTestJobs } from "./support/test-instance";
import { eventually, required } from "./support/assertions";

const users = [
  { id: "user-1", roles: ["user", "admin", "superadmin"] },
  { id: "member", roles: ["user"] }
].map((user) => ({ ...user, externalUserId: user.id, displayLabel: user.id, permissionRefs: [] }));

describe("Data Store row rights for people", () => {
  const { start, person } = useDataStoreInstance();
  async function makeStore(world: DataStoreInstance, name: string, workspaceId?: string) {
    const put = await world.api.call("assets.put", {
      params: { kind: "data_store", name },
      payload: {
        expectedRevision: null,
        ...(workspaceId ? { workspaceId } : {}),
        files: [
          { path: "store.yaml", text: `id: ${name}\nname: Holiday requests\n` },
          {
            path: "migrations/0001_init.sql",
            text: "create table holidays (id integer primary key, person text);"
          }
        ]
      }
    });
    expect(put.statusCode, put.body).toBe(200);
    const published = await world.api.call("assets.publish", {
      params: { kind: "data_store", name },
      payload: { revision: 1, ...(workspaceId ? { workspaceId } : {}) }
    });
    expect(published.statusCode, published.body).toBe(200);
    let record: DataStoreRecord | undefined;
    await eventually(async () => {
      await getTestJobs(world.api).runDue();
      record = await world.stores.dataStores.findDataStoreByName({ clientInstanceId, name });
      expect(record).toMatchObject({ status: "ready", level: 1 });
    });
    return required(record);
  }
  const call = async (
    world: DataStoreInstance,
    actor: AuthenticatedUser,
    store: string,
    verb: "insert" | "update" | "delete_rows",
    input: JsonObject
  ) =>
    (
      await runOperation(
        {
          operation: `data_store.${store}.${verb}`,
          effect: "changing",
          input,
          actor,
          origin: { kind: "user" },
          correlationId: "row-rights"
        },
        world.execution.operationCalls.deps
      )
    ).result;
  const inputs = {
    insert: { table: "holidays", rows: [{ id: 1, person: "Alex" }] },
    update: { table: "holidays", rows: [{ key: { id: 1 }, set: { person: "Alex changed" } }] },
    delete_rows: { table: "holidays", keys: [{ id: 1 }] }
  };
  const refused = (action: string) => ({
    status: "denied",
    reason: { kind: "forbidden", action, reason: "no_grant" }
  });

  it.each([
    { label: "read-only", rights: ["data_store.read"] },
    { label: "insert-only", rights: ["data_store.insert"] },
    { label: "definition write and publish", rights: ["data_store.write", "data_store.publish"] }
  ])("$label rights grant only their row operations", async ({ rights }) => {
    const world = await start(true, "allow");
    const record = await makeStore(world, "holidays");
    const admin = await person(world, "row-admin", ["user", "admin", "superadmin"]);
    const give = (holderId: string, action: string) =>
      world.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId,
        action,
        effect: "allow",
        scopeKind: "asset",
        scopeId: record.id,
        grantedBy: asUserId(admin.id)
      });
    const member = await person(world, `person-${rights.join("-")}`, ["user"]);
    for (const action of rights) await give(member.id, action);
    for (const verb of ["insert", "update", "delete_rows"] as const) {
      const result = await call(world, member, "holidays", verb, inputs[verb]);
      expect(result, `${rights}: ${verb}: ${JSON.stringify(result)}`).toMatchObject(
        rights.includes("data_store.insert") && verb === "insert"
          ? { status: "done" }
          : refused(verb === "insert" ? "data_store.insert" : "data_store.execute")
      );
    }
    for (const role of ["builder", "publisher"] as const) {
      const actor = await person(world, `role-${role}`, ["user", role]);
      expect(await call(world, actor, "holidays", "insert", inputs.insert)).toMatchObject(
        refused("data_store.insert")
      );
      expect(await call(world, actor, "holidays", "update", inputs.update)).toMatchObject(
        refused("data_store.execute")
      );
    }
    expect(ROLE_DEFAULT_ACTIONS.admin).toEqual(
      expect.arrayContaining(["data_store.insert", "data_store.execute"])
    );
  });

  it("an admin grants insert on one store through Access; the person is refused on another with the right named", async () => {
    const world = await start(true, "allow", { enabled: true, users });
    const one = await makeStore(world, "one");
    await makeStore(world, "two");
    // Resolve this identity through the actual auth path before granting it a right.
    await world.api.call("config.get", {}, "member");
    const member = required(
      (await world.stores.users.listUsers({ clientInstanceId })).find(
        (user) => user.displayLabel === "member"
      )
    );
    const grant = await world.api.call("permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: member.id,
        action: "data_store.insert",
        effect: "allow",
        scopeKind: "asset",
        scopeId: one.id
      }
    });
    expect(grant.statusCode, grant.body).toBe(200);
    const on = (store: string) =>
      world.api.call("data_stores.insert", { params: { store }, payload: inputs.insert }, "member");
    expect((await on("one")).statusCode).toBe(200);
    const denied = await on("two");
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { details: { action: "data_store.insert" } } });
  });

  it("uses the conversation workspace for an agent's policy, approval and run on another workspace's store (AVAIL-1b)", async () => {
    const world = await start(true, "allow", {
      enabled: true,
      defaultUserId: "user-1",
      users: [
        ...users,
        ...["owner-approver", "caller-approver", "instance-approver"].map((id) => ({
          id,
          externalUserId: id,
          displayLabel: id,
          roles: ["user"]
        }))
      ]
    });
    const actor = await person(world, "cross-workspace", ["user"]);
    const ownerResponse = await world.api.call("workspaces.create", {
      payload: { name: "Store owner" }
    });
    const callerResponse = await world.api.call("workspaces.create", {
      payload: { name: "Conversation" }
    });
    expect(ownerResponse.statusCode).toBe(200);
    expect(callerResponse.statusCode).toBe(200);
    const owner = asCollaborationWorkspaceId(ownerResponse.json<{ id: string }>().id);
    const caller = asCollaborationWorkspaceId(callerResponse.json<{ id: string }>().id);
    const store = await makeStore(world, "cross-workspace", owner);
    const admin = await person(world, "cross-admin", ["user", "admin", "superadmin"]);
    await world.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: caller,
      userId: asUserId(actor.id),
      role: "member"
    });
    await world.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: actor.id,
      action: "data_store.insert",
      effect: "allow",
      scopeKind: "asset",
      scopeId: store.id,
      grantedBy: asUserId(admin.id)
    });
    const conversation = await world.stores.conversations.createConversation({
      clientInstanceId,
      collaborationWorkspaceId: caller,
      createdByUserId: actor.id,
      createdByExternalUserId: actor.externalUserId,
      title: "Cross workspace",
      visibility: "private",
      retainedUntil: "2099-01-01T00:00:00.000Z"
    });
    const operation = "data_store.cross-workspace.insert";
    const source = required(world.execution.modulesStarted.dataToolSources[0]);
    const base = world.execution.operationCalls.deps;
    const runner = createToolOperationRunner(
      {
        ...base,
        agentToolNames: async () => [operation],
        policy: {
          ...base.policy,
          centralSettings: () => [
            { operation, value: "deny", workspaceId: owner },
            { operation, value: "approval", workspaceId: caller }
          ]
        }
      },
      new ToolRegistry({ tools: [] }),
      { source }
    );
    const result = await runner(
      {
        toolName: operation,
        agentName: "assistant",
        conversationId: conversation.id,
        agentRunId: createPlatformId("agr"),
        toolCallId: createPlatformId("tc"),
        input: inputs.insert
      },
      { clientInstanceId, user: actor, correlationId: "cross-workspace-policy" }
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: "waiting_for_decision" });
    const run = required(
      (await world.stores.operationRuns.list({ clientInstanceId })).find(
        (run) => run.correlationId === "cross-workspace-policy"
      )
    );
    expect(run).toMatchObject({
      workspaceId: caller,
      status: "pending_approval",
      operation,
      conversationId: conversation.id
    });
    const request = required(
      await world.stores.approvals.getApprovalRequest({
        clientInstanceId,
        requestId: required(run.approvalRequestId)
      })
    );
    expect(request).toMatchObject({
      status: "pending",
      payload: { workspaceId: caller, operation }
    });
    // Generic operation approvals still require the instance-wide right; neither workspace
    // membership nor a right scoped to the owner or the Conversation is enough.
    for (const [label, workspaceId] of [
      ["owner-approver", owner],
      ["caller-approver", caller],
      ["instance-approver", undefined]
    ] as const) {
      const headers = { "x-dev-user-id": label };
      const me = await world.api.call("me.get", { headers });
      expect(me.statusCode).toBe(200);
      const holderId = me.json<{ id: string }>().id;
      await world.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId,
        action: "operations.approve",
        effect: "allow",
        scopeKind: workspaceId ? "workspace" : "instance",
        ...(workspaceId ? { scopeId: workspaceId } : {}),
        grantedBy: asUserId(admin.id)
      });
      const view = await world.api.call("approval_requests.get", {
        params: { requestId: request.id },
        headers
      });
      expect(view.statusCode, view.body).toBe(workspaceId ? 404 : 200);
      if (!workspaceId) expect(view.json()).toMatchObject({ canDecide: true });
    }
    expect(
      (
        await world.api.call("data_stores.query", {
          params: { store: "cross-workspace" },
          payload: { sql: "select count(*)::integer as count from holidays" }
        })
      ).json()
    ).toMatchObject({ rows: [{ count: 0 }] });
  });

  it("workspace A's row grant misses workspace B's store", async () => {
    const world = await start(true, "allow");
    const member = await person(world, "row-member", ["user"]);
    const workspaces = [];
    for (const name of ["A", "B"]) {
      const created = await world.api.call("workspaces.create", { payload: { name } });
      expect(created.statusCode, created.body).toBe(200);
      const workspace = created.json<{ id: string }>();
      workspaces.push(workspace);
      await makeStore(world, `store-${name.toLowerCase()}`, workspace.id);
    }
    const one = required(workspaces[0]);
    for (const action of ["data_store.insert", "data_store.execute"]) {
      const grant = await world.api.call("permissions.grant", {
        payload: {
          holderKind: "user",
          holderId: member.id,
          action,
          effect: "allow",
          scopeKind: "workspace",
          scopeId: one.id
        }
      });
      expect(grant.statusCode, grant.body).toBe(200);
    }
    expect(await call(world, member, "store-a", "insert", inputs.insert)).toMatchObject({
      status: "done"
    });
    expect(await call(world, member, "store-b", "insert", inputs.insert)).toMatchObject(
      refused("data_store.insert")
    );
    expect(await call(world, member, "store-a", "update", inputs.update)).toMatchObject({
      status: "done"
    });
    expect(await call(world, member, "store-b", "update", inputs.update)).toMatchObject(
      refused("data_store.execute")
    );
  });
});
