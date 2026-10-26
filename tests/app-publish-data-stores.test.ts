import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { appPublishReviewSchema } from "@work-shape/catalyst-api-contract";
import { DATA_STORE_ASSET_KIND, asUserId } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { agentPublishes } from "./support/agent-publish-confirmation";
import { expectStatus } from "./support/app-instance";
import { eventually, required } from "./support/assertions";
import { init, type StoreFile } from "./support/data-store-world";
import { guardedEvents } from "./support/guardrails";
import { findingsApp, setupFindingsApp, type FindingsWorld } from "./support/findings-app";
import { runCli } from "@work-shape/catalyst-cli";
import { testOperations } from "./support/operations";
import { createTestFetch, getTestJobs } from "./support/test-instance";

// GOLIVE-1: the App's Publish carries the Data Stores it binds. Before it, an App whose
// manifest needs a store at `minSchema: 2` while the store was live at level 1 with migration 2
// in its draft was refused in English, and nothing offered the store's publish. Now the review
// lists the store with its migration, and one Publish publishes the store, waits for the
// migration and then makes the App live; a migration that fails leaves the App unpublished.
// The stores are real databases and the store's own migrate job applies the migrations.

const storeManifest = (name: string): StoreFile => ({
  path: "store.yaml",
  text: `id: ${name}\nname: Store ${name}\n`
});
/** A second migration that adds a column. */
const addNote: StoreFile = {
  path: "migrations/0002_add_note.sql",
  text: "alter table findings add column note text;\n"
};
/** A second migration that cannot be applied: the table it changes does not exist. */
const broken: StoreFile = {
  path: "migrations/0002_break_it.sql",
  text: "alter table missing_table add column note text;\n"
};

const pointersSchema = z.object({
  publishedRevision: z.number(),
  publishedWith: z
    .array(z.object({ kind: z.string(), name: z.string(), publishedRevision: z.number() }))
    .optional()
});
const heldSchema = z.object({
  status: z.literal("pending_approval"),
  approvalRequestId: z.string()
});

