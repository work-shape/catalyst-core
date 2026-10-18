import { discoveryNames, seedDiscoveryAssets } from "./support/discovery-assets";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appActionSchema, appActionsSchema } from "@work-shape/catalyst-api-contract";
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
    return Object.fromEntries(
      (listed?.actions ?? []).map((entry) => [entry.name, appActionSchema.parse(entry)])
    );
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
      agentTool: false,
      // Where the writer's next call goes (ADR-0031): a read of a draft reads live.
      target: "live"
    });
    // The policy's word, and the call is simulated unless the writer switched it live once.
    expect(actions.save).toMatchObject({
      effect: "changing",
      operation: "write",
      target: "dry_run"
    });
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

  it("References across owners: Holding use on a published App lists its actions by name, description and effect where they can be chosen, without the call preview or configuration", async () => {
    const answer = await list(t.admin.id);

    const orders = answer.apps.find((app) => app.name === "orders");
    expect(orders).toMatchObject({ title: "Orders", view: "published", revision: 1 });
    expect(
      Object.fromEntries(
        (orders?.actions ?? []).map((entry) => [entry.name, appActionSchema.parse(entry).agentTool])
      )
    ).toEqual({
      // `crm.echo` and `erp.echo` are exposed to agents, `crm.write` to Apps alone.
      load: true,
      "agent-only": true,
      save: false
    });

    // A member may choose published actions through use; named details still require read.
    const chosen = await list(t.kai.id);
    const chosenOrders = chosen.apps.find((app) => app.name === "orders");
    expect(chosenOrders).toEqual({
      name: "orders",
      title: "Orders",
      view: "published",
      revision: 1,
      scope: { kind: "workspace", workspaceId: t.workspaceId },
      actions: [
        { name: "agent-only", effect: "reading" },
        { name: "load", description: "Reads one row.", effect: "reading" },
        { name: "save", effect: "changing" }
      ]
    });
    const refused = await t.call(t.kai.id, "apps.actions.list", { query: { app: "orders" } });
    expect(refused.statusCode).toBe(403);
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

  // Each App carries actions; paging never splits an App’s actions.
  it("reaches every action of 201 Apps through bounded cursor pages", async () => {
    const names = discoveryNames("paging-app", 201);
    const template = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "app",
      name: "orders"
    });
    if (!template?.publishedConfig) throw new Error("Published App fixture is missing");
    const config = template.publishedConfig;
    await seedDiscoveryAssets(
      t.stores.configAssets,
      "app",
      names,
      (name) => ({ ...config, name }),
      { kind: "workspace", workspaceId: t.workspaceId }
    );

    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await t.call(t.admin.id, "apps.actions.list", {
        query: { limit: 200, ...(cursor ? { cursor } : {}) }
      });
      expectStatus(response, 200);
      const page = appActionsSchema.parse(response.json());
      expect(page.apps.length).toBeLessThanOrEqual(200);
      for (const app of page.apps.filter((app) => app.name.startsWith("paging-app-"))) {
        expect(app.actions.map((action) => action.name).sort()).toEqual([
          "agent-only",
          "load",
          "save"
        ]);
        found.push(app.name);
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(found).toEqual(names);
    // An asset grant on the final App must cross earlier unreadable pages.
    const last = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "app",
      name: names[200] ?? "missing"
    });
    if (!last) throw new Error("Last App is missing");
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.lena.id,
      action: "app.read",
      effect: "allow",
      scopeKind: "asset",
      scopeId: last.id,
      grantedBy: t.admin.id
    });
    const visibleResponse = await t.call(t.lena.id, "apps.actions.list", { query: { limit: 200 } });
    expectStatus(visibleResponse, 200);
    const visible = appActionsSchema.parse(visibleResponse.json());
    expect(visible.apps.map((app) => app.name)).toEqual([last.name]);
    expect(visible.nextCursor).toBeUndefined();
    expectStatus(
      await t.call(t.admin.id, "apps.actions.list", { query: { cursor: "invalid" } }),
      422
    );
  });
});
