import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { KNOWLEDGE_BASE_ASSET_KIND, type DataStoreRecord } from "@work-shape/catalyst-core";
import { WORKFLOW_TRIGGER_EVENT_MAX_AGE_MS } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { put, save } from "./support/mail-workflows";
import {
  runSchema,
  storesWithWorkflowsOff,
  workflowFixture,
  type WorkflowFixture
} from "./support/workflow-instance";
import { stepRunsOf } from "./support/workflow-runs";

// The `platform_event` trigger (EW-4), on Postgres and the engine's jobs: the record of a
// Knowledge Base's finished sync queues one job with it, and the job starts a run of each
// published Workflow whose trigger names the event, where the Workflow's account may read the
// Knowledge Base. The event carries ids, names and counts.

const SYNC = {
  syncRunId: "kbsync_1",
  source: "src_share",
  mode: "incremental",
  state: "completed",
  counts: { discovered: 3, added: 2, changed: 1 },
  bytesFetched: 4096
};

let fixture: WorkflowFixture | undefined;
afterEach(async () => {
  await fixture?.instance.close();
  fixture = undefined;
});

function onSync(id: string, filter?: Record<string, string>) {
  return {
    id,
    name: `On sync ${id}`,
    runAs: "workflow-runner",
    inputs: { type: "object", properties: {} },
    outputs: { type: "object" },
    steps: [
      {
        id: "start",
        name: "A sync finished",
        type: "trigger",
        triggers: [
          {
            kind: "platform_event",
            event: "knowledge_base.sync_finished",
            ...(filter ? { filter } : {})
          }
        ]
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { knowledgeBase: { ref: { step: "start", path: "event.source.name" } } }
      }
    ]
  };
}

/** A Knowledge Base as its record and asset hold it: what an event's source is read from. */
async function knowledgeBase(t: WorkflowFixture, name: string): Promise<string> {
  await applyAtCurrentRevisions(t.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        name,
        config: { name, description: "Contracts" }
      }
    ]
  });
  const asset = await t.stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: KNOWLEDGE_BASE_ASSET_KIND,
    name
  });
  if (!asset) throw new Error("The Knowledge Base was not stored");
  const now = new Date().toISOString();
  const record: DataStoreRecord = {
    id: asset.id,
    clientInstanceId,
    name: `kb-${name}`,
    status: "ready",
    location: { host: "127.0.0.1", port: 5432, database: `kb_${name}` },
    roles: { app: `kb_${name}_app`, migration: `kb_${name}_migration` },
    level: 0,
    migrations: [],
    targetRevision: 1,
    sizeLimitBytes: 1_000_000,
    conditions: [],
    createdAt: now,
    updatedAt: now,
    ownerKnowledgeBaseId: name
  };
  await t.stores.dataStores.putDataStore(record);
  return asset.id;
}

/** What the end of a sync of the Knowledge Base writes: its record, which queues the job. */
async function syncFinished(t: WorkflowFixture, knowledgeBaseId: string) {
  return t.stores.audit.appendAuditEvent({
    clientInstanceId,
    type: "knowledge_base.sync_finished",
    status: "success",
    subject: knowledgeBaseId,
    correlationId: "sync-correlation",
    metadata: SYNC
  });
}

const runsSchema = z.object({
  items: z.array(
    runSchema.extend({ trigger: z.string(), startedBy: z.object({ kind: z.string() }) })
  )
});

async function runsOf(t: WorkflowFixture, workflow: string) {
  const response = await t.expectOk(t.root.id, "workflows.list_runs", { params: { workflow } });
  return runsSchema.parse(response.json()).items;
}

