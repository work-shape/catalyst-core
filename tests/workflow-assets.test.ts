import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORKFLOW_LIST_DESCRIPTION_MAX } from "@work-shape/catalyst-client-assembly";
import { WORKFLOW_ASSET_KIND, type JsonObject } from "@work-shape/catalyst-core";
import { WORKFLOW_MANIFEST_MAX_BYTES } from "@work-shape/catalyst-workflows";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { runSchema, workflowFixture, type WorkflowFixture } from "./support/workflow-instance";
import {
  CLIENTS,
  NOTE,
  failingFor,
  notifyClients,
  readyWorkflows,
  start,
  stepRunsOf
} from "./support/workflow-runs";

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
      kind: z.enum(["process", "data"]),
      name: z.string(),
      description: z.string().optional(),
      definitionRevisionId: z.string(),
      runnable: z.boolean(),
      reasons: z.array(
        z.strictObject({
          code: z.string(),
          message: z.string(),
          path: z.string().optional(),
          principalDisplayLabel: z.string().optional()
        })
      ),
      actions: z.array(z.string()),
      inputs: z.record(z.string(), z.unknown()).optional(),
      runsAs: z.string().optional(),
      triggers: z.array(z.string()).optional(),
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
function withDelay() {
  const definition = notifyClients();
  return {
    ...definition,
    steps: [
      ...definition.steps.slice(0, 1),
      {
        id: "check",
        name: "Wait",
        type: "delay"
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

  const ready = (runnerPackages: { name: string; version: string }[] = []) =>
    readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets", runnerPackages }
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
  /** Publishes as the superadmin, or as whoever is named. */
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

  it("lists a never-published data draft with its kind through existing asset attributes", async () => {
    const t = await ready();
    await put(t, { ...notifyClients(), kind: "data" }, null);
    const listed = await t.expectOk(t.root.id, "assets.list", {
      params: { kind: WORKFLOW_ASSET_KIND }
    });
    expect(listed.json()).toMatchObject({
      items: [{ name: WORKFLOW, attributes: { workflowKind: "data" } }]
    });
  });

  it("keeps process drafts editable but refuses data writes at every live revision gate", async () => {
    const t = await ready();
    const first = await put(t, notifyClients(), null);
    expect((await publish(t, first)).statusCode).toBe(200);
    const live = await published(t);
    const definition = notifyClients();
    const second = await put(
      t,
      {
        ...definition,
        steps: [
          definition.steps[0],
          {
            id: "ingest",
            name: "Fill documents",
            type: "operation",
            operation: "knowledge.documents.ingest",
            input: { items: { value: [] } }
          },
          { id: "result", name: "Result", type: "output", input: {} }
        ]
      },
      first
    );
    const refused = await publish(t, second);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toMatchObject({
      error: {
        details: { reason: "process_workflow_write_operation" }
      }
    });
    expect(refused.body).toContain("kind: data");
    expect(await published(t)).toBe(live);
  });

  it("classifies process and data runs for all ten item and write outcomes", async () => {
    const t = await ready();
    let revision: number | null = null;
    const cases = [
      ["process", [], { done: 0, failed: 0 }, false],
      ["data", [], { done: 0, failed: 0 }, true],
      ["data", [{ id: "one" }], { done: 0, failed: 0 }, true],
      ["data", [{ id: "one" }], { done: 1, failed: 0 }, false],
      ["data", [{ id: "one" }], { done: 0, failed: 1 }, false],
      ["data", [{ id: "one" }], { received: "unknown" }, false],
      ["data", [{ id: "one" }], { table: "rows", inserted: 0, skipped: 0 }, true],
      ["data", [{ id: "one" }], { withdrawn: 0 }, true],
      [
        "data",
        [{ id: "one" }],
        {
          accepted: 0,
          done: 0,
          failed: 0,
          withdrawn: 0,
          failures: { $dataset: "empty", rowCount: 0, bytes: 0 }
        },
        true
      ],
      ["data", [{ id: "one" }], { done: "0", failed: 0 }, false]
    ] as const;
    for (const [kind, clients, output, empty] of cases) {
      t.setBehaviour((operation) =>
        Promise.resolve(operation === "echo" ? { clients: [...clients] } : output)
      );
      revision = await put(t, { ...notifyClients(), kind }, revision);
      expect((await publish(t, revision)).statusCode).toBe(200);
      const started = await start(t);
      await t.finish(started.id);
      const read = await t.expectOk(t.root.id, "workflows.get_run", {
        params: { runId: started.id }
      });
      expect(read.json()).toMatchObject({ status: "done", empty });
      const listed = await t.expectOk(t.root.id, "workflows.list_runs", {
        params: { workflow: WORKFLOW }
      });
      expect(
        listed
          .json<{ items: { id: string; empty: boolean }[] }>()
          .items.filter((run) => run.id === started.id)
      ).toMatchObject([{ id: started.id, empty }]);
    }
  });

  it("keeps a data run visible that ended done while every item's write failed", async () => {
    const t = await ready();
    t.setBehaviour(failingFor(CLIENTS.map(({ id }) => id)));
    const revision = await put(
      t,
      { ...notifyClients({ onItemFailure: "continue" }), kind: "data" },
      null
    );
    expect((await publish(t, revision)).statusCode).toBe(200);
    const started = await start(t);
    await t.finish(started.id);
    const read = await t.expectOk(t.root.id, "workflows.get_run", {
      params: { runId: started.id }
    });
    expect(read.json()).toMatchObject({ status: "done", empty: false });
  });

  it("publishes declared installed packages, and refuses an unavailable name without moving the live revision", async () => {
    const t = await ready([{ name: "pypdf", version: "4.3.1" }]);
    const first = await put(t, { ...notifyClients(), packages: ["pypdf"] }, null);
    expect((await publish(t, first)).statusCode).toBe(200);
    const live = await published(t);
    const second = await put(
      t,
      { ...notifyClients(), packages: ["pypdf", "outside-image"] },
      first
    );
    const refused = await publish(t, second);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        message: "Workflow package 'outside-image' is not available in the runner image"
      }
    });
    expect(await published(t)).toBe(live);
  });

  it("refuses every declared package at publish with an empty runner manifest", async () => {
    const t = await ready();
    const revision = await put(t, { ...notifyClients(), packages: ["pypdf"] }, null);
    const refused = await publish(t, revision);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.body).toContain("Workflow package 'pypdf' is not available in the runner image");
    expect(await published(t)).toBeUndefined();
  });

  it("names the active configured account on an unpublished draft to its writer", async () => {
    const t = await ready();
    await put(t, notifyClients(), null);
    expect(await listed(t)).toEqual([]);
    // A writer may read the draft's label without administering technical accounts.
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.write");
    const read = () => t.expectOk(t.kai.id, "assets.get", { params: address });
    expect((await read()).json()).toMatchObject({ runsAs: t.principal.displayLabel });
    expect((await read()).json()).not.toHaveProperty("publishedRevision");
    await t.expectRefused(
      t.lena.id,
      "assets.get",
      { params: address },
      {
        status: 403,
        code: "FORBIDDEN"
      }
    );
    await t.stores.apiAccess.updateServicePrincipal({
      clientInstanceId,
      servicePrincipalId: t.principal.id,
      status: "disabled"
    });
    expect((await read()).json()).not.toHaveProperty("runsAs");
    await put(t, { ...notifyClients(), runAs: "unknown-account" }, 1);
    expect((await read()).json()).not.toHaveProperty("runsAs");
  });

  it("is written, published, listed, started and run to its end", async () => {
    const t = await ready();
    const revision = await put(t, notifyClients(), null);

    // A draft is no Workflow of the instance: it is not listed and nothing starts it.
    expect(await listed(t)).toEqual([]);
    const early = await startAs(t, t.root.id);
    expect(early.statusCode, early.body).toBe(404);

    // An administrator who is no superadmin publishes: she holds every right of the principal
    // the Workflow runs as (RIGHTS-1a).
    expect((await publish(t, revision, t.admin.id)).statusCode).toBe(200);
    const revisionId = await published(t);
    expect(await listed(t)).toEqual([
      {
        id: WORKFLOW,
        kind: "process",
        name: "Notify clients",
        definitionRevisionId: revisionId,
        runnable: true,
        reasons: [],
        // The published inputs, from which a page builds its start form.
        inputs: notifyClients().inputs,
        // Whom every run acts as, by the label people read: the page's "Runs as".
        runsAs: t.principal.displayLabel,
        // How it is started: the child picker offers only one a parent may start.
        triggers: ["manual"],
        actions: ["workflow.read", "workflow.use"]
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

  it.each(["condition", "parallel"])("saves, publishes and runs a %s block", async (type) => {
    const t = await ready();
    const base = notifyClients();
    const read = {
      id: "analysis",
      name: "Analyse",
      type: "operation",
      operation: "connection.crm.echo",
      input: { text: { ref: { step: "start", path: "input.note" } } }
    };
    const block =
      type === "condition"
        ? {
            id: "block",
            name: "Choose",
            type,
            when: { ref: { step: "start", path: "input.note" }, op: "equals", value: NOTE },
            then: [read]
          }
        : {
            id: "block",
            name: "Together",
            type,
            branches: [{ id: "one", name: "One", steps: [read] }]
          };
    const revision = await put(
      t,
      { ...base, steps: [base.steps[0], block, ...base.steps.slice(1)] },
      null
    );
    const published = await publish(t, revision);
    expect(published.statusCode, published.body).toBe(200);
    expect((await listed(t))[0]).toMatchObject({ runnable: true, reasons: [] });
    const run = await t.finish((await start(t)).id);
    expect(run.status, JSON.stringify(run.error)).toBe("done");
    const steps = await stepRunsOf(t, run.id);
    const container = steps.find((step) => step.stepId === "block");
    expect(container?.status).toBe("done");
    expect(steps.find((step) => step.stepId === "analysis")).toMatchObject({
      containerStepRunId: container?.id,
      branch: type === "condition" ? "then" : "one",
      status: "done"
    });
  });

  it("refuses at the save and at the publish what the engine refuses, by the engine's code", async () => {
    const t = await ready();
    const refusedSave = await t.call(t.admin.id, "assets.put", {
      params: address,
      payload: { config: { name: WORKFLOW, manifest: withDelay() }, expectedRevision: null }
    });
    expect(refusedSave.statusCode, refusedSave.body).toBe(422);
    const saveError = errorSchema.parse(refusedSave.json()).error;
    expect(saveError.details).toMatchObject({ reason: "not_supported_yet" });
    expect(JSON.stringify(saveError.details?.issues)).toContain("steps");
    expect(await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address })).toBe(
      undefined
    );

    // A manifest of another id than the asset is addressed by is no revision of it.
    const otherId = await t.call(t.admin.id, "assets.put", {
      params: address,
      payload: {
        config: { name: WORKFLOW, manifest: { ...notifyClients(), id: "another" } },
        expectedRevision: null
      }
    });
    expect(otherId.statusCode, otherId.body).toBe(422);

    // A definition over the bound of `workflow.yaml` is none: every run would copy it.
    const oversize = await t.call(t.admin.id, "assets.put", {
      params: address,
      payload: {
        config: {
          name: WORKFLOW,
          manifest: { ...notifyClients(), description: "x".repeat(WORKFLOW_MANIFEST_MAX_BYTES) }
        },
        expectedRevision: null
      }
    });
    expect(oversize.statusCode, oversize.body.slice(0, 300)).toBe(422);
    const oversizeError = errorSchema.parse(oversize.json()).error;
    expect(oversizeError.details).toMatchObject({ reason: "definition_invalid" });
    expect(oversizeError.message).toContain(String(WORKFLOW_MANIFEST_MAX_BYTES));
    expect(await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address })).toBe(
      undefined
    );

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
            .parse({ name: WORKFLOW, manifest: withDelay() }) satisfies JsonObject,
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
      displayLabel: "Booking checks",
      status: "disabled"
    });
    const [disabled] = await listed(t);
    expect(disabled).toMatchObject({ id: WORKFLOW, runnable: false });
    // A disabled principal acts for no run, so the list names none.
    expect(disabled?.runsAs).toBeUndefined();
    expect(disabled?.reasons.map((reason) => [reason.code, reason.path])).toEqual([
      ["principal_inactive", "runAs"]
    ]);
    expect(disabled?.reasons[0]).toMatchObject({
      principalDisplayLabel: "Booking checks",
      message: "The technical account ‘Booking checks’ is disabled."
    });
    expect(disabled?.reasons[0]?.message).not.toContain(t.principal.name);
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
            .parse({ name: WORKFLOW, manifest: withDelay() }) satisfies JsonObject,
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

  it("lists an operation the instance does not have as the reason, and a summary of the text", async () => {
    const t = await ready();
    const definition = notifyClients();
    const steps = definition.steps.map((step) =>
      step.id === "clients" ? { ...step, operation: "connection.crm.gone" } : step
    );
    const revision = await put(
      t,
      { ...definition, description: "d".repeat(WORKFLOW_LIST_DESCRIPTION_MAX + 100), steps },
      null
    );
    expect((await publish(t, revision)).statusCode).toBe(200);
    const [unknown] = await listed(t);
    expect(unknown).toMatchObject({ id: WORKFLOW, runnable: false });
    expect(unknown?.reasons.map((reason) => [reason.code, reason.path])).toEqual([
      ["operation_unknown", "steps.clients.operation"]
    ]);
    // The list names a Workflow and carries no definition: the page reads that as the asset.
    expect(unknown?.description).toHaveLength(WORKFLOW_LIST_DESCRIPTION_MAX);
  });

  it("reads and lists an explicitly data Workflow (KBW-0)", async () => {
    const t = await ready();
    const revision = await put(t, { ...notifyClients(), kind: "data" }, null);
    expect((await publish(t, revision)).statusCode).toBe(200);
    expect((await listed(t))[0]).toMatchObject({ id: WORKFLOW, kind: "data" });
    const read = (await t.expectOk(t.root.id, "assets.get", { params: address })).json();
    expect(read).toMatchObject({ config: { manifest: { kind: "data" } } });
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
    await t.grant(t.kai.id, "workflow.use", {
      assetId: await t.assetId(WORKFLOW_ASSET_KIND, WORKFLOW)
    });
    expect((await listed(t, t.kai.id)).map((workflow) => [workflow.id, workflow.actions])).toEqual([
      [WORKFLOW, ["workflow.use"]]
    ]);
    expect((await listed(t))[0]?.actions).toEqual(["workflow.read", "workflow.use"]);
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

    // A reader is shown the Workflow and told a start is not hers: the entry names the read
    // right alone, and the start is refused with the right it needs.
    await t.grant(t.lena.id, "workflow.read", {
      assetId: await t.assetId(WORKFLOW_ASSET_KIND, WORKFLOW)
    });
    expect((await listed(t, t.lena.id)).map((workflow) => [workflow.id, workflow.actions])).toEqual(
      [[WORKFLOW, ["workflow.read"]]]
    );
    await t.expectRefused(
      t.lena.id,
      "workflows.start",
      { params: { workflow: WORKFLOW }, payload: { input: { note: NOTE } } },
      t.forbidden("workflow.use", "no_grant")
    );
  });

  it("keeps an asset deny on retained runs before and after another user deletes the Workflow", async () => {
    const t = await ready();
    const revision = await put(t, notifyClients(), null);
    expect((await publish(t, revision)).statusCode).toBe(200);
    const started = await start(t);
    await t.finish(started.id);
    const assetId = await t.assetId(WORKFLOW_ASSET_KIND, WORKFLOW);
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.read");
    await t.allow({ kind: "user", id: t.lena.id }, "workflow.read");
    await t.grant(t.kai.id, "workflow.read", { assetId }, "deny");

    const checkReads = async () => {
      for (const operation of ["workflows.get_run", "workflows.list_step_runs"] as const) {
        const refused = await t.call(t.kai.id, operation, { params: { runId: started.id } });
        expect(refused.statusCode, `${operation}: ${refused.body}`).toBe(404);
        await t.expectOk(t.lena.id, operation, { params: { runId: started.id } });
      }
      await t.expectRefused(
        t.kai.id,
        "workflows.list_runs",
        { params: { workflow: WORKFLOW } },
        t.forbidden("workflow.read", "denied")
      );
      const listed = await t.expectOk(t.lena.id, "workflows.list_runs", {
        params: { workflow: WORKFLOW }
      });
      expect(listed.json()).toMatchObject({ items: [{ id: started.id }] });
    };
    await checkReads();
    await t.expectOk(t.admin.id, "assets.delete", {
      params: address,
      payload: { expectedRevision: revision }
    });
    await checkReads();
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