describe("GOLIVE-1: an App's Publish carries the Data Stores it binds", () => {
  let t: FindingsWorld;
  beforeAll(async () => {
    t = await setupFindingsApp({
      explicitCredentials: true,
      // The publish of the App golive-agent-app waits for an approver; the others are not held.
      events: (stores) =>
        guardedEvents(stores, {
          "held-app": {
            displayName: "The agent's App",
            on: "app.before_publish",
            check: {
              kind: "pattern",
              fields: ["name"],
              pattern: "^golive-agent-app$",
              reason: "Not without a look."
            },
            outcome: "require_approval"
          }
        }).events
    });
  });
  afterAll(() => t.closeAll());

  /**
   * A store live at level 1 with migration `second` in its draft, and the draft of an App
   * that needs it at `minSchema`. Answers the store draft's revision and the App's.
   */
  async function storeWithPendingMigration(
    name: string,
    app: string,
    second: StoreFile = addNote,
    minSchema = 2
  ) {
    await t.publishStore(name, [storeManifest(name), init], t.workspaceId);
    const store = await t.draftStore(name, [storeManifest(name), init, second], t.workspaceId);
    const written = await t.putApp(
      t.admin.id,
      app,
      findingsApp({ id: app, marker: app, store: name, minSchema })
    );
    expectStatus(written, 200);
    const { revision } = z.object({ revision: z.number() }).parse(written.json());
    return { store, app: revision };
  }

  const publishWith = (
    userId: string,
    app: string,
    revision: number,
    dataStores: { name: string; revision: number }[]
  ) =>
    t.call(userId, "assets.publish", {
      params: { kind: "app", name: app },
      payload: { revision, workspaceId: t.workspaceId, audience: "workspace", dataStores }
    });

  const review = async (app: string) =>
    appPublishReviewSchema.parse(
      (await t.expectOk(t.admin.id, "apps.publish_review", { params: { app } })).json()
    );

  const asset = (kind: string, name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
  const record = async (name: string) =>
    required(
      await t.stores.dataStores.getDataStore({
        clientInstanceId,
        id: required(await asset(DATA_STORE_ASSET_KIND, name)).id
      })
    );

  it("reviews the store with its live level, the level the App needs and its pending migration", async () => {
    const { store } = await storeWithPendingMigration("golive-review", "golive-review-app");

    const read = await review("golive-review-app");

    expect(read.dataStores).toEqual([
      expect.objectContaining({
        name: "golive-review",
        title: "Store golive-review",
        draftRevision: store,
        publishedRevision: 1,
        pending: true,
        liveLevel: 1,
        minSchema: 2,
        pendingMigrations: ["add_note"],
        refusals: []
      })
    ]);
    expect(read.ready).toBe(true);
  });

  // Check 66. Fails without GOLIVE-1: the publish was refused with data_store_below_min_schema.
  it("publishes the store, applies its migration and then makes the App live, with one Publish", async () => {
    const named = await storeWithPendingMigration("golive-one", "golive-one-app");

    const response = await publishWith(t.admin.id, "golive-one-app", named.app, [
      { name: "golive-one", revision: named.store }
    ]);

    expectStatus(response, 200);
    expect(pointersSchema.parse(response.json())).toEqual({
      publishedRevision: named.app,
      publishedWith: [
        { kind: DATA_STORE_ASSET_KIND, name: "golive-one", publishedRevision: named.store }
      ]
    });
    expect(await record("golive-one")).toMatchObject({ status: "ready", level: 2 });
    expect((await asset("app", "golive-one-app"))?.publishedRevision).toBe(named.app);
    // Nothing is pending any more: the review lists no store.
    expect((await review("golive-one-app")).dataStores).toEqual([]);
  });

  it("refuses a store whose draft stays below the level the App needs, in the review and before anything changes", async () => {
    const named = await storeWithPendingMigration("golive-low", "golive-low-app", addNote, 3);

    const read = await review("golive-low-app");
    expect(read.ready).toBe(false);
    expect(read.dataStores[0]?.refusals).toEqual([
      expect.objectContaining({ reason: "data_store_draft_below_min_schema" })
    ]);

    const refused = await publishWith(t.admin.id, "golive-low-app", named.app, [
      { name: "golive-low", revision: named.store }
    ]);
    expectStatus(refused, 409);
    expect(t.refusal(refused).details).toEqual({
      reason: "data_store_draft_below_min_schema",
      dataStore: "golive-low",
      title: "Store golive-low",
      minSchema: 3,
      level: 2
    });
    expect((await asset(DATA_STORE_ASSET_KIND, "golive-low"))?.publishedRevision).toBe(1);
    expect((await asset("app", "golive-low-app"))?.publishedRevision).toBeUndefined();
  });

  it("refuses to publish with the App a store its revision does not bind", async () => {
    const named = await storeWithPendingMigration("golive-bound", "golive-bound-app");
    await t.publishStore("golive-other", [storeManifest("golive-other"), init], t.workspaceId);
    const other = await t.draftStore(
      "golive-other",
      [storeManifest("golive-other"), init, addNote],
      t.workspaceId
    );

    const refused = await publishWith(t.admin.id, "golive-bound-app", named.app, [
      { name: "golive-other", revision: other }
    ]);

    expectStatus(refused, 422);
    expect(t.refusal(refused).details).toMatchObject({
      reason: "data_store_not_reached",
      dataStore: "golive-other"
    });
    expect((await asset(DATA_STORE_ASSET_KIND, "golive-other"))?.publishedRevision).toBe(1);
    expect((await asset("app", "golive-bound-app"))?.publishedRevision).toBeUndefined();
  });

  it("leaves the App unpublished when the store's migration fails, names the store and the migration, and publishes once it is mended", async () => {
    const named = await storeWithPendingMigration("golive-broken", "golive-broken-app", broken);

    const refused = await publishWith(t.admin.id, "golive-broken-app", named.app, [
      { name: "golive-broken", revision: named.store }
    ]);

    expectStatus(refused, 409);
    expect(t.refusal(refused)).toMatchObject({
      code: "CONFLICT",
      details: {
        reason: "data_store_migration_failed",
        dataStore: "golive-broken",
        title: "Store golive-broken",
        migration: "break_it",
        level: 1
      }
    });
    expect((await asset("app", "golive-broken-app"))?.publishedRevision).toBeUndefined();
    // The store's own publish stands, at the level it reached: migrations only go forward.
    expect((await asset(DATA_STORE_ASSET_KIND, "golive-broken"))?.publishedRevision).toBe(
      named.store
    );
    expect(await record("golive-broken")).toMatchObject({ level: 1 });

    // Fails while a store's publish keeps the failure an earlier attempt left on its record:
    // the publish of the mended migration read that failure as its own.
    const mended = await t.draftStore(
      "golive-broken",
      [storeManifest("golive-broken"), init, addNote],
      t.workspaceId
    );
    const published = await publishWith(t.admin.id, "golive-broken-app", named.app, [
      { name: "golive-broken", revision: mended }
    ]);
    expectStatus(published, 200);
    expect((await asset("app", "golive-broken-app"))?.publishedRevision).toBe(named.app);
    expect(await record("golive-broken")).toMatchObject({ level: 2 });
  });

  // Rights: the App's dialog never publishes a store its publisher may not publish.
  it("refuses a publisher without data_store.publish on the store before anything changes", async () => {
    const named = await storeWithPendingMigration("golive-rights", "golive-rights-app");
    const storeId = required(await asset(DATA_STORE_ASSET_KIND, "golive-rights")).id;

    await t.withRight(t.kai.id, "app.publish", { workspaceId: t.workspaceId }, () =>
      t.withRight(t.kai.id, "data_store.read", { assetId: storeId }, () =>
        t.withRight(t.kai.id, "data_store.insert", { assetId: storeId }, async () => {
          const refused = await publishWith(t.kai.id, "golive-rights-app", named.app, [
            { name: "golive-rights", revision: named.store }
          ]);
          expectStatus(refused, 403);
          expect(t.refusal(refused)).toMatchObject({
            code: "FORBIDDEN",
            details: expect.objectContaining({ action: "data_store.publish" })
          });
          // Below the App's level, the store's title and level are not told before the right.
          const below = await publishWith(t.kai.id, "golive-rights-app", named.app, [
            { name: "golive-rights", revision: 1 }
          ]);
          expectStatus(below, 403);
        })
      )
    );

    expect((await asset(DATA_STORE_ASSET_KIND, "golive-rights"))?.publishedRevision).toBe(1);
    expect(await record("golive-rights")).toMatchObject({ level: 1 });
    expect((await asset("app", "golive-rights-app"))?.publishedRevision).toBeUndefined();
  });

  it("holds the App and its store as one approval that only a holder of data_store.publish decides, and runs all three steps on approval", async () => {
    const named = await storeWithPendingMigration("golive-held", "golive-held-app");
    const storeId = required(await asset(DATA_STORE_ASSET_KIND, "golive-held")).id;
    const inWorkspace = { workspaceId: t.workspaceId };
    // A setting holds every publish of a Data Store, so the joint publish is held too.
    t.state.centralSettings = [
      { operation: "assets.publish", value: "approval", assetKind: DATA_STORE_ASSET_KIND }
    ];
    try {
      // Kai may publish the App and the store and approves nothing.
      await t.withRight(t.kai.id, "app.publish", inWorkspace, () =>
        t.withRight(t.kai.id, "data_store.publish", { assetId: storeId }, () =>
          t.withRight(t.kai.id, "data_store.read", { assetId: storeId }, () =>
            t.withRight(t.kai.id, "data_store.insert", { assetId: storeId }, async () => {
              const held = await publishWith(t.kai.id, "golive-held-app", named.app, [
                { name: "golive-held", revision: named.store }
              ]);
              expectStatus(held, 202);
              const { approvalRequestId } = heldSchema.parse(held.json());
              expect((await asset(DATA_STORE_ASSET_KIND, "golive-held"))?.publishedRevision).toBe(
                1
              );
              expect((await asset("app", "golive-held-app"))?.publishedRevision).toBeUndefined();

              const filed = await t.expectOk(t.root.id, "approval_requests.get", {
                params: { requestId: approvalRequestId }
              });
              expect(filed.json()).toMatchObject({
                kind: "app_publish",
                payload: {
                  subject: {
                    name: "golive-held-app",
                    publishedWith: [
                      {
                        kind: DATA_STORE_ASSET_KIND,
                        name: "golive-held",
                        revision: named.store,
                        liveRevision: 1
                      }
                    ]
                  }
                }
              });

              // Lena approves every App's publish and may not publish the store: she cannot
              // decide the item. With that right her approval makes it live. The API grants no
              // `approve` right, so it is written as a row.
              const approver = await t.stores.access.createGrant({
                clientInstanceId,
                holderKind: "user",
                holderId: t.lena.id,
                action: "app.approve",
                effect: "allow",
                scopeKind: "instance",
                grantedBy: asUserId(t.root.id)
              });
              try {
                const canDecide = async () =>
                  z.object({ canDecide: z.boolean() }).parse(
                    (
                      await t.expectOk(t.lena.id, "approval_requests.get", {
                        params: { requestId: approvalRequestId }
                      })
                    ).json()
                  ).canDecide;
                const decide = () =>
                  t.call(t.lena.id, "approval_requests.decide", {
                    params: { requestId: approvalRequestId },
                    payload: { decision: "approve" }
                  });
                expect(await canDecide()).toBe(false);
                expectStatus(await decide(), 403);
                expect((await asset("app", "golive-held-app"))?.publishedRevision).toBeUndefined();

                await t.withRight(
                  t.lena.id,
                  "data_store.publish",
                  { assetId: storeId },
                  async () => {
                    expect(await canDecide()).toBe(true);
                    expectStatus(await decide(), 200);
                  }
                );
              } finally {
                await t.stores.access.deleteGrant({ clientInstanceId, grantId: approver.id });
              }
              await getTestJobs(t.instance).runDue();
              await eventually(async () => {
                expect((await asset("app", "golive-held-app"))?.publishedRevision).toBe(named.app);
              }, 30_000);
            })
          )
        )
      );
    } finally {
      t.state.centralSettings = [];
    }
    expect(await record("golive-held")).toMatchObject({ status: "ready", level: 2 });
    expect((await asset(DATA_STORE_ASSET_KIND, "golive-held"))?.publishedRevision).toBe(
      named.store
    );
  });

  // DP-3 rights review: an agent's publish of the App and its store asks its person every right
  // the held item asks of who decides it, here data_store.publish on the store.
  it("refuses an agent's publish of the App and its store for a person without data_store.publish, and publishes it on their confirmation with the right", async () => {
    const named = await storeWithPendingMigration("golive-agent", "golive-agent-app");
    const storeId = required(await asset(DATA_STORE_ASSET_KIND, "golive-agent")).id;
    const input = {
      kind: "app",
      name: "golive-agent-app",
      revision: named.app,
      workspaceId: t.workspaceId,
      audience: "workspace",
      dataStores: [{ name: "golive-agent", revision: named.store }]
    };
    // Kai may publish the App and approve an App's publish, and may not publish the store.
    const approver = await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "app.approve",
      effect: "allow",
      scopeKind: "instance",
      grantedBy: asUserId(t.root.id)
    });
    try {
      await t.withRight(t.kai.id, "app.publish", { workspaceId: t.workspaceId }, () =>
        t.withRight(t.kai.id, "data_store.read", { assetId: storeId }, () =>
          t.withRight(t.kai.id, "data_store.insert", { assetId: storeId }, async () => {
            // Without the store's own publish right the agent's call is refused before Kai
            // is asked, as Kai's own publish is.
            const { made } = await agentPublishes(t, t.workspaceId, input, "store-without");
            expect(made.run).toMatchObject({
              status: "denied",
              denial: { kind: "forbidden", action: "data_store.publish" }
            });
            expect((await asset(DATA_STORE_ASSET_KIND, "golive-agent"))?.publishedRevision).toBe(1);
            expect(await record("golive-agent")).toMatchObject({ level: 1 });
            expect((await asset("app", "golive-agent-app"))?.publishedRevision).toBeUndefined();

            await t.withRight(t.kai.id, "data_store.publish", { assetId: storeId }, async () => {
              const confirmed = await (
                await agentPublishes(t, t.workspaceId, input, "store-with")
              ).confirm();
              expect(confirmed).toMatchObject({
                execution: "done",
                run: { decision: { mode: "approved", reason: "approved_by_caller" } }
              });
            });
          })
        )
      );
    } finally {
      await t.stores.access.deleteGrant({ clientInstanceId, grantId: approver.id });
    }
    expect(await record("golive-agent")).toMatchObject({ status: "ready", level: 2 });
    expect((await asset("app", "golive-agent-app"))?.publishedRevision).toBe(named.app);
  });

  it("names the store and its migration in `catalyst app publish` and publishes them with the App on one yes", async () => {
    const named = await storeWithPendingMigration("golive-cli", "golive-cli-app");
    const serverFetch = createTestFetch(t.instance, { "x-test-user": t.admin.id });
    const out: string[] = [];
    const err: string[] = [];

    const code = await runCli(
      [
        "app",
        "publish",
        "golive-cli-app",
        "--audience",
        "workspace",
        "--workspace",
        t.workspaceId,
        "--instance",
        "https://catalyst.test"
      ],
      {
        cwd: process.cwd(),
        env: { CATALYST_API_KEY: "cat_personal" },
        fetchImpl: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (new URL(request.url).pathname === testOperations["access_tokens.exchange"].path) {
            return Response.json({
              accessToken: "access-token",
              expiresAt: new Date(Date.now() + 60_000).toISOString()
            });
          }
          return serverFetch(request);
        },
        prompt: () => Promise.resolve("y"),
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text)
      }
    );

    expect(code, err.join("")).toBe(0);
    expect(out.join("")).toContain(
      `Data Store 'Store golive-cli' (golive-cli): revision ${named.store} in place of 1, at level 1, applies 1 migration: add_note`
    );
    expect(out.join("")).toContain(`Published revision ${named.store} of Data Store 'golive-cli'.`);
    expect(await record("golive-cli")).toMatchObject({ level: 2 });
    expect((await asset("app", "golive-cli-app"))?.publishedRevision).toBe(named.app);
  });
});