describe("a platform event trigger", () => {
  it("starts one run per event as the Workflow's account, with the event's ids and counts", async () => {
    const t = (fixture = await workflowFixture({ definitions: "assets" }));
    const contracts = await knowledgeBase(t, "contracts");
    await t.allow({ kind: "service_principal", id: t.principal.id }, "knowledge_base.read");
    await save(t, onSync("on-any-sync"));
    const event = await syncFinished(t, contracts);
    const worker = t.worker();
    await worker.runDue();
    await worker.runDue();

    const [run, ...more] = await runsOf(t, "on-any-sync");
    expect(more).toEqual([]);
    expect(run).toMatchObject({
      trigger: "platform_event",
      startedBy: { kind: "service_principal" }
    });
    const ended = await t.finish(run?.id ?? "", worker);
    expect(ended.status).toBe("done");
    const stored = await t.stores.workflowRuns.readRun({ clientInstanceId, id: run?.id ?? "" });
    expect(stored?.triggerEvent).toEqual({
      id: event.id,
      name: "knowledge_base.sync_finished",
      occurredAt: event.createdAt,
      source: { kind: KNOWLEDGE_BASE_ASSET_KIND, id: contracts, name: "contracts" },
      // Only the event's declared fields: no mode, no bytes, never content.
      data: { syncRunId: "kbsync_1", source: "src_share", state: "completed", counts: SYNC.counts }
    });
    // The trigger's output hands the event to the steps after it.
    const result = (await stepRunsOf(t, run?.id ?? "")).find((step) => step.stepId === "result");
    expect(JSON.parse(result?.outputPreview?.text ?? "null")).toEqual({
      knowledgeBase: "contracts"
    });
    const [started] = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "workflow_run.started"
    });
    expect(started?.metadata).toMatchObject({
      trigger: "platform_event",
      event: "knowledge_base.sync_finished",
      eventId: event.id
    });
  });

  it("drops an event of a source the Workflow's account may not read", async () => {
    const t = (fixture = await workflowFixture({ definitions: "assets" }));
    const contracts = await knowledgeBase(t, "contracts");
    await save(t, onSync("on-any-sync"));
    const event = await syncFinished(t, contracts);
    await t.worker().runDue();

    expect(await runsOf(t, "on-any-sync")).toEqual([]);
    const dropped = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "workflow.event_dropped"
    });
    expect(dropped.map((record) => record.metadata)).toEqual([
      { event: "knowledge_base.sync_finished", eventId: event.id, reason: "source_unreadable" }
    ]);
  });

  it("queues nothing for an event written where the module is off", async () => {
    const t = (fixture = await workflowFixture({ definitions: "assets" }));
    const contracts = await knowledgeBase(t, "contracts");
    await t.allow({ kind: "service_principal", id: t.principal.id }, "knowledge_base.read");
    await save(t, onSync("on-any-sync"));
    // The stores of a process whose instance has the module `workflows` off.
    const off = await storesWithWorkflowsOff();
    try {
      await off.audit.appendAuditEvent({
        clientInstanceId,
        type: "knowledge_base.sync_finished",
        status: "success",
        subject: contracts,
        correlationId: "sync-correlation",
        metadata: SYNC
      });
    } finally {
      await off.close();
    }
    const worker = t.worker();
    await worker.runDue();
    await worker.runDue();
    expect(await runsOf(t, "on-any-sync")).toEqual([]);
  });

  it("drops an event older than a day when its job runs", async () => {
    let clock = new Date();
    const t = (fixture = await workflowFixture({ definitions: "assets", now: () => clock }));
    const contracts = await knowledgeBase(t, "contracts");
    await t.allow({ kind: "service_principal", id: t.principal.id }, "knowledge_base.read");
    await save(t, onSync("on-any-sync"));
    const event = await syncFinished(t, contracts);
    clock = new Date(Date.parse(event.createdAt) + WORKFLOW_TRIGGER_EVENT_MAX_AGE_MS + 60_000);
    const worker = t.worker();
    await worker.runDue();
    await worker.runDue();

    expect(await runsOf(t, "on-any-sync")).toEqual([]);
    const dropped = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "workflow.event_dropped"
    });
    expect(dropped.map((record) => record.metadata)).toEqual([
      { event: "knowledge_base.sync_finished", eventId: event.id, reason: "event_expired" }
    ]);
  });

  it("is published only where the account may read the Knowledge Base its filter names, and hears no other", async () => {
    const t = (fixture = await workflowFixture({ definitions: "assets" }));
    const contracts = await knowledgeBase(t, "contracts");
    const invoices = await knowledgeBase(t, "invoices");
    const manifest = onSync("on-contracts", { knowledgeBase: "contracts" });
    const written = await put(t, manifest);
    const { revision } = z.object({ revision: z.number() }).parse(written.json());
    const publish = () =>
      t.call(t.root.id, "assets.publish", {
        params: { kind: "workflow", name: manifest.id },
        payload: { revision }
      });
    const refused = await publish();
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { details: { action: "knowledge_base.read" } } });
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: t.principal.id,
      action: "knowledge_base.read",
      effect: "allow",
      scopeKind: "asset",
      scopeId: contracts,
      grantedBy: t.admin.id
    });
    expect((await publish()).statusCode).toBe(200);

    await syncFinished(t, invoices);
    await syncFinished(t, contracts);
    const worker = t.worker();
    await worker.runDue();
    await worker.runDue();
    const runs = await runsOf(t, "on-contracts");
    expect(runs).toHaveLength(1);
  });

  it("refuses a definition that names an event outside the list or filters by another key", async () => {
    const t = (fixture = await workflowFixture({ definitions: "assets" }));
    const unknown = onSync("unknown-event");
    Object.assign(unknown.steps[0]?.triggers?.[0] ?? {}, { event: "knowledge_base.document_read" });
    const refusedEvent = await put(t, unknown);
    expect(refusedEvent.statusCode).toBe(422);
    expect(refusedEvent.body).toContain("knowledge_base.sync_finished");

    const otherKey = await put(t, onSync("other-key", { dataStore: "contracts" }));
    expect(otherKey.statusCode).toBe(422);
    expect(otherKey.body).toContain("filtered by 'knowledgeBase' only");

    const twoHooksManifest = {
      ...onSync("two-hooks"),
      steps: [
        {
          id: "start",
          name: "Called",
          type: "trigger",
          triggers: [{ kind: "webhook" }, { kind: "webhook", perMinute: 5 }]
        }
      ]
    };
    const twoHooks = await put(t, twoHooksManifest);
    expect(twoHooks.statusCode).toBe(422);
    expect(twoHooks.body).toContain("at most one webhook trigger");
  });
});
