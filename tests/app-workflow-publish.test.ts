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
import { instanceWorkflowAssetKind } from "./support/workflow-instance";

// DP-0 (drafts together): an App is published only with the Workflows its `workflow` actions
// start. The Workflow is an asset of the instance here, as on a real one, and the engine
// reads its published revision. Before DP-0 the publish of an App whose Workflow had never
// been published went through, and every click of the live App failed.

/** A Workflow that starts by hand and takes a page, as the App below maps it. */
const pageWorkflow = (id: string, inputs: Record<string, unknown>) => ({
  id,
  name: "Page log",
  inputs,
  outputs: { type: "object", properties: { page: { type: "string" } } },
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "result",
      name: "Result",
      type: "output",
      input: { page: { ref: { step: "start", path: "input.page" } } }
    }
  ]
});
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
  async function putWorkflow(id: string, inputs: Record<string, unknown> = PAGE_INPUTS) {
    const response = await t.expectOk(t.root.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: id },
      payload: { config: { name: id, manifest: pageWorkflow(id, inputs) }, expectedRevision: null }
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
});
