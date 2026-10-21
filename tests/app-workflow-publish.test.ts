import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createInstanceWorkflows,
  resolveInstanceModules,
  type InstanceWorkflows
} from "@work-shape/catalyst-client-assembly";
import {
  WORKFLOW_ASSET_KIND,
  type OperationRegistry,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { action, setupAppActions, type AppActionsInstance } from "./support/app-actions";
import { expectStatus } from "./support/app-instance";
import { guardedEvents } from "./support/guardrails";
import { createTestFetch, getTestJobs } from "./support/test-instance";
import { testOperations } from "./support/operations";
import { runCli } from "@work-shape/catalyst-cli";
import { instanceWorkflowAssetKind } from "./support/workflow-instance";

// DP-0 (drafts together): an App is published only with the Workflows its `workflow` actions
// start. The Workflow is an asset of the instance here, as on a real one, and the engine
// reads its published revision. Before DP-0 the publish of an App whose Workflow had never
// been published went through, and every click of the live App failed.

/**
 * A Workflow that starts by hand and takes a page, as the App below maps it. One whose inputs
 * ask no page also starts as the child of another.
 */
const pageWorkflow = (id: string, inputs: Record<string, unknown>) => ({
  id,
  name: "Page log",
  inputs,
  outputs: { type: "object", properties: { page: { type: "string" } } },
  steps: [
    {
      id: "start",
      name: "Start by hand",
      type: "trigger",
      triggers:
        inputs === PAGE_INPUTS ? [{ kind: "manual" }] : [{ kind: "manual" }, { kind: "parent" }]
    },
    {
      id: "result",
      name: "Result",
      type: "output",
      input: { page: { ref: { step: "start", path: "input.page" } } }
    }
  ]
});
/** A child's inputs that ask nothing of the parent's step. */
const NOTE_INPUTS = { type: "object", properties: { note: { type: "string" } } };
const PAGE_INPUTS = {
  type: "object",
  properties: { page: { type: "string" }, source: { type: "string" } },
  required: ["page"],
  additionalProperties: false
};

/** An App with one button that starts `workflow` with the page it is given. */
const pagesApp = (id: string, workflow: string, mapping = '{ page: "{{page}}", source: app }') => [
  {
    path: "app.yaml",
    text: JSON.stringify({ id, name: "Pages", kit: "1.3.0", entry: "index.html" })
  },
  { path: "index.html", text: "<!doctype html><title>Pages</title><p>pages</p>" },
  {
    path: "actions/log.action.yaml",
    text: action([
      `workflow: ${workflow}`,
      "input:",
      "  schema: { type: object, properties: { page: { type: string } }, required: [page] }",
      `  mapping: ${mapping}`
    ])
  }
];

const refusalSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.looseObject({ reason: z.string() }).optional()
  })
});
/** A guardrail at the publish of a Workflow whose revision holds `marker`. */
const guardrailOn = (marker: string, outcome: "block" | "require_approval") => ({
  displayName: `Workflows with ${marker}`,
  on: "workflow.before_publish",
  check: { kind: "pattern", pattern: `\\b${marker}\\b`, reason: "Not without a look." },
  outcome
});
/** A child's inputs that ask nothing of the parent's step and hold `marker`. */
const markedInputs = (marker: string) => ({
  type: "object",
  properties: { [marker]: { type: "string" } }
});
const heldSchema = z.object({
  status: z.literal("pending_approval"),
  approvalRequestId: z.string()
});
const warningsSchema = z.object({
  warnings: z.array(z.object({ code: z.string(), message: z.string() }))
});

