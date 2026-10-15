import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { appActionsSchema } from "@work-shape/catalyst-api-contract";
import { clientInstanceId } from "./support/access-instance";
import { resultSchema } from "./support/app-actions";
import { expectStatus } from "./support/app-instance";
import { eventually } from "./support/assertions";
import { init, manifest } from "./support/data-store-world";
import { findingsApp, setupFindingsApp, type FindingsWorld } from "./support/findings-app";

// One walk from a store's folder to a row a member added, with every step made over the API:
// the asset operations for the store and the App, the member operation of the workspace, the
// list of the App's actions and the calls of its frame.

describe("an App on a Data Store, from its folder to a member's row", () => {
  let t: FindingsWorld;
  beforeAll(async () => {
    t = await setupFindingsApp();
  });
  afterAll(() => t.closeAll());

  it("walks the whole way over the API: a store and an App published by who holds the store's rights, then listed, read and added to by a member who holds the use of the App alone", async () => {
    // The store, written and published with the asset operations.
    const storeFiles = [{ ...manifest(), text: "id: ledger\nname: Ledger\n" }, init];
    const address = { params: { kind: "data_store", name: "ledger" } };
    expectStatus(
      await t.call(t.admin.id, "assets.put", {
        ...address,
        payload: { files: storeFiles, workspaceId: t.workspaceId }
      }),
      200
    );
    expectStatus(
      await t.call(t.admin.id, "assets.publish", {
        ...address,
        payload: { revision: 1, workspaceId: t.workspaceId }
      }),
      200
    );
    await eventually(async () => {
      expect(
        await t.stores.dataStores.findDataStoreByName({ clientInstanceId, name: "ledger" })
      ).toMatchObject({ status: "ready", level: 1 });
    });
    // The App, with one reading and one changing statement on that store.
    const written = await t.putApp(
      t.admin.id,
      "ledger-app",
      findingsApp({ id: "ledger-app", marker: "ledger", store: "ledger" })
    );
    expectStatus(written, 200);
    const { revision } = z.object({ revision: z.number() }).parse(written.json());
    expectStatus(await t.publish(t.admin.id, "ledger-app", revision), 200);
    // A member of the App's workspace, added over the API: no role beside `user`, no grant.
    const mia = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Mia",
      email: "mia@example.test",
      roles: ["user"],
      permissions: []
    });
    expectStatus(
      await t.call(t.admin.id, "workspaces.members.add", {
        params: { collaborationWorkspaceId: t.workspaceId },
        payload: { email: "mia@example.test" }
      }),
      200
    );

    // The list is read with `app.read`, which the use of an App does not give: the member is
    // refused it, and whoever builds the App reads it, of the draft.
    const refused = await t.call(mia.id, "apps.actions.list", { query: { app: "ledger-app" } });
    expect(refused.statusCode).toBe(403);
    expect(t.refusal(refused).details).toMatchObject({ action: "app.read" });
    const listed = await t.call(t.admin.id, "apps.actions.list", { query: { app: "ledger-app" } });
    expectStatus(listed, 200);
    const [app] = appActionsSchema.parse(listed.json()).apps;
    expect(app).toMatchObject({ name: "ledger-app", view: "draft" });
    expect(app?.actions.filter((action) => action.kind === "sql")).toEqual([
      {
        name: "add_finding",
        kind: "sql",
        effect: "changing",
        toolName: "app.ledger-app.add_finding",
        // With its title: the reader may read the store itself.
        dataStore: { name: "ledger", title: "Ledger" },
        inputSchema: expect.objectContaining({
          required: ["run", "client", "rule", "revision", "severity"]
        }),
        policy: "confirm",
        // No agent carries an action of a draft.
        agentTool: false,
        // A change from the draft is simulated (ADR-0031).
        target: "dry_run"
      },
      {
        name: "list_findings",
        kind: "sql",
        effect: "reading",
        toolName: "app.ledger-app.list_findings",
        dataStore: { name: "ledger", title: "Ledger" },
        inputSchema: expect.objectContaining({ required: ["limit", "offset"] }),
        policy: "allow",
        agentTool: false,
        target: "live"
      }
    ]);
    // A client that knows `connection` actions alone still reads those of the list.
    expect(app?.actions.find((action) => action.kind === "connection")).toMatchObject({
      name: "load",
      connection: { name: "crm" },
      operation: "echo"
    });

    const frame = await t.openApp(mia.id, "published", "ledger-app");
    const added = await t.callAction(
      mia.id,
      frame,
      "add_finding",
      { run: "walk", client: "client-walk", rule: "vat-rate", revision: 1, severity: "info" },
      { "idempotency-key": "b3-walk" }
    );
    expectStatus(added, 200);
    expect(resultSchema.parse(added.json())).toMatchObject({
      status: "done",
      result: { inserted: 1 }
    });
    const read = await t.callAction(mia.id, frame, "list_findings", { limit: 5, offset: 0 });
    expectStatus(read, 200);
    expect(resultSchema.parse(read.json()).result).toMatchObject({
      rows: [{ client_id: "client-walk", rule_id: "vat-rate", severity: "info", revision: 1 }]
    });
    // The store itself stays closed to the member.
    const direct = await t.invoke(mia, "data_store.ledger.query", { sql: "select 1" });
    expect(direct.result).toMatchObject({
      status: "denied",
      reason: { kind: "forbidden", action: "data_store.read" }
    });
  });
});
