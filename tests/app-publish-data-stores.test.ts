import postgres from "postgres";
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
import { fileTestDatabaseUrl } from "./support/test-database";
import { instanceWorkflowAssetKind } from "./support/workflow-instance";
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
      modules: { workflows: { enabled: true } },
      furtherKinds: [
        instanceWorkflowAssetKind(
          () => t.stores,
          () => undefined
        )
      ],
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
        // CHAT-LINK-1: each entry names its page, so the agent links the place to act.
        href: "/build/data-stores/golive-review",
        refusals: []
      })
    ]);
    expect(read.app.href).toBe(`/w/${t.workspaceId}/app-drafts/golive-review-app`);
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

  it("pre-checks a named store at its first revision before its runtime record exists", async () => {
    const name = "golive-new-store";
    const app = `${name}-app`;
    const store = await t.draftStore(name, [storeManifest(name), init], t.workspaceId);
    expect(
      await t.stores.dataStores.getDataStore({
        clientInstanceId,
        id: required(await asset(DATA_STORE_ASSET_KIND, name)).id
      })
    ).toBeUndefined();
    expectStatus(
      await t.putApp(t.admin.id, app, findingsApp({ id: app, marker: app, store: name })),
      200
    );

    expectStatus(await publishWith(t.admin.id, app, 1, [{ name, revision: store }]), 200);

    expect(await record(name)).toMatchObject({ status: "ready", level: 1 });
    expect((await asset("app", app))?.publishedRevision).toBe(1);
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

  // GOLIVE-1 follow-up. Fails while the App's own checks run after its stores are published:
  // the store went live for an App the set refused.
  it("asks the App's own checks before it publishes a store, so their refusal publishes none", async () => {
    await t.publishStore("golive-first", [storeManifest("golive-first"), init], t.workspaceId);
    const store = await t.draftStore(
      "golive-first",
      [storeManifest("golive-first"), init, addNote],
      t.workspaceId
    );
    // The App names a second Connection, which is gone by the time the App is published.
    const crm = required(await asset("connection", "crm"));
    const gone = "connection:golive-gone";
    const made = await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [gone]: null },
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "golive-gone",
          config: { ...crm.config, name: "golive-gone" }
        }
      ]
    });
    const files = findingsApp({
      id: "golive-first-app",
      marker: "golive-first-app",
      store: "golive-first",
      minSchema: 2
    }).map((file) => {
      if (file.path !== "app.yaml" || !("text" in file)) return file;
      const manifest = z.record(z.string(), z.unknown()).parse(JSON.parse(file.text));
      return {
        ...file,
        text: JSON.stringify({ ...manifest, connections: ["crm", "golive-gone"] })
      };
    });
    const written = await t.putApp(t.admin.id, "golive-first-app", files);
    expectStatus(written, 200);
    const { revision } = z.object({ revision: z.number() }).parse(written.json());
    await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [gone]: required(made.revisions[gone]) },
      mutations: [{ type: "delete", kind: "connection", name: "golive-gone", scope: crm.scope }]
    });

    const refused = await publishWith(t.admin.id, "golive-first-app", revision, [
      { name: "golive-first", revision: store }
    ]);

    expectStatus(refused, 422);
    expect(JSON.stringify(t.refusal(refused))).toContain("golive-gone");
    expect((await asset(DATA_STORE_ASSET_KIND, "golive-first"))?.publishedRevision).toBe(1);
    expect(await record("golive-first")).toMatchObject({ level: 1 });
    expect((await asset("app", "golive-first-app"))?.publishedRevision).toBeUndefined();
  });

  it.each(["unpublished", "below_min_schema"] as const)(
    "checks an unnamed bound store that is %s before publishing a named store",
    async (fault) => {
      const name = `golive-unnamed-${fault.replaceAll("_", "-")}`;
      const app = `${name}-app`;
      const other = `${name}-other`;
      const named = await storeWithPendingMigration(name, app);
      if (fault === "unpublished") {
        await t.draftStore(other, [storeManifest(other), init], t.workspaceId);
      } else {
        await t.publishStore(other, [storeManifest(other), init], t.workspaceId);
      }
      const files = findingsApp({ id: app, marker: app, store: name, minSchema: 2 })
        .filter((file) => !file.path.endsWith(".sql"))
        .map((file) => {
          if (file.path !== "app.yaml" || !("text" in file)) return file;
          const manifest = z.record(z.string(), z.unknown()).parse(JSON.parse(file.text));
          return {
            ...file,
            text: JSON.stringify({
              ...manifest,
              actions: [],
              dataStores: [
                { name, minSchema: 2 },
                { name: other, minSchema: 2 }
              ]
            })
          };
        });
      expectStatus(await t.putApp(t.admin.id, app, files), 200);
      const refused = await publishWith(t.admin.id, app, 2, [{ name, revision: named.store }]);
      expectStatus(refused, fault === "unpublished" ? 404 : 409);
      expect(t.refusal(refused).details).toMatchObject({
        reason: fault === "unpublished" ? "data_store_unavailable" : "data_store_below_min_schema",
        dataStore: other
      });
      expect((await asset(DATA_STORE_ASSET_KIND, name))?.publishedRevision).toBe(1);
      expect(await record(name)).toMatchObject({ level: 1 });
      expect((await asset("app", app))?.publishedRevision).toBeUndefined();
    }
  );

  it.each(["read", "insert"] as const)(
    "checks the publisher's sql action right data_store.%s before publishing a store",
    async (missing) => {
      const name = `golive-sql-${missing}`;
      const app = `${name}-app`;
      const named = await storeWithPendingMigration(name, app);
      const storeId = required(await asset(DATA_STORE_ASSET_KIND, name)).id;
      await t.withRight(t.kai.id, "app.publish", { workspaceId: t.workspaceId }, () =>
        t.withRight(t.kai.id, "data_store.publish", { assetId: storeId }, () =>
          t.withRight(
            t.kai.id,
            `data_store.${missing === "read" ? "insert" : "read"}`,
            { assetId: storeId },
            async () => {
              const refused = await publishWith(t.kai.id, app, named.app, [
                { name, revision: named.store }
              ]);
              expectStatus(refused, 403);
              expect(t.refusal(refused).details).toMatchObject({ action: `data_store.${missing}` });
            }
          )
        )
      );
      expect((await asset(DATA_STORE_ASSET_KIND, name))?.publishedRevision).toBe(1);
      expect(await record(name)).toMatchObject({ level: 1 });
      expect((await asset("app", app))?.publishedRevision).toBeUndefined();
    }
  );

  it("checks the App's built files before publishing a store", async () => {
    const name = "golive-no-files";
    const app = `${name}-app`;
    const named = await storeWithPendingMigration(name, app);
    const revision = required(
      await t.stores.configAssets.getConfigAssetRevision({
        clientInstanceId,
        kind: "app",
        name: app,
        revision: named.app
      })
    );
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      await sql`delete from file_sets where id = ${required(revision.fileSetId)}`;
    } finally {
      await sql.end();
    }
    const refused = await publishWith(t.admin.id, app, named.app, [
      { name, revision: named.store }
    ]);
    expectStatus(refused, 422);
    expect(t.refusal(refused).details).toEqual({
      reason: "revision_files_removed",
      revision: named.app
    });
    expect((await asset(DATA_STORE_ASSET_KIND, name))?.publishedRevision).toBe(1);
    expect(await record(name)).toMatchObject({ level: 1 });
    expect((await asset("app", app))?.publishedRevision).toBeUndefined();
  });

  it.each(["unpublished", "input", "use", "named-input", "named-valid"] as const)(
    "checks the App's Workflow before publishing a store: %s",
    async (fault) => {
      const name = `golive-wf-${fault}`;
      const app = `${name}-app`;
      const workflow = `${name}-flow`;
      const named = await storeWithPendingMigration(name, app);
      const config = (requiredInput: boolean) => ({
        name: workflow,
        manifest: {
          id: workflow,
          name: "Review",
          outputs: { type: "object", properties: {} },
          inputs: {
            type: "object",
            properties: { page: { type: "string" } },
            ...(requiredInput ? { required: ["page"] } : {})
          },
          steps: [
            { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
            { id: "result", name: "Result", type: "output", input: {} }
          ]
        }
      });
      const put = (expectedRevision: number | null, requiredInput: boolean) =>
        t.expectOk(t.root.id, "assets.put", {
          params: { kind: "workflow", name: workflow },
          payload: { config: config(requiredInput), expectedRevision }
        });
      await put(null, fault === "input" || fault === "named-valid");
      if (fault !== "unpublished") {
        expectStatus(
          await t.call(t.root.id, "assets.publish", {
            params: { kind: "workflow", name: workflow },
            payload: { revision: 1 }
          }),
          200
        );
      }
      const jointly = fault === "named-input" || fault === "named-valid";
      if (jointly) await put(1, fault === "named-input");
      const files = [
        ...findingsApp({ id: app, marker: app, store: name, minSchema: 2 }).map((file) => {
          if (file.path !== "app.yaml" || !("text" in file)) return file;
          const manifest = z.record(z.string(), z.unknown()).parse(JSON.parse(file.text));
          return { ...file, text: JSON.stringify({ ...manifest, kit: "1.3.0" }) };
        }),
        {
          path: "actions/review.action.yaml",
          text: `workflow: ${workflow}\ninput:\n  schema: { type: object, properties: {} }\n  mapping: {}\n`
        }
      ];
      expectStatus(await t.putApp(t.admin.id, app, files), 200);
      const publish = (userId: string) =>
        t.call(userId, "assets.publish", {
          params: { kind: "app", name: app },
          payload: {
            revision: 2,
            workspaceId: t.workspaceId,
            audience: "workspace",
            dataStores: [{ name, revision: named.store }],
            ...(jointly ? { workflows: [{ name: workflow, revision: 2 }] } : {})
          }
        });
      const check = async (userId: string) => {
        const response = await publish(userId);
        expectStatus(
          response,
          fault === "named-valid"
            ? 200
            : fault === "use"
              ? 403
              : fault === "unpublished"
                ? 404
                : 422
        );
        if (fault !== "named-valid") {
          expect(t.refusal(response).details).toMatchObject(
            fault === "use"
              ? { action: "workflow.use" }
              : {
                  reason:
                    fault === "unpublished" ? "workflow_unavailable" : "workflow_input_invalid"
                }
          );
        }
      };
      if (fault === "use") {
        const storeId = required(await asset(DATA_STORE_ASSET_KIND, name)).id;
        await t.withRight(t.kai.id, "app.publish", { workspaceId: t.workspaceId }, () =>
          t.withRight(t.kai.id, "data_store.publish", { assetId: storeId }, () =>
            t.withRight(t.kai.id, "data_store.read", { assetId: storeId }, () =>
              t.withRight(t.kai.id, "data_store.insert", { assetId: storeId }, () =>
                check(t.kai.id)
              )
            )
          )
        );
      } else await check(t.admin.id);
      expect((await asset(DATA_STORE_ASSET_KIND, name))?.publishedRevision).toBe(
        fault === "named-valid" ? named.store : 1
      );
      expect(await record(name)).toMatchObject({ level: fault === "named-valid" ? 2 : 1 });
      expect((await asset("app", app))?.publishedRevision).toBe(
        fault === "named-valid" ? 2 : undefined
      );
    }
  );

  // GOLIVE-1 follow-up. Fails while the App's Publish waits only for the stores it names: a
  // store an earlier Publish made live and whose wait ran out was carried by no later one, and
  // the App was refused with data_store_below_min_schema.
  it("waits for a live store still applying the migrations the App needs, and lists it in the review", async () => {
    const named = await storeWithPendingMigration("golive-again", "golive-again-app");
    const storeAsset = required(await asset(DATA_STORE_ASSET_KIND, "golive-again"));
    const stored = required(
      await t.stores.configAssets.getConfigAssetRevision({
        clientInstanceId,
        kind: DATA_STORE_ASSET_KIND,
        name: "golive-again",
        revision: named.store
      })
    );
    // As an earlier Publish of the App left it: the store's pointer moved, its migration not
    // applied yet.
    await t.stores.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      name: "golive-again",
      assetId: storeAsset.id,
      revision: named.store,
      revisionId: stored.id
    });

    const read = await review("golive-again-app");
    expect(read.dataStores).toEqual([
      expect.objectContaining({
        name: "golive-again",
        pending: false,
        liveLevel: 1,
        minSchema: 2,
        pendingMigrations: ["add_note"],
        refusals: []
      })
    ]);
    expect(read.ready).toBe(true);

    // Publishing again names no store and waits for it; the store's migrate job is queued
    // while the Publish waits.
    const publishing = publishWith(t.admin.id, "golive-again-app", named.app, []);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expectStatus(
      await t.call(t.admin.id, "assets.publish", {
        params: { kind: DATA_STORE_ASSET_KIND, name: "golive-again" },
        payload: { revision: named.store, workspaceId: t.workspaceId }
      }),
      200
    );

    expectStatus(await publishing, 200);
    expect(await record("golive-again")).toMatchObject({ status: "ready", level: 2 });
    expect((await asset("app", "golive-again-app"))?.publishedRevision).toBe(named.app);
    expect((await review("golive-again-app")).dataStores).toEqual([]);
  });

  // GOLIVE-1 follow-up review: a live store whose job ended in a failure is refused at once,
  // and a store the publisher may not publish is not waited for, so its failure is not told.
  it.each(["migration_failed", "job_exhausted"])(
    "refuses a live store with %s, and waits only for a store its publisher may publish",
    async (failureCode) => {
      const name = `golive-stuck-${failureCode.replaceAll("_", "-")}`;
      const app = `${name}-app`;
      const reason =
        failureCode === "job_exhausted"
          ? "data_store_job_exhausted"
          : "data_store_migration_failed";
      const named = await storeWithPendingMigration(name, app);
      const storeAsset = required(await asset(DATA_STORE_ASSET_KIND, name));
      const stored = required(
        await t.stores.configAssets.getConfigAssetRevision({
          clientInstanceId,
          kind: DATA_STORE_ASSET_KIND,
          name,
          revision: named.store
        })
      );
      await t.stores.configAssets.publishConfigAssetRevision({
        clientInstanceId,
        kind: DATA_STORE_ASSET_KIND,
        name,
        assetId: storeAsset.id,
        revision: named.store,
        revisionId: stored.id
      });
      await t.stores.dataStores.putDataStore({
        ...(await record(name)),
        failure: { code: failureCode, message: "The database said no." }
      });

      const read = await review(app);
      expect(read.dataStores[0]?.refusals).toEqual([expect.objectContaining({ reason })]);
      expect(read.ready).toBe(false);
      const refused = await publishWith(t.admin.id, app, named.app, []);
      expectStatus(refused, 409);
      expect(t.refusal(refused).details).toMatchObject({
        reason,
        migration: "add_note",
        failure: "The database said no."
      });

      const storeId = storeAsset.id;
      await t.withRight(t.kai.id, "app.publish", { workspaceId: t.workspaceId }, () =>
        t.withRight(t.kai.id, "data_store.read", { assetId: storeId }, () =>
          t.withRight(t.kai.id, "data_store.insert", { assetId: storeId }, async () => {
            const below = await publishWith(t.kai.id, app, named.app, []);
            expectStatus(below, 409);
            expect(t.refusal(below).details).toEqual({
              reason: "data_store_below_min_schema",
              dataStore: name,
              minSchema: 2,
              level: 1
            });
          })
        )
      );
      expect((await asset("app", app))?.publishedRevision).toBeUndefined();
    }
  );

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

  // A guard beside the DP-3 rights fix: the store's further right, data_store.publish, is asked
  // of the person up front, before the confirmation, so their click never lacks it.
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
