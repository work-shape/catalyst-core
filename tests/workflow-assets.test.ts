import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORKFLOW_ASSET_KIND, type JsonObject } from "@vivd-catalyst/core";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { runSchema, workflowFixture, type WorkflowFixture } from "./support/workflow-instance";
import { NOTE, notifyClients, readyWorkflows, start, stepRunsOf } from "./support/workflow-runs";

// A Workflow as an asset of the instance, through the API alone: its definition is written
// and published with the asset operations, listed and started with the operations of the
// module, and run by a job worker. The engine reads the published revision of the asset and
// nothing else, which is what the assembly gives it. Each test fails on an instance whose
// engine has no definitions: its list is empty and every start is `NOT_FOUND`.

const WORKFLOW = "notify-clients";
const address = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };

const writeSchema = z.object({ revision: z.number() });
const listSchema = z.object({
  items: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      definitionRevisionId: z.string(),
      runnable: z.boolean(),
      reasons: z.array(
        z.strictObject({ code: z.string(), message: z.string(), path: z.string().optional() })
      ),
      lastRun: z.object({ id: z.string(), status: z.string() }).loose().optional()
    })
  )
});
const assetSchema = z.object({
  revision: z.number(),
  publishedRevision: z.number().optional(),
  contentRevision: z.number().optional(),
  config: z.object({ name: z.string(), manifest: z.object({ name: z.string() }).loose() })
});

/** `notify-clients` with a block no engine of this release runs. */
function withCondition() {
  const definition = notifyClients();
  return {
    ...definition,
    steps: [
      ...definition.steps.slice(0, 1),
      {
        id: "check",
        name: "Is there a note",
        type: "condition",
        when: { ref: { step: "start", path: "input.note" }, op: "equals", value: "yes" },
        then: [],
        else: []
      },
      ...definition.steps.slice(1)
    ]
  };
}

