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
    expect(app?.actions.filter((action) => "kind" in action && action.kind === "sql")).toEqual([
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
    expect(
      app?.actions.find((action) => "kind" in action && action.kind === "connection")
    ).toMatchObject({
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
  it("ACCEPT-FIX-11 B-1: an App of one person's workspace already live for the instance still opens for another member and reads its stored data", async () => {
    const owner = await t.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: t.admin.id
    });
    const viewer = await t.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: t.lena.id
    });
    await t.publishStore(
      "personal-ledger",
      [{ ...manifest(), text: "id: personal-ledger\nname: Personal ledger\n" }, init],
      owner.id
    );
    const inserted = await t.invoke(
      t.admin,
      "data_store.personal-ledger.insert",
      {
        table: "findings",
        rows: [
          {
            run_id: "shared",
            client_id: "Nordlicht",
            rule_id: "deadline",
            revision: 1,
            severity: "info"
          }
        ]
      },
      { effect: "changing", origin: { kind: "user" } }
    );
    expect(inserted.result.status).toBe("done");
    expectStatus(
      await t.call(t.admin.id, "assets.put", {
        params: { kind: "app", name: "personal-ledger-app" },
        payload: {
          workspaceId: owner.id,
          files: findingsApp({
            id: "personal-ledger-app",
            marker: "shared data",
            store: "personal-ledger"
          })
        }
      }),
      200
    );
    expectStatus(
      await t.call(t.admin.id, "assets.publish", {
        params: { kind: "app", name: "personal-ledger-app" },
        payload: { workspaceId: owner.id, revision: 1, audience: "self" }
      }),
      200
    );
    // No publish makes such an App live for everyone any more (MOVE-1, check 65); one that
    // already is keeps running until its next publish, as it was left here.
    const app = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "app",
      name: "personal-ledger-app"
    });
    await t.stores.configAssets.setAgentAvailability({
      clientInstanceId,
      kind: "app",
      agentName: "personal-ledger-app",
      ...(app ? { expectedAssetId: app.id } : {}),
      availability: { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] }
    });
    const preview = await t.call(t.lena.id, "apps.preview", {
      params: { app: "personal-ledger-app" },
      payload: { mode: "published" }
    });
    expectStatus(preview, 200);
    expect(z.looseObject({ interfacePath: z.string() }).parse(preview.json()).interfacePath).toBe(
      `/w/${viewer.id}/apps/personal-ledger-app`
    );
    expectStatus(
      await t.call(t.lena.id, "assets.get", {
        params: { kind: "app", name: "personal-ledger-app" },
        query: { workspaceId: viewer.id }
      }),
      200
    );
    const sources = await t.call(t.lena.id, "data_stores.app_sources", {
      query: { app: "personal-ledger-app" }
    });
    expectStatus(sources, 200);
    expect(sources.json()).toMatchObject({
      stores: [{ name: "personal-ledger", title: "Personal ledger" }]
    });
    const frame = await t.openApp(t.lena.id, "published", "personal-ledger-app");
    const read = await t.callAction(t.lena.id, frame, "list_findings", { limit: 10, offset: 0 });
    expectStatus(read, 200);
    expect(resultSchema.parse(read.json())).toMatchObject({
      status: "done",
      result: { rows: [{ client_id: "Nordlicht" }] }
    });
    // Stored data follows the App audience, while the store and the owner's transcript stay private.
    expect(
      (await t.invoke(t.lena, "data_store.personal-ledger.query", { sql: "select 1" })).result
        .status
    ).toBe("denied");
    expect(
      await t.stores.workspaces.getMembership({
        clientInstanceId,
        collaborationWorkspaceId: owner.id,
        userId: t.lena.id
      })
    ).toBeUndefined();

    const operation = await t.dataStores.operationSource.resolve(
      "data_store.personal-ledger.used_by"
    );
    expect(operation).toBeDefined();
    // The ordinary operation path provides the page's provenance, including the published audience.
    const usage = await t.invoke(t.admin, "data_store.personal-ledger.used_by", {});
    expect(usage.result).toMatchObject({
      status: "done",
      output: {
        apps: [
          {
            audience: {
              app: {
                audience: "instance",
                people: await t.stores.users.countActiveUsers({ clientInstanceId })
              },
              holders: [],
              hiddenHolders: 0
            }
          }
        ]
      }
    });
    if (usage.result.status === "done") {
      expect(JSON.stringify(usage.result.output)).not.toContain("Personal workspace");
    }
  });
});
