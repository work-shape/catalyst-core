import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appActionsSchema } from "@vivd-catalyst/api-contract";
import { clientInstanceId } from "./support/access-instance";
import { expectStatus, type AppFile } from "./support/app-instance";
import { action, setupAppActions, type AppActionsInstance } from "./support/app-actions";
import { operationOf } from "./support/connection-operations";

// `apps.actions.list` on real rows: what the Actions view of a draft, the Details of an App
// and the Apps group of an agent's tools read. The App `orders` has a published revision and
// a draft, with a reading action, a changing one and one on an operation Apps do not reach.
// `kai` is a member of the App's workspace and holds nothing else.
//
// Every test here fails without the change: the instance had no operation `apps.actions.list`,
// so each call answered 404.

/** An App with one reading action on the Connection `depot`. */
function stockSource(): AppFile[] {
  return [
    {
      path: "app.yaml",
      text: JSON.stringify({
        id: "stock",
        name: "Stock",
        kit: "1.1.0",
        entry: "index.html",
        connections: ["depot"]
      })
    },
    { path: "index.html", text: "<!doctype html><title>Stock</title>" },
    {
      path: "actions/count.action.yaml",
      text: action(["connection: depot", "operation: echo", "effect: reading"])
    }
  ];
}

describe("apps.actions.list", () => {
  let t: AppActionsInstance;
  beforeAll(async () => {
    t = await setupAppActions();
  });
  afterAll(() => t.closeAll());

  const list = async (userId: string, app?: string) => {
    const response = await t.call(userId, "apps.actions.list", {
      query: app === undefined ? {} : { app }
    });
    expectStatus(response, 200);
    return appActionsSchema.parse(response.json());
  };
  const actionsOf = async (userId: string, app: string) => {
    const [listed] = (await list(userId, app)).apps;
    return Object.fromEntries((listed?.actions ?? []).map((entry) => [entry.name, entry]));
  };

  it("answers a writer the draft: each action with its kind, its effect, the Connection by its label, the operation and what a call would come to", async () => {
    const answer = await list(t.admin.id, "orders");

    expect(answer.truncated).toBe(false);
    expect(answer.apps).toHaveLength(1);
    expect(answer.apps[0]).toMatchObject({
      name: "orders",
      title: "Orders",
      view: "draft",
      revision: 2
    });
    const actions = await actionsOf(t.admin.id, "orders");
    expect(actions.load).toEqual({
      name: "load",
      kind: "connection",
      effect: "reading",
      description: "Reads one row.",
      toolName: "app.orders.load",
      connection: { name: "crm", title: expect.any(String) },
      operation: "echo",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      },
      policy: "allow",
      agentTool: false
    });
    // The policy's word, also for what a draft refuses: the view says that it is a draft.
    expect(actions.save).toMatchObject({ effect: "changing", operation: "write" });
    expect(actions.save?.policy).not.toBe("deny");
    expect(actions.save?.unavailable).toBeUndefined();
    // `erp.echo` is exposed to agents alone, so no call from an App reaches it.
    expect(actions["agent-only"]).toMatchObject({
      connection: { name: "erp" },
      policy: "deny",
      unavailable: "not_exposed"
    });
  });

  it("refuses a member without app.read with 403 naming the right, and answers the published revision once the member reads the App", async () => {
    const refused = await t.call(t.kai.id, "apps.actions.list", { query: { app: "orders" } });

    expect(refused.statusCode).toBe(403);
    expect(t.refusal(refused)).toMatchObject({
      code: "FORBIDDEN",
      details: { action: "app.read" }
    });

    // The right of the kind in the App's workspace, as a role there carries it.
    const grant = await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "app.read",
      effect: "allow",
      scopeKind: "workspace",
      scopeId: t.workspaceId,
      grantedBy: t.admin.id
    });
    try {
      const answer = await list(t.kai.id, "orders");
      expect(answer.apps[0]).toMatchObject({ view: "published", revision: 1 });
      const actions = await actionsOf(t.kai.id, "orders");
      // `kai` may not use the Connection, so the call would be refused, and may not read it,
      // so its label is not told.
      expect(actions.load).toMatchObject({ policy: "deny", connection: { name: "crm" } });
      expect(actions.load).not.toHaveProperty("connection.title");
      expect(actions.load?.unavailable).toBeUndefined();
    } finally {
      await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });
    }
  });

  it("answers without a named App the published revision of every App the caller reads, and says which actions an agent can carry", async () => {
    const answer = await list(t.admin.id);

    const orders = answer.apps.find((app) => app.name === "orders");
    expect(orders).toMatchObject({ title: "Orders", view: "published", revision: 1 });
    expect(
      Object.fromEntries((orders?.actions ?? []).map((entry) => [entry.name, entry.agentTool]))
    ).toEqual({
      // `crm.echo` and `erp.echo` are exposed to agents, `crm.write` to Apps alone.
      load: true,
      "agent-only": true,
      save: false
    });

    // Nothing of an App is told to somebody who may not read it.
    expect((await list(t.kai.id)).apps.map((app) => app.name)).not.toContain("orders");
  });

  it("says why a call cannot reach its operation: the Connection is off, or no longer accepts the operation", async () => {
    await t.seed("depot", { operations: [operationOf("echo", { exposure: ["bridge"] })] });
    expectStatus(await t.putApp(t.admin.id, "stock", stockSource()), 200);
    expect((await actionsOf(t.admin.id, "stock")).count?.unavailable).toBeUndefined();

    await t.seed("depot", { operations: [operationOf("other", { exposure: ["bridge"] })] });
    expect(await actionsOf(t.admin.id, "stock")).toMatchObject({
      count: { unavailable: "operation_missing", policy: "deny" }
    });

    await t.seed("depot", {
      operations: [operationOf("echo", { exposure: ["bridge"], enabled: false })]
    });
    expect((await actionsOf(t.admin.id, "stock")).count?.unavailable).toBe("operation_disabled");

    await t.seed("depot", {
      enabled: false,
      operations: [operationOf("echo", { exposure: ["bridge"] })]
    });
    expect((await actionsOf(t.admin.id, "stock")).count?.unavailable).toBe("connection_disabled");
  });
});