describe("a Workflow stored as an asset", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  const ready = () =>
    readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );

  /** Writes the definition as the draft, as the administrator. Answers the revision. */
  async function put(
    t: WorkflowFixture,
    manifest: Record<string, unknown>,
    expectedRevision: number | null
  ) {
    const response = await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: { config: { name: WORKFLOW, manifest }, expectedRevision }
    });
    return writeSchema.parse(response.json()).revision;
  }
  /** Publishes as the superadmin, who may let a Workflow act as a service principal. */
  const publish = (t: WorkflowFixture, revision: number, userId = t.root.id) =>
    t.call(userId, "assets.publish", { params: address, payload: { revision } });
  const listed = async (t: WorkflowFixture, userId = t.root.id) =>
    listSchema.parse((await t.expectOk(userId, "workflows.list")).json()).items;
  const published = async (t: WorkflowFixture) =>
    (await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address }))
      ?.publishedRevisionId;
  const startAs = (t: WorkflowFixture, userId: string) =>
    t.call(userId, "workflows.start", {
      params: { workflow: WORKFLOW },
      payload: { input: { note: NOTE } }
    });

  it("is written, published, listed, started and run to its end", async () => {
    const t = await ready();
    const revision = await put(t, notifyClients(), null);

    // A draft is no Workflow of the instance: it is not listed and nothing starts it.
    expect(await listed(t)).toEqual([]);
    const early = await startAs(t, t.root.id);
    expect(early.statusCode, early.body).toBe(404);

    // The holder of the publish right alone does not lend the principal's grants.
    await t.expectRefused(
      t.admin.id,
      "assets.publish",
      { params: address, payload: { revision } },
      t.forbidden("api_access.manage", "no_grant")
    );
    expect(await listed(t)).toEqual([]);

    expect((await publish(t, revision)).statusCode).toBe(200);
    const revisionId = await published(t);
    expect(await listed(t)).toEqual([
      {
        id: WORKFLOW,
        name: "Notify clients",
        definitionRevisionId: revisionId,
        runnable: true,
        reasons: []
      }
    ]);

    // The page reads the definition as the asset: no second read exists.
    const read = assetSchema.parse(
      (await t.expectOk(t.root.id, "assets.get", { params: address })).json()
    );
    expect(read).toMatchObject({
      revision,
      publishedRevision: revision,
      config: { name: WORKFLOW, manifest: { name: "Notify clients" } }
    });

    const started = await start(t);
    expect(started).toMatchObject({ workflow: WORKFLOW, definitionRevisionId: revisionId });
    const run = await t.finish(started.id);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("done");
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({ sent: 3, failed: 0 });
    expect((await stepRunsOf(t, run.id)).map((stepRun) => stepRun.key)).toEqual([
      "start",
      "clients",
      "each_client",
      "each_client[0].send",
      "each_client[1].send",
      "each_client[2].send",
      "result"
    ]);
    expect((await listed(t))[0]?.lastRun).toMatchObject({ id: run.id, status: "done" });
  });

  it("refuses at the save and at the publish what the engine refuses, by the engine's code", async () => {
    const t = await ready();
    const refusedSave = await t.call(t.admin.id, "assets.put", {
      params: address,
      payload: { config: { name: WORKFLOW, manifest: withCondition() }, expectedRevision: null }
    });
    expect(refusedSave.statusCode, refusedSave.body).toBe(422);
    const saveError = errorSchema.parse(refusedSave.json()).error;
    expect(saveError.details).toMatchObject({ reason: "not_supported_yet" });
    expect(JSON.stringify(saveError.details?.issues)).toContain("steps");
    expect(await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address })).toBe(
      undefined
    );

    // A definition without the principal it runs as is refused the same way.
    const { runAs: _runAs, ...withoutRunAs } = notifyClients();
    const noPrincipal = await t.call(t.admin.id, "assets.put", {
      params: address,
      payload: { config: { name: WORKFLOW, manifest: withoutRunAs }, expectedRevision: null }
    });
    expect(noPrincipal.statusCode, noPrincipal.body).toBe(422);

    // A manifest of another id than the asset is addressed by is no revision of it.
    const otherId = await t.call(t.admin.id, "assets.put", {
      params: address,
      payload: {
        config: { name: WORKFLOW, manifest: { ...notifyClients(), id: "another" } },
        expectedRevision: null
      }
    });
    expect(otherId.statusCode, otherId.body).toBe(422);

    // A revision an earlier release stored, which this engine does not run: the publish asks
    // the engine again and refuses it, so it never becomes the one a start reads.
    const good = await put(t, notifyClients(), null);
    const stored = await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [`${WORKFLOW_ASSET_KIND}:${WORKFLOW}`]: good },
      mutations: [
        {
          type: "upsert",
          kind: WORKFLOW_ASSET_KIND,
          name: WORKFLOW,
          config: z
            .record(z.string(), z.json())
            .parse({ name: WORKFLOW, manifest: withCondition() }) satisfies JsonObject,
          draft: true
        }
      ]
    });
    const held = stored.revisions[`${WORKFLOW_ASSET_KIND}:${WORKFLOW}`] ?? 0;
    const refusedPublish = await publish(t, held);
    expect(refusedPublish.statusCode, refusedPublish.body).toBe(422);
    expect(errorSchema.parse(refusedPublish.json()).error.details).toMatchObject({
      reason: "not_supported_yet"
    });
    expect(await published(t)).toBeUndefined();
    expect((await publish(t, good)).statusCode).toBe(200);
  });

  it("lists a published Workflow the engine cannot start, with the reason the start gives", async () => {
    const t = await ready();
    const revision = await put(t, notifyClients(), null);
    expect((await publish(t, revision)).statusCode).toBe(200);

    /** The reason a start is refused for, which the list names before anybody asks. */
    const startReason = async () => {
      const response = await startAs(t, t.root.id);
      expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
      return errorSchema.parse(response.json()).error.details?.reason;
    };

    // The principal is disabled after the publish: nothing of the definition changed.
    await t.stores.apiAccess.updateServicePrincipal({
      clientInstanceId,
      servicePrincipalId: t.principal.id,
      status: "disabled"
    });
    const [disabled] = await listed(t);
    expect(disabled).toMatchObject({ id: WORKFLOW, runnable: false });
    expect(disabled?.reasons.map((reason) => [reason.code, reason.path])).toEqual([
      ["principal_inactive", "runAs"]
    ]);
    expect(await startReason()).toBe("principal_inactive");
    await t.stores.apiAccess.updateServicePrincipal({
      clientInstanceId,
      servicePrincipalId: t.principal.id,
      status: "active"
    });
    expect((await listed(t))[0]).toMatchObject({ runnable: true, reasons: [] });

    // A published revision of a release whose engine ran a block this one does not: it stays
    // in the list, with the engine's code and the place in the definition.
    const asset = await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address });
    const later = await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [`${WORKFLOW_ASSET_KIND}:${WORKFLOW}`]: revision },
      mutations: [
        {
          type: "upsert",
          kind: WORKFLOW_ASSET_KIND,
          name: WORKFLOW,
          config: z
            .record(z.string(), z.json())
            .parse({ name: WORKFLOW, manifest: withCondition() }) satisfies JsonObject,
          draft: true
        }
      ]
    });
    const laterRevision = later.revisions[`${WORKFLOW_ASSET_KIND}:${WORKFLOW}`] ?? 0;
    const laterRecord = await t.stores.configAssets.getConfigAssetRevision({
      clientInstanceId,
      ...address,
      revision: laterRevision
    });
    await t.stores.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      ...address,
      assetId: asset?.id ?? "",
      revision: laterRevision,
      revisionId: laterRecord?.id ?? ""
    });
    const [unsupported] = await listed(t);
    expect(unsupported).toMatchObject({
      id: WORKFLOW,
      name: "Notify clients",
      definitionRevisionId: laterRecord?.id,
      runnable: false
    });
    expect(unsupported?.reasons.length).toBeGreaterThan(0);
    expect(new Set(unsupported?.reasons.map((reason) => reason.code))).toEqual(
      new Set(["not_supported_yet"])
    );
    expect(unsupported?.reasons[0]?.path).toContain("steps");
    expect(await startReason()).toBe("not_supported_yet");
  });

  it("keeps a run on the revision it started with when another is published", async () => {
    const t = await ready();
    const first = await put(t, notifyClients(), null);
    expect((await publish(t, first)).statusCode).toBe(200);
    const firstId = await published(t);
    const early = await start(t);

    // The next revision ends with another result. The draft alone changes nothing.
    const next = notifyClients();
    const second = await put(
      t,
      {
        ...next,
        name: "Notify clients, counted",
        steps: [
          ...next.steps.slice(0, -1),
          { id: "result", name: "Result", type: "output", input: { revision: { value: 2 } } }
        ]
      },
      first
    );
    expect((await listed(t))[0]).toMatchObject({
      name: "Notify clients",
      definitionRevisionId: firstId
    });
    expect((await publish(t, second)).statusCode).toBe(200);
    const secondId = await published(t);
    expect(secondId).not.toBe(firstId);
    expect((await listed(t))[0]).toMatchObject({
      name: "Notify clients, counted",
      definitionRevisionId: secondId
    });

    const late = await start(t);
    const earlyRun = await t.finish(early.id);
    const lateRun = await t.finish(late.id);
    expect(earlyRun).toMatchObject({ status: "done", definitionRevisionId: firstId });
    expect(JSON.parse(earlyRun.outputPreview?.text ?? "null")).toEqual({ sent: 3, failed: 0 });
    expect(lateRun).toMatchObject({ status: "done", definitionRevisionId: secondId });
    expect(JSON.parse(lateRun.outputPreview?.text ?? "null")).toEqual({ revision: 2 });
  });

  it("refuses a member without the right, naming it, and opens to a grant on the asset", async () => {
    const t = await ready();
    const revision = await put(t, notifyClients(), null);

    // A member holds nothing of the kind: no write, no read of the draft, no start.
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      {
        params: address,
        payload: { config: { name: WORKFLOW, manifest: notifyClients() }, expectedRevision: 1 }
      },
      t.forbidden("workflow.write", "no_grant")
    );
    expect((await publish(t, revision)).statusCode).toBe(200);
    expect(await listed(t, t.kai.id)).toEqual([]);
    await t.expectRefused(
      t.kai.id,
      "workflows.start",
      { params: { workflow: WORKFLOW }, payload: { input: { note: NOTE } } },
      t.forbidden("workflow.use", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "workflows.list_runs",
      { params: { workflow: WORKFLOW } },
      t.forbidden("workflow.read", "no_grant")
    );

    // The use right on this one Workflow: it is listed, read as published and started. The
    // run acts as the Workflow's principal, so the member needs nothing of the Connection.
    // AP-10: the grant is written to the store; its administration does not give it yet.
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "workflow.use",
      effect: "allow",
      scopeKind: "asset",
      scopeId: await t.assetId(WORKFLOW_ASSET_KIND, WORKFLOW),
      grantedBy: t.admin.id
    });
    expect((await listed(t, t.kai.id)).map((workflow) => workflow.id)).toEqual([WORKFLOW]);
    const shown = assetSchema.parse(
      (await t.expectOk(t.kai.id, "assets.get", { params: address })).json()
    );
    expect(shown.config.manifest.name).toBe("Notify clients");
    const response = await startAs(t, t.kai.id);
    expect(response.statusCode, response.body).toBe(200);
    const run = await t.finish(runSchema.parse(response.json()).id);
    expect(run).toMatchObject({ status: "done", startedBy: { kind: "user", id: t.kai.id } });
    // The use right starts a run and reads nothing of its runs.
    await t.expectRefused(
      t.kai.id,
      "workflows.list_runs",
      { params: { workflow: WORKFLOW } },
      t.forbidden("workflow.read", "no_grant")
    );
  });

  it("registers no kind and serves no call where the module is off", async () => {
    const t = await workflowFixture({ moduleOn: false, definitions: "assets" });
    open = t;
    const response = await t.call(t.root.id, "workflows.list");
    expect(response.statusCode, response.body).toBe(404);
    const write = await t.call(t.admin.id, "assets.put", {
      params: address,
      payload: { config: { name: WORKFLOW, manifest: notifyClients() }, expectedRevision: null }
    });
    // The kind is the module's: a write of it is a call of a module that is off.
    expect(write.statusCode, write.body).toBe(404);
    expect(errorSchema.parse(write.json()).error.details).toMatchObject({
      reason: "module_off",
      module: "workflows"
    });
  });
});
