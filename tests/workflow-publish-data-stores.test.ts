import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { DATA_STORE_ASSET_KIND, WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { expectStatus } from "./support/app-instance";
import { eventually, required } from "./support/assertions";
import { init, type StoreFile } from "./support/data-store-world";
import { setupFindingsApp, type FindingsWorld } from "./support/findings-app";
import { runCli } from "@work-shape/catalyst-cli";
import { testOperations } from "./support/operations";
import { createTestFetch, getTestJobs } from "./support/test-instance";
import { instanceWorkflowAssetKind } from "./support/workflow-instance";

// LIVE-2: one Publish of a Workflow makes it live with the Data Store drafts its steps call.
// Before it, a Workflow whose store had a pending migration was published on its own, and the
// store waited for its own Publish; GOLIVE-1 carried stores with an App's Publish only. Now the
// Workflow's read names the store with its migration beside the line on its own account, and
// one Publish publishes the store, waits for the migration, then makes the Workflow live with
// its account and grants (LIVE-1). A migration that fails leaves the live revision unchanged.
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
const readSchema = z.object({
  publishQuestion: z.array(z.string()).optional(),
  publishDataStores: z
    .array(
      z.object({
        name: z.string(),
        title: z.string(),
        revision: z.number(),
        publishedRevision: z.number().optional(),
        liveLevel: z.number(),
        pendingMigrations: z.array(z.string())
      })
    )
    .optional()
});

/** A Workflow without `runAs` that adds rows to `store`, as its own account (LIVE-1). */
const workflowConfig = (name: string, store: string, more: Record<string, unknown> = {}) => ({
  name,
  manifest: {
    id: name,
    name: "Import findings",
    ...more,
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "store",
        name: "Store",
        type: "operation",
        operation: `data_store.${store}.insert`,
        input: {}
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  }
});

describe("LIVE-2: one Publish of a Workflow makes it live with its Data Stores", () => {
  let t: FindingsWorld;
  beforeAll(async () => {
    t = await setupFindingsApp({
      explicitCredentials: true,
      modules: { workflows: { enabled: true } },
      furtherKinds: [
        instanceWorkflowAssetKind(
          () => t.stores,
          () => t.operationCalls.registry
        )
      ]
    });
  });
  afterAll(() => t.closeAll());

  const asset = (kind: string, name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
  const record = async (name: string) =>
    required(
      await t.stores.dataStores.getDataStore({
        clientInstanceId,
        id: required(await asset(DATA_STORE_ASSET_KIND, name)).id
      })
    );
  const putWorkflow = async (
    name: string,
    store: string,
    expectedRevision: number | null,
    more?: Record<string, unknown>
  ) =>
    z.object({ revision: z.number() }).parse(
      (
        await t.expectOk(t.root.id, "assets.put", {
          params: { kind: WORKFLOW_ASSET_KIND, name },
          payload: { config: workflowConfig(name, store, more), expectedRevision }
        })
      ).json()
    ).revision;
  const publishWorkflow = (
    userId: string,
    name: string,
    revision: number,
    dataStores?: { name: string; revision: number }[]
  ) =>
    t.call(userId, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name },
      payload: { revision, ...(dataStores ? { dataStores } : {}) }
    });
  const readWorkflow = async (userId: string, name: string) =>
    readSchema.parse(
      (
        await t.expectOk(userId, "assets.get", { params: { kind: WORKFLOW_ASSET_KIND, name } })
      ).json()
    );
  const accountOf = async (name: string) =>
    t.stores.apiAccess.findServicePrincipalByOwner({
      clientInstanceId,
      owner: { kind: "workflow", assetId: required(await asset(WORKFLOW_ASSET_KIND, name)).id }
    });

  /** Runs `work` while kai holds each right on its asset. */
  const holding = async (rights: [string, string][], work: () => Promise<void>): Promise<void> => {
    const [first, ...rest] = rights;
    if (!first) return work();
    return t.withRight(t.kai.id, first[0], { assetId: first[1] }, () => holding(rest, work));
  };

  /**
   * A store of the instance live at level 1 with `second` in its draft, and a Workflow that
   * adds rows to it, published once at revision 1 and with a draft at revision 2. Answers the
   * store draft's revision.
   */
  async function liveWorkflowWithPendingStore(store: string, workflow: string, second = addNote) {
    await t.publishStore(store, [storeManifest(store), init]);
    expect(await putWorkflow(workflow, store, null)).toBe(1);
    expectStatus(await publishWorkflow(t.root.id, workflow, 1), 200);
    expect(await putWorkflow(workflow, store, 1)).toBe(2);
    return t.draftStore(store, [storeManifest(store), init, second]);
  }

  it("names the store's pending migration and the Workflow's own account in its one question", async () => {
    const store = await liveWorkflowWithPendingStore("live2-review", "live2-review-flow");

    const read = await readWorkflow(t.root.id, "live2-review-flow");

    expect(read.publishDataStores).toEqual([
      {
        name: "live2-review",
        title: "Store live2-review",
        revision: store,
        publishedRevision: 1,
        liveLevel: 1,
        pendingMigrations: ["add_note"]
      }
    ]);
    expect(read.publishQuestion).toContain(
      "Runs as its own account “Import findings” and may add rows to Store live2-review."
    );
  });

  // Check 78. Fails without LIVE-2: a Workflow's publish that named stores was refused with
  // data_stores_without_app, and its store stayed at level 1.
  it("applies the store's migration and makes the revision live with one Publish", async () => {
    const store = await liveWorkflowWithPendingStore("live2-one", "live2-one-flow");

    const response = await publishWorkflow(t.root.id, "live2-one-flow", 2, [
      { name: "live2-one", revision: store }
    ]);

    expectStatus(response, 200);
    expect(pointersSchema.parse(response.json())).toEqual({
      publishedRevision: 2,
      publishedWith: [{ kind: DATA_STORE_ASSET_KIND, name: "live2-one", publishedRevision: store }]
    });
    expect(await record("live2-one")).toMatchObject({ status: "ready", level: 2 });
    expect((await asset(WORKFLOW_ASSET_KIND, "live2-one-flow"))?.publishedRevision).toBe(2);
    // The Workflow's own account holds the grant its step needs on the store (LIVE-1).
    const account = required(await accountOf("live2-one-flow"));
    const grants = await t.stores.access.listGrants({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: account.id
    });
    expect(grants).toEqual([
      expect.objectContaining({
        action: "data_store.insert",
        scopeKind: "asset",
        scopeId: required(await asset(DATA_STORE_ASSET_KIND, "live2-one")).id
      })
    ]);
    // Nothing is pending any more: the question names no store.
    expect((await readWorkflow(t.root.id, "live2-one-flow")).publishDataStores).toBeUndefined();
  });

  it("creates the account and its grants with the store at the Workflow's first Publish", async () => {
    const name = "live2-first";
    const store = await t.draftStore(name, [storeManifest(name), init]);
    expect(await putWorkflow(`${name}-flow`, name, null)).toBe(1);
    expect((await readWorkflow(t.root.id, `${name}-flow`)).publishDataStores).toEqual([
      expect.objectContaining({ name, liveLevel: 0, pendingMigrations: ["init"] })
    ]);

    expectStatus(
      await publishWorkflow(t.root.id, `${name}-flow`, 1, [{ name, revision: store }]),
      200
    );

    expect(await record(name)).toMatchObject({ status: "ready", level: 1 });
    expect((await asset(WORKFLOW_ASSET_KIND, `${name}-flow`))?.publishedRevision).toBe(1);
    expect(await accountOf(`${name}-flow`)).toBeDefined();
  });

  it("leaves the store at its level and the live revision unchanged when the migration fails, and carries on once it is mended", async () => {
    const store = await liveWorkflowWithPendingStore("live2-broken", "live2-broken-flow", broken);

    const refused = await publishWorkflow(t.root.id, "live2-broken-flow", 2, [
      { name: "live2-broken", revision: store }
    ]);

    expectStatus(refused, 409);
    expect(t.refusal(refused)).toMatchObject({
      code: "CONFLICT",
      details: {
        reason: "data_store_migration_failed",
        dataStore: "live2-broken",
        title: "Store live2-broken",
        migration: "break_it",
        level: 1,
        publishing: "workflow"
      }
    });
    expect(t.refusal(refused).message).toContain("so the Workflow was not published");
    expect((await asset(WORKFLOW_ASSET_KIND, "live2-broken-flow"))?.publishedRevision).toBe(1);
    expect(await record("live2-broken")).toMatchObject({ level: 1 });

    const mended = await t.draftStore("live2-broken", [
      storeManifest("live2-broken"),
      init,
      addNote
    ]);
    const published = await publishWorkflow(t.root.id, "live2-broken-flow", 2, [
      { name: "live2-broken", revision: mended }
    ]);
    expectStatus(published, 200);
    expect((await asset(WORKFLOW_ASSET_KIND, "live2-broken-flow"))?.publishedRevision).toBe(2);
    expect(await record("live2-broken")).toMatchObject({ level: 2 });
  });

  it("refuses to publish with the Workflow a store its revision does not call, before anything changes", async () => {
    const store = await liveWorkflowWithPendingStore("live2-called", "live2-called-flow");
    await t.publishStore("live2-other", [storeManifest("live2-other"), init]);
    const other = await t.draftStore("live2-other", [storeManifest("live2-other"), init, addNote]);

    const refused = await publishWorkflow(t.root.id, "live2-called-flow", 2, [
      { name: "live2-called", revision: store },
      { name: "live2-other", revision: other }
    ]);

    expectStatus(refused, 422);
    expect(t.refusal(refused).details).toMatchObject({
      reason: "data_store_not_reached",
      dataStore: "live2-other"
    });
    expect((await asset(DATA_STORE_ASSET_KIND, "live2-called"))?.publishedRevision).toBe(1);
    expect((await asset(DATA_STORE_ASSET_KIND, "live2-other"))?.publishedRevision).toBe(1);
    expect((await asset(WORKFLOW_ASSET_KIND, "live2-called-flow"))?.publishedRevision).toBe(1);
  });

  it("asks the publisher's data_store.publish on the store up front, and names no store it may not publish", async () => {
    const store = await liveWorkflowWithPendingStore("live2-rights", "live2-rights-flow");
    const workflowId = required(await asset(WORKFLOW_ASSET_KIND, "live2-rights-flow")).id;
    const storeId = required(await asset(DATA_STORE_ASSET_KIND, "live2-rights")).id;
    await holding(
      [
        ["workflow.read", workflowId],
        ["workflow.write", workflowId],
        ["workflow.publish", workflowId],
        ["data_store.read", storeId],
        ["data_store.insert", storeId]
      ],
      async () => {
        expect(
          (await readWorkflow(t.kai.id, "live2-rights-flow")).publishDataStores
        ).toBeUndefined();
        const refused = await publishWorkflow(t.kai.id, "live2-rights-flow", 2, [
          { name: "live2-rights", revision: store }
        ]);
        expectStatus(refused, 403);
        expect(t.refusal(refused).details).toMatchObject({ action: "data_store.publish" });
      }
    );
    expect((await asset(DATA_STORE_ASSET_KIND, "live2-rights"))?.publishedRevision).toBe(1);
    expect(await record("live2-rights")).toMatchObject({ level: 1 });
    expect((await asset(WORKFLOW_ASSET_KIND, "live2-rights-flow"))?.publishedRevision).toBe(1);
  });

  it("keeps a Workflow's publish that names no store as it was, and the store's own Publish", async () => {
    const store = await liveWorkflowWithPendingStore("live2-alone", "live2-alone-flow");

    expectStatus(await publishWorkflow(t.root.id, "live2-alone-flow", 2), 200);

    expect((await asset(WORKFLOW_ASSET_KIND, "live2-alone-flow"))?.publishedRevision).toBe(2);
    expect((await asset(DATA_STORE_ASSET_KIND, "live2-alone"))?.publishedRevision).toBe(1);
    // The store's own Publish stays: here for a store no Workflow carried.
    expectStatus(
      await t.call(t.root.id, "assets.publish", {
        params: { kind: DATA_STORE_ASSET_KIND, name: "live2-alone" },
        payload: { revision: store }
      }),
      200
    );
  });

  // LIVE-2 review: a revision the Workflow's own publish refuses moves no store. Fails when only
  // the publish right and the revision are asked before the stores move: the store went to
  // revision 2 and level 2, and the Workflow was then refused.
  it("refuses a revision its own checks refuse before any store moves", async () => {
    const store = await liveWorkflowWithPendingStore("live2-limits", "live2-limits-flow");
    const above = await putWorkflow("live2-limits-flow", "live2-limits", 2, {
      limits: { stepRuns: 1_000_000_000 }
    });

    const refused = await publishWorkflow(t.root.id, "live2-limits-flow", above, [
      { name: "live2-limits", revision: store }
    ]);

    expectStatus(refused, 422);
    expect(JSON.stringify(t.refusal(refused))).toContain("limits.stepRuns");
    expect((await asset(DATA_STORE_ASSET_KIND, "live2-limits"))?.publishedRevision).toBe(1);
    expect(await record("live2-limits")).toMatchObject({ level: 1 });
    expect((await asset(WORKFLOW_ASSET_KIND, "live2-limits-flow"))?.publishedRevision).toBe(1);
  });

  // LIVE-2 review: a Workflow's Publish waits only for the stores it names. Fails when it also
  // waits for a store it calls whose own Publish left a migration behind: the Workflow was
  // refused with that store's failure, which nothing on its page can mend.
  it("publishes a Workflow that names no store whatever another publish left a store it calls at", async () => {
    const store = await liveWorkflowWithPendingStore("live2-stuck", "live2-stuck-flow");
    // The store's own publish moved its pointer and its migration failed.
    const storeAsset = required(await asset(DATA_STORE_ASSET_KIND, "live2-stuck"));
    const stored = required(
      await t.stores.configAssets.getConfigAssetRevision({
        clientInstanceId,
        kind: DATA_STORE_ASSET_KIND,
        name: "live2-stuck",
        revision: store
      })
    );
    await t.stores.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      name: "live2-stuck",
      assetId: storeAsset.id,
      revision: store,
      revisionId: stored.id
    });
    await t.stores.dataStores.putDataStore({
      ...(await record("live2-stuck")),
      failure: { code: "migration_failed", message: "The database said no." }
    });

    const published = await publishWorkflow(t.root.id, "live2-stuck-flow", 2);

    expectStatus(published, 200);
    expect((await asset(WORKFLOW_ASSET_KIND, "live2-stuck-flow"))?.publishedRevision).toBe(2);
    expect(await record("live2-stuck")).toMatchObject({ level: 1 });
  });

  // A held Workflow publish holds its stores with it: one Inbox item names the store with the
  // version it makes live, and its approval publishes the store, migrates it and makes the
  // Workflow live.
  it("holds the Workflow and its store as one approval, and runs all of it on approval", async () => {
    const store = await liveWorkflowWithPendingStore("live2-held", "live2-held-flow");
    const workflowId = required(await asset(WORKFLOW_ASSET_KIND, "live2-held-flow")).id;
    const storeId = required(await asset(DATA_STORE_ASSET_KIND, "live2-held")).id;
    // A setting holds every publish of a Data Store, so the Workflow's publish is held too.
    t.state.centralSettings = [
      { operation: "assets.publish", value: "approval", assetKind: DATA_STORE_ASSET_KIND }
    ];
    try {
      // The held call runs as kai once approved, so kai holds the rights until it has run.
      await holding(
        [
          ["workflow.read", workflowId],
          ["workflow.write", workflowId],
          ["workflow.publish", workflowId],
          ["data_store.read", storeId],
          ["data_store.insert", storeId],
          ["data_store.publish", storeId]
        ],
        async () => {
          const held = await publishWorkflow(t.kai.id, "live2-held-flow", 2, [
            { name: "live2-held", revision: store }
          ]);
          expectStatus(held, 202);
          const { approvalRequestId } = heldSchema.parse(held.json());
          expect((await asset(DATA_STORE_ASSET_KIND, "live2-held"))?.publishedRevision).toBe(1);
          expect((await asset(WORKFLOW_ASSET_KIND, "live2-held-flow"))?.publishedRevision).toBe(1);

          // The item the approver reads names the store with the Workflow.
          const filed = (
            await t.expectOk(t.root.id, "approval_requests.get", {
              params: { requestId: approvalRequestId }
            })
          ).json();
          expect(filed).toMatchObject({
            kind: "workflow_publish",
            canDecide: true,
            payload: {
              subject: {
                name: "live2-held-flow",
                revision: 2,
                publishedWith: [
                  {
                    kind: DATA_STORE_ASSET_KIND,
                    name: "live2-held",
                    title: "Store live2-held",
                    revision: store,
                    liveRevision: 1
                  }
                ]
              }
            }
          });

          expectStatus(
            await t.call(t.root.id, "approval_requests.decide", {
              params: { requestId: approvalRequestId },
              payload: { decision: "approve" }
            }),
            200
          );
          await getTestJobs(t.instance).runDue();
          await eventually(async () => {
            expect((await asset(WORKFLOW_ASSET_KIND, "live2-held-flow"))?.publishedRevision).toBe(
              2
            );
          }, 30_000);
        }
      );
    } finally {
      t.state.centralSettings = [];
    }
    expect(await record("live2-held")).toMatchObject({ status: "ready", level: 2 });
    expect((await asset(DATA_STORE_ASSET_KIND, "live2-held"))?.publishedRevision).toBe(store);
  });

  /**
   * `catalyst workflow publish` as the root user, through their personal key. Answers what it
   * printed, the questions it asked and the bodies of the publish requests it sent.
   */
  async function cliPublish(
    workflow: string,
    options: { answers?: string[]; yes?: boolean; terminal?: boolean } = {}
  ) {
    const serverFetch = createTestFetch(t.instance, {
      "x-test-user": t.root.id,
      "x-test-key": "personal"
    });
    const out: string[] = [];
    const err: string[] = [];
    const questions: string[] = [];
    const published: unknown[] = [];
    const answers = [...(options.answers ?? [])];
    const code = await runCli(
      [
        "workflow",
        "publish",
        workflow,
        "--revision",
        "2",
        ...(options.yes ? ["--yes"] : []),
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
          if (request.method === "POST" && request.url.endsWith(`/${workflow}/publish`)) {
            published.push(await request.clone().json());
          }
          return serverFetch(request);
        },
        ...(options.terminal === false
          ? {}
          : {
              prompt: async (question: string) => {
                questions.push(question);
                const answer = answers.shift();
                if (answer === undefined) throw new Error("Unexpected extra publish question");
                return answer;
              }
            }),
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text)
      }
    );
    return { code, out: out.join(""), err: err.join(""), questions, published };
  }

  it("shows the store, its migration and the account in `catalyst workflow publish`, and one yes publishes them with the Workflow", async () => {
    const store = await liveWorkflowWithPendingStore("live2-cli", "live2-cli-flow");

    const result = await cliPublish("live2-cli-flow", { answers: ["d", "y"] });

    expect(result.code, result.err).toBe(0);
    // The sentence leads with the account and the store beneath it; Details keep the lines the
    // page's question holds. The same question is asked again after them.
    expect(result.questions).toHaveLength(2);
    expect(result.out).toContain("runs as the account “Import findings”");
    expect(result.out).toContain(
      `Data Store 'Store live2-cli' (live2-cli): revision ${store} in place of 1, at level 1, applies 1 migration: add_note`
    );
    expect(result.out).toContain(
      "Runs as its own account “Import findings” and may add rows to Store live2-cli."
    );
    expect(result.published).toEqual([
      { revision: 2, dataStores: [{ name: "live2-cli", revision: store }] }
    ]);
    expect(result.out).toContain(`Published revision ${store} of Data Store 'live2-cli'.`);
    expect(result.out).toContain("Published revision 2 of workflow 'live2-cli-flow'");
    expect(await record("live2-cli")).toMatchObject({ status: "ready", level: 2 });
    expect((await asset(WORKFLOW_ASSET_KIND, "live2-cli-flow"))?.publishedRevision).toBe(2);
  });

  it("changes nothing where the answer is no, where no one can answer, and where a migration fails", async () => {
    await liveWorkflowWithPendingStore("live2-cli-no", "live2-cli-no-flow");

    const declined = await cliPublish("live2-cli-no-flow", { answers: ["n"] });
    expect(declined.code).toBe(1);
    expect(declined.err).toBe("Nothing was published.\n");
    expect(declined.out).toContain("applies 1 migration: add_note");
    expect(declined.published).toEqual([]);

    // A run with no terminal and no --yes is refused before it sends anything.
    const silent = await cliPublish("live2-cli-no-flow", { terminal: false });
    expect(silent.code).toBe(1);
    expect(silent.err).toContain("needs your answer here");
    expect(silent.published).toEqual([]);

    expect(await record("live2-cli-no")).toMatchObject({ status: "ready", level: 1 });
    expect((await asset(WORKFLOW_ASSET_KIND, "live2-cli-no-flow"))?.publishedRevision).toBe(1);

    // Where the instance refuses after a yes, the store keeps its level and the live revision.
    const brokenStore = await liveWorkflowWithPendingStore(
      "live2-cli-broken",
      "live2-cli-broken-flow",
      broken
    );
    const refused = await cliPublish("live2-cli-broken-flow", { answers: ["y"] });
    expect(refused.code).not.toBe(0);
    expect(refused.published).toEqual([
      { revision: 2, dataStores: [{ name: "live2-cli-broken", revision: brokenStore }] }
    ]);
    expect(refused.out).not.toContain("Published revision");
    expect(await record("live2-cli-broken")).toMatchObject({ level: 1 });
    expect((await asset(WORKFLOW_ASSET_KIND, "live2-cli-broken-flow"))?.publishedRevision).toBe(1);
  });

  it("`--yes` shows the same lines, asks nothing, and names the store in the request that waits in the Inbox", async () => {
    const store = await liveWorkflowWithPendingStore("live2-cli-yes", "live2-cli-yes-flow");

    const result = await cliPublish("live2-cli-yes-flow", { yes: true });

    expect(result.code, result.err).toBe(3);
    expect(result.questions).toEqual([]);
    expect(result.out).toContain("applies 1 migration: add_note");
    expect(result.out).toContain(
      "Runs as its own account “Import findings” and may add rows to Store live2-cli-yes."
    );
    expect(result.err).toMatch(
      /Waits in your Inbox for your confirmation; nothing has changed yet/u
    );
    expect(result.published).toEqual([
      { revision: 2, dataStores: [{ name: "live2-cli-yes", revision: store }] }
    ]);
    expect(await record("live2-cli-yes")).toMatchObject({ level: 1 });
    expect((await asset(WORKFLOW_ASSET_KIND, "live2-cli-yes-flow"))?.publishedRevision).toBe(1);

    // The Allow in the Inbox is the person's click: the store and the Workflow go live with it.
    const requestId = required(/request (\S+),/u.exec(result.err)?.[1]);
    expectStatus(
      await t.call(t.root.id, "approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" }
      }),
      200
    );
    await getTestJobs(t.instance).runDue();
    await eventually(async () => {
      expect((await asset(WORKFLOW_ASSET_KIND, "live2-cli-yes-flow"))?.publishedRevision).toBe(2);
    }, 30_000);
    expect(await record("live2-cli-yes")).toMatchObject({ status: "ready", level: 2 });
  });
});
