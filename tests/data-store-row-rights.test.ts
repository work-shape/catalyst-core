import { describe, expect, it } from "vitest";
import {
  ROLE_DEFAULT_ACTIONS,
  asUserId,
  type AuthenticatedUser,
  type DataStoreRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
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