describe("an App and the Workflows it starts, at the App's publish", () => {
  let t: AppActionsInstance;
  let stores: PlatformStores | undefined;
  let registry: OperationRegistry | undefined;

  beforeAll(async () => {
    let workflows: InstanceWorkflows | undefined;
    const kind = instanceWorkflowAssetKind(
      () => {
        if (!stores) throw new Error("The instance is not set up");
        return stores;
      },
      () => registry
    );
    t = await setupAppActions({
      modules: { workflows: { enabled: true } },
      furtherKinds: [kind],
      // The CLI signs in with an API key, as on an instance.
      explicitCredentials: true,
      // A Workflow revision that holds guarded_note is blocked at its publish, one that holds
      // held_note waits for an approver; the guardrails ask nothing of the others.
      events: (instanceStores) =>
        guardedEvents(instanceStores, {
          "guarded-workflows": guardrailOn("guarded_note", "block"),
          "held-workflows": guardrailOn("held_note", "require_approval")
        }).events,
      server(instanceStores, config, built) {
        if (!built.operationCalls) throw new Error("The instance built no call path");
        stores = instanceStores;
        registry = built.operationCalls.registry;
        // No definitions of the test's own: the engine reads the Workflows' published revisions.
        workflows = createInstanceWorkflows({
          modules: resolveInstanceModules(config, []).snapshot,
          clientInstanceId,
          stores: instanceStores,
          operationCalls: built.operationCalls
        });
        return {};
      },
      register(route) {
        for (const register of workflows?.routes ?? []) register(route);
      }
    });
  });
  afterAll(async () => {
    await t.closeAll();
  });

  /** Writes a Workflow's draft as the superadmin. Answers its revision. */
  async function putWorkflow(
    id: string,
    inputs: Record<string, unknown> = PAGE_INPUTS,
    expectedRevision: number | null = null
  ) {
    const response = await t.expectOk(t.root.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: id },
      payload: { config: { name: id, manifest: pageWorkflow(id, inputs) }, expectedRevision }
    });
    return z.object({ revision: z.number() }).parse(response.json()).revision;
  }
  const publishWorkflow = async (id: string, revision: number) => {
    expectStatus(
      await t.call(t.root.id, "assets.publish", {
        params: { kind: WORKFLOW_ASSET_KIND, name: id },
        payload: { revision }
      }),
      200
    );
  };

  /**
   * Writes a Workflow that starts `child` as a step, as the superadmin. Answers its revision.
   * Its save reads the child's published contract, so the child has a published revision.
   */
  async function putParent(id: string, child: string) {
    const manifest = pageWorkflow(id, PAGE_INPUTS);
    const steps = [
      manifest.steps[0],
      { id: "child", name: "Child", type: "workflow", workflow: child, input: {} },
      manifest.steps[1]
    ];
    const response = await t.expectOk(t.root.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: id },
      payload: { config: { name: id, manifest: { ...manifest, steps } }, expectedRevision: null }
    });
    return z.object({ revision: z.number() }).parse(response.json()).revision;
  }
  const publishedRevisionOf = async (kind: string, name: string) =>
    (await t.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name }))
      ?.publishedRevision;
  const publishTogether = (
    userId: string,
    app: string,
    workflows: { name: string; revision: number }[]
  ) =>
    t.call(userId, "assets.publish", {
      params: { kind: "app", name: app },
      payload: { revision: 1, workspaceId: t.workspaceId, audience: "workspace", workflows }
    });

  /** Runs `work` while `userId` holds each of the rights, and takes them back. */
  const withRights = async (
    userId: string,
    rights: readonly (readonly [string, { assetId: string } | { workspaceId: string }])[],
    work: () => Promise<void>
  ): Promise<void> => {
    const [first, ...rest] = rights;
    if (!first) return work();
    return t.withRight(userId, first[0], first[1], () => withRights(userId, rest, work));
  };

  const click = async (app: string, key: string) =>
    t.callAction(
      t.root.id,
      await t.openApp(t.root.id, "published", app),
      "log",
      { page: "/x" },
      { "idempotency-key": key }
    );

  it("refuses to publish an App whose Workflow was never published, and the App stays unpublished", async () => {
    await putWorkflow("draft-only");
    expectStatus(await t.putApp(t.admin.id, "pages-a", pagesApp("pages-a", "draft-only")), 200);

    const response = await t.publish(t.admin.id, "pages-a", 1);

    expectStatus(response, 404);
    expect(refusalSchema.parse(response.json()).error).toEqual({
      code: "NOT_FOUND",
      message:
        "The Workflow 'draft-only' is not available: it is not published, or not where the App reaches it (its own workspace or the instance). Publish the Workflow first.",
      details: { reason: "workflow_unavailable", workflow: "draft-only" }
    });
    const app = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "app",
      name: "pages-a"
    });
    expect(app?.publishedRevision).toBeUndefined();
  });

  it("refuses a mapping that leaves out a required input or fills one the Workflow does not declare", async () => {
    await publishWorkflow("strict-pages", await putWorkflow("strict-pages"));
    expectStatus(
      await t.putApp(
        t.admin.id,
        "pages-b",
        pagesApp("pages-b", "strict-pages", '{ path: "{{page}}" }')
      ),
      200
    );

    const missing = await t.publish(t.admin.id, "pages-b", 1);

    expectStatus(missing, 422);
    expect(refusalSchema.parse(missing.json()).error.details).toEqual({
      reason: "workflow_input_invalid",
      workflow: "strict-pages",
      action: "log",
      input: "page",
      fault: "missing"
    });
    expectStatus(
      await t.putApp(
        t.admin.id,
        "pages-b",
        pagesApp("pages-b", "strict-pages", '{ page: "{{page}}", origin: app }')
      ),
      200
    );
    const undeclared = await t.publish(t.admin.id, "pages-b", 2);
    expectStatus(undeclared, 422);
    expect(refusalSchema.parse(undeclared.json()).error.details).toMatchObject({
      reason: "workflow_input_invalid",
      input: "origin",
      fault: "undeclared"
    });
  });

  // DP-1b: the App is the gate for its Workflow. Fails without it: a publisher who may not
  // use the Workflow published an App whose every viewer then started it.
  it("refuses a publisher who may not use the Workflow the App starts, and publishes for one who may", async () => {
    await publishWorkflow("gated-pages", await putWorkflow("gated-pages"));
    expectStatus(await t.putApp(t.admin.id, "pages-g", pagesApp("pages-g", "gated-pages")), 200);
    const workflowId = await t.assetId(WORKFLOW_ASSET_KIND, "gated-pages");
    const inWorkspace = { workspaceId: t.workspaceId };

    await t.withRight(t.kai.id, "app.publish", inWorkspace, async () => {
      const refused = await t.publish(t.kai.id, "pages-g", 1);
      expectStatus(refused, 403);
      expect(refusalSchema.parse(refused.json()).error).toMatchObject({
        code: "FORBIDDEN",
        details: expect.objectContaining({ action: "workflow.use" })
      });
      const app = await t.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "app",
        name: "pages-g"
      });
      expect(app?.publishedRevision).toBeUndefined();

      await t.withRight(t.kai.id, "workflow.use", { assetId: workflowId }, async () => {
        expectStatus(await t.publish(t.kai.id, "pages-g", 1), 200);
      });
    });
  });

  it("publishes with a live Workflow; taking the Workflow back names the App, whose click then names the Workflow", async () => {
    const revision = await putWorkflow("live-pages");
    await publishWorkflow("live-pages", revision);
    expectStatus(await t.putApp(t.admin.id, "pages-c", pagesApp("pages-c", "live-pages")), 200);
    expectStatus(await t.publish(t.admin.id, "pages-c", 1), 200);
    expectStatus(await click("pages-c", "live-1"), 200);

    const unpublished = await t.call(t.root.id, "workflows.unpublish", {
      params: { workflow: "live-pages" }
    });

    expectStatus(unpublished, 200);
    expect(warningsSchema.parse(unpublished.json()).warnings).toEqual([
      {
        code: "live_app_starts_workflow",
        message:
          "The published App 'Pages' (pages-c) starts this Workflow. Its action answers workflow_unavailable until the Workflow is published again."
      }
    ]);
    const refused = await click("pages-c", "live-2");
    expectStatus(refused, 404);
    expect(refusalSchema.parse(refused.json()).error.details).toMatchObject({
      reason: "workflow_unavailable",
      workflow: "live-pages"
    });

    const asset = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name: "live-pages"
    });
    const deleted = await t.call(t.root.id, "assets.delete", {
      params: { kind: WORKFLOW_ASSET_KIND, name: "live-pages" },
      payload: { expectedRevision: asset?.revision }
    });
    expectStatus(deleted, 200);
    expect(warningsSchema.parse(deleted.json()).warnings).toMatchObject([
      { code: "live_app_starts_workflow" }
    ]);
  });

  it("names to one who takes the Workflow back only the Apps it may open, and counts the others", async () => {
    const revision = await putWorkflow("hidden-pages");
    await publishWorkflow("hidden-pages", revision);
    expectStatus(await t.putApp(t.admin.id, "pages-d", pagesApp("pages-d", "hidden-pages")), 200);
    expectStatus(await t.publish(t.admin.id, "pages-d", 1), 200);

    // Lena may take the Workflow back and may not open the App: she learns that one exists,
    // and neither its name nor its title. Before, the warning named it.
    await t.withRight(
      t.lena.id,
      "workflow.publish",
      { assetId: await t.assetId(WORKFLOW_ASSET_KIND, "hidden-pages") },
      async () => {
        const unpublished = await t.call(t.lena.id, "workflows.unpublish", {
          params: { workflow: "hidden-pages" }
        });
        expectStatus(unpublished, 200);
        expect(warningsSchema.parse(unpublished.json()).warnings).toEqual([
          {
            code: "live_app_starts_workflow",
            message:
              "A published App you may not open starts this Workflow. Its action answers workflow_unavailable until the Workflow is published again."
          }
        ]);
      }
    );
  });

  // DP-3: one Publish of an App makes the Workflow drafts it reaches live with it. Fails
  // without it: the App's publish refused the never-published Workflow (see the first test),
  // and the person published each Workflow first.
  it("publishes an App and the Workflow drafts it reaches in one Publish, children first", async () => {
    // The child is live at r1 and has a pending draft; the parent was never published.
    await publishWorkflow(
      "together-child",
      await putWorkflow("together-child", { type: "object" })
    );
    const child = await putWorkflow("together-child", NOTE_INPUTS, 1);
    const parent = await putParent("together-parent", "together-child");
    expectStatus(
      await t.putApp(t.admin.id, "pages-t", pagesApp("pages-t", "together-parent")),
      200
    );

    const response = await publishTogether(t.admin.id, "pages-t", [
      { name: "together-parent", revision: parent },
      { name: "together-child", revision: child }
    ]);

    expectStatus(response, 200);
    expect(response.json()).toMatchObject({
      publishedRevision: 1,
      publishedWith: [
        { kind: WORKFLOW_ASSET_KIND, name: "together-child", publishedRevision: child },
        { kind: WORKFLOW_ASSET_KIND, name: "together-parent", publishedRevision: parent }
      ]
    });
    expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "together-child")).toBe(child);
    expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "together-parent")).toBe(parent);
    expect(await publishedRevisionOf("app", "pages-t")).toBe(1);
    expectStatus(await click("pages-t", "together-1"), 200);
  });

  it("publishes nothing when the publish of one Workflow named with the App is refused", async () => {
    await publishWorkflow("refused-child", await putWorkflow("refused-child", { type: "object" }));
    const child = await putWorkflow("refused-child", NOTE_INPUTS, 1);
    const parent = await putParent("refused-parent", "refused-child");
    expectStatus(await t.putApp(t.admin.id, "pages-r", pagesApp("pages-r", "refused-parent")), 200);
    const named = [
      { name: "refused-parent", revision: parent },
      { name: "refused-child", revision: child }
    ];
    const parentId = await t.assetId(WORKFLOW_ASSET_KIND, "refused-parent");

    // Kai may publish the App and the parent and use the parent, not publish the child.
    await t.withRight(t.kai.id, "app.publish", { workspaceId: t.workspaceId }, () =>
      t.withRight(t.kai.id, "workflow.use", { assetId: parentId }, () =>
        t.withRight(t.kai.id, "workflow.publish", { assetId: parentId }, async () => {
          const refused = await publishTogether(t.kai.id, "pages-r", named);
          expectStatus(refused, 403);
          expect(refusalSchema.parse(refused.json()).error).toMatchObject({
            code: "FORBIDDEN",
            details: expect.objectContaining({ action: "workflow.publish" })
          });
        })
      )
    );

    expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "refused-child")).toBe(1);
    expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "refused-parent")).toBeUndefined();
    expect(await publishedRevisionOf("app", "pages-r")).toBeUndefined();
  });

  it("refuses to publish with the App a Workflow its revision does not reach", async () => {
    await publishWorkflow("reached-pages", await putWorkflow("reached-pages"));
    const other = await putWorkflow("unreached-pages");
    expectStatus(await t.putApp(t.admin.id, "pages-u", pagesApp("pages-u", "reached-pages")), 200);

    const response = await publishTogether(t.admin.id, "pages-u", [
      { name: "unreached-pages", revision: other }
    ]);

    expectStatus(response, 422);
    expect(refusalSchema.parse(response.json()).error.details).toEqual({
      reason: "workflow_not_reached",
      workflow: "unreached-pages"
    });
    expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "unreached-pages")).toBeUndefined();
    expect(await publishedRevisionOf("app", "pages-u")).toBeUndefined();
  });

  it("publishes nothing when a guardrail blocks the publish of one Workflow named with the App", async () => {
    await publishWorkflow("guarded-child", await putWorkflow("guarded-child", { type: "object" }));
    const child = await putWorkflow("guarded-child", markedInputs("guarded_note"), 1);
    const parent = await putParent("guarded-parent", "guarded-child");
    expectStatus(await t.putApp(t.admin.id, "pages-x", pagesApp("pages-x", "guarded-parent")), 200);

    const refused = await publishTogether(t.admin.id, "pages-x", [
      { name: "guarded-parent", revision: parent },
      { name: "guarded-child", revision: child }
    ]);

    expectStatus(refused, 403);
    expect(refused.json()).toMatchObject({ error: { code: "GUARDRAIL_BLOCKED" } });
    expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "guarded-child")).toBe(1);
    expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "guarded-parent")).toBeUndefined();
    expect(await publishedRevisionOf("app", "pages-x")).toBeUndefined();
  });

  it("holds the App and the Workflows published with it as one approval, which makes them all live", async () => {
    await publishWorkflow("held-child", await putWorkflow("held-child", { type: "object" }));
    const child = await putWorkflow("held-child", markedInputs("held_note"), 1);
    const parent = await putParent("held-parent", "held-child");
    expectStatus(await t.putApp(t.admin.id, "pages-h", pagesApp("pages-h", "held-parent")), 200);
    const named = [
      { name: "held-parent", revision: parent },
      { name: "held-child", revision: child }
    ];
    const parentId = await t.assetId(WORKFLOW_ASSET_KIND, "held-parent");
    const childId = await t.assetId(WORKFLOW_ASSET_KIND, "held-child");

    // Kai may publish and use all three and approves nothing: the guardrail asks an approver.
    // The approved call runs as Kai's, so Kai holds the rights until it ran.
    await withRights(
      t.kai.id,
      [
        ["app.publish", { workspaceId: t.workspaceId }],
        // The parent's account acts with the child, a right Kai lends it at the publish.
        ...[parentId, childId].flatMap((assetId) => [
          ["workflow.use", { assetId }] as const,
          ["workflow.read", { assetId }] as const,
          ["workflow.publish", { assetId }] as const
        ])
      ],
      async () => {
        const response = await publishTogether(t.kai.id, "pages-h", named);

        expectStatus(response, 202);
        const { approvalRequestId } = heldSchema.parse(response.json());
        expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "held-child")).toBe(1);
        expect(await publishedRevisionOf("app", "pages-h")).toBeUndefined();
        const filed = await t.expectOk(t.root.id, "approval_requests.get", {
          params: { requestId: approvalRequestId }
        });
        expect(filed.json()).toMatchObject({
          kind: "app_publish",
          payload: {
            subject: {
              name: "pages-h",
              publishedWith: [
                { name: "held-child", revision: child, liveRevision: 1 },
                { name: "held-parent", revision: parent, liveRevision: null }
              ]
            }
          },
          preview: {
            review: {
              publishedWith: [
                expect.objectContaining({ name: "held-child" }),
                expect.objectContaining({ name: "held-parent" })
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
      }
    );

    expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "held-child")).toBe(child);
    expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "held-parent")).toBe(parent);
    expect(await publishedRevisionOf("app", "pages-h")).toBe(1);
  });

  // DP-3 rights review: the joint item was held and decided as the App's own publish, so a
  // setting that holds a Workflow's publish let the joint one through, and the App's approver
  // alone made the Workflows live. Both fail without the fix.
  it("holds the joint publish when a setting holds the publish of a Workflow, not of the App", async () => {
    await publishWorkflow("policy-child", await putWorkflow("policy-child", { type: "object" }));
    const child = await putWorkflow("policy-child", NOTE_INPUTS, 1);
    const parent = await putParent("policy-parent", "policy-child");
    expectStatus(await t.putApp(t.admin.id, "pages-p", pagesApp("pages-p", "policy-parent")), 200);

    t.state.centralSettings = [
      { operation: "assets.publish", value: "approval", assetKind: WORKFLOW_ASSET_KIND }
    ];
    try {
      const response = await publishTogether(t.admin.id, "pages-p", [
        { name: "policy-parent", revision: parent },
        { name: "policy-child", revision: child }
      ]);
      expectStatus(response, 202);
      heldSchema.parse(response.json());
    } finally {
      t.state.centralSettings = [];
    }

    expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "policy-child")).toBe(1);
    expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "policy-parent")).toBeUndefined();
    expect(await publishedRevisionOf("app", "pages-p")).toBeUndefined();
  });

  it("lets only one who may approve the App's and each Workflow's publish approve the joint item", async () => {
    await publishWorkflow("rights-child", await putWorkflow("rights-child", { type: "object" }));
    const child = await putWorkflow("rights-child", markedInputs("held_note"), 1);
    const parent = await putParent("rights-parent", "rights-child");
    expectStatus(await t.putApp(t.admin.id, "pages-j", pagesApp("pages-j", "rights-parent")), 200);
    const named = [
      { name: "rights-parent", revision: parent },
      { name: "rights-child", revision: child }
    ];
    const parentId = await t.assetId(WORKFLOW_ASSET_KIND, "rights-parent");
    const childId = await t.assetId(WORKFLOW_ASSET_KIND, "rights-child");
    const instanceRight = async (holderId: string, action: string) =>
      (
        await t.stores.access.createGrant({
          clientInstanceId,
          holderKind: "user",
          holderId,
          action,
          effect: "allow",
          scopeKind: "instance",
          grantedBy: t.admin.id
        })
      ).id;
    const requestOf = async (userId: string, requestId: string) =>
      z
        .object({ canDecide: z.boolean() })
        .parse(
          (await t.expectOk(userId, "approval_requests.get", { params: { requestId } })).json()
        );
    const decide = (userId: string, requestId: string) =>
      t.call(userId, "approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" }
      });

    // Kai and Lena each may approve an App's publish, not a Workflow's.
    const grants = [await instanceRight(t.kai.id, "app.approve")];
    grants.push(await instanceRight(t.lena.id, "app.approve"));
    try {
      await withRights(
        t.kai.id,
        [
          ["app.publish", { workspaceId: t.workspaceId }],
          ...[parentId, childId].flatMap((assetId) => [
            ["workflow.use", { assetId }] as const,
            ["workflow.read", { assetId }] as const,
            ["workflow.publish", { assetId }] as const
          ])
        ],
        async () => {
          // Kai's own click approves the App's part only, so the guardrail holds the whole.
          const response = await publishTogether(t.kai.id, "pages-j", named);
          expectStatus(response, 202);
          const { approvalRequestId } = heldSchema.parse(response.json());

          expect(await requestOf(t.lena.id, approvalRequestId)).toEqual(
            expect.objectContaining({ canDecide: false })
          );
          expectStatus(await decide(t.lena.id, approvalRequestId), 403);
          expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "rights-child")).toBe(1);
          expect(await publishedRevisionOf("app", "pages-j")).toBeUndefined();

          grants.push(await instanceRight(t.lena.id, "workflow.approve"));
          expect(await requestOf(t.lena.id, approvalRequestId)).toEqual(
            expect.objectContaining({ canDecide: true })
          );
          expectStatus(await decide(t.lena.id, approvalRequestId), 200);
          await getTestJobs(t.instance).runDue();
        }
      );
    } finally {
      for (const grantId of grants) {
        await t.stores.access.deleteGrant({ clientInstanceId, grantId });
      }
    }

    expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "rights-child")).toBe(child);
    expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "rights-parent")).toBe(parent);
    expect(await publishedRevisionOf("app", "pages-j")).toBe(1);
  });

  it("names what `catalyst app publish` makes live with the App and publishes it all on one yes", async () => {
    await publishWorkflow("cli-pages", await putWorkflow("cli-pages"));
    const revision = await putWorkflow("cli-pages", { ...PAGE_INPUTS, title: "Pages" }, 1);
    expectStatus(await t.putApp(t.admin.id, "pages-cli", pagesApp("pages-cli", "cli-pages")), 200);
    const serverFetch = createTestFetch(t.instance, { "x-test-user": t.admin.id });
    const out: string[] = [];
    const err: string[] = [];

    const code = await runCli(
      [
        "app",
        "publish",
        "pages-cli",
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
      "Publishes together, Workflows first and the App last, or none of them:"
    );
    expect(out.join("")).toContain(
      `Workflow 'Page log' (cli-pages): revision ${revision} in place of 1`
    );
    expect(out.join("")).toContain(`Published revision ${revision} of Workflow 'cli-pages'.`);
    expect(await publishedRevisionOf(WORKFLOW_ASSET_KIND, "cli-pages")).toBe(revision);
    expect(await publishedRevisionOf("app", "pages-cli")).toBe(1);
  });
});
