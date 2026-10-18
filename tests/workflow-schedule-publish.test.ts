import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClientInstanceApp } from "@work-shape/catalyst-client-assembly";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { createTestConfig } from "./support/fixtures";
import { withTestSql } from "./support/test-sql";
import { fileTestDatabaseUrl } from "./support/test-database";
import { WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { workflowScheduleJobKind } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";
import type { WorkflowFixture } from "./support/workflow-instance";
import { notifyClients, readyWorkflows } from "./support/workflow-runs";

// Publishing activates the schedule (acceptance 8 of events, workflows and guardrails): a
// Workflow with a `schedule` trigger is written, published and deleted through the asset
// operations of one running instance, and the job of its schedule follows each of them. No
// process starts in between and nothing calls the planner of a starting process, so a test
// here fails where the publish or the delete leaves the job queue as it was.
//
// The clock of the engine and of the kind stands three seconds before a due time, in a year
// that is over for the database. A job the publish queues for that time is due at once for a
// worker, as it is when the three seconds have passed.

const WORKFLOW = "notify-clients";
const address = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };
const NOW = new Date("2020-03-10T10:59:57Z");
const hourly = { kind: "schedule", cron: "0 * * * *" };
const halfPast = { kind: "schedule", cron: "30 * * * *" };

/** `notify-clients` with these triggers. A schedule gives a run no input, so no step reads one. */
function scheduled(triggers: unknown[]) {
  const definition = notifyClients();
  const [trigger] = definition.steps;
  return {
    ...definition,
    inputs: { type: "object" },
    steps: [
      { ...trigger, triggers },
      {
        id: "clients",
        name: "Read the clients",
        type: "operation",
        operation: "connection.crm.echo",
        input: { text: { value: "scheduled" } }
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { clients: { ref: { step: "clients", path: "clients" } } }
      }
    ]
  };
}

const writeSchema = z.object({ revision: z.number() });

describe("the schedule of a Workflow that is published while the instance runs", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  const ready = (now = () => NOW, timeZone?: string) =>
    readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets", now, ...(timeZone === undefined ? {} : { timeZone }) }
    );

  /** Writes the definition as the draft and publishes it. Answers the revision. */
  async function publish(t: WorkflowFixture, triggers: unknown[], expectedRevision: number | null) {
    const written = await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: { config: { name: WORKFLOW, manifest: scheduled(triggers) }, expectedRevision }
    });
    const { revision } = writeSchema.parse(written.json());
    // The superadmin may let a Workflow act as a service principal.
    await t.expectOk(t.root.id, "assets.publish", { params: address, payload: { revision } });
    return revision;
  }

  /** How many schedule jobs of the Workflow wait for their due time. */
  const waiting = async (t: WorkflowFixture) =>
    (
      await t.stores.jobs.listOverview({
        clientInstanceId,
        filters: { kind: workflowScheduleJobKind.kind, statuses: ["queued"] }
      })
    ).filter((job) => job.subject === WORKFLOW).length;

  const runsOf = async (t: WorkflowFixture) =>
    (await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: WORKFLOW })).map((run) => ({
      trigger: run.trigger,
      scheduledFor: run.scheduledFor
    }));

  it("stores the schedule zone and queues its shown Berlin wall clock rather than UTC", async () => {
    const t = await ready();
    await publish(t, [{ kind: "schedule", cron: "25 23 * * *", timeZone: "Europe/Berlin" }], null);
    const stored = await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address });
    expect(stored?.config).toMatchObject({
      manifest: { steps: [{ triggers: [{ timeZone: "Europe/Berlin" }] }, {}, {}] }
    });
    await withTestSql(async (sql) => {
      const jobs =
        await sql`select run_after from platform_jobs where kind = ${workflowScheduleJobKind.kind} and subject = ${WORKFLOW} and status = 'queued'`;
      expect(jobs.map((job) => job.run_after.toISOString())).toEqual(["2020-03-10T22:25:00.000Z"]);
    });
    const planned = await t.workflows.planSchedule(WORKFLOW);
    expect(planned?.dueAt).toBe("2020-03-10T22:25:00.000Z");
  });

  it("binds a schedule without a zone to the configured instance zone on save", async () => {
    const t = await ready(() => NOW, "Europe/Berlin");
    await publish(t, [{ kind: "schedule", cron: "25 23 * * *" }], null);
    const stored = await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address });
    expect(stored?.config).toMatchObject({
      manifest: { steps: [{ triggers: [{ timeZone: "Europe/Berlin" }] }, {}, {}] }
    });
    expect((await t.workflows.planSchedule(WORKFLOW))?.dueAt).toBe("2020-03-10T22:25:00.000Z");
  });

  it("repairs a missing next-due job once on each worker process restart", async () => {
    const t = await ready();
    await publish(t, [hourly], null);
    const withdraw = () =>
      t.stores.jobs.withdraw(workflowScheduleJobKind, {
        clientInstanceId,
        dedupeKey: `${workflowScheduleJobKind.kind}:${WORKFLOW}:2020-03-10T11:00:00.000Z`
      });
    await withdraw();
    expect(await waiting(t)).toBe(0);
    const base = createTestConfig();
    const config = parseClientInstanceConfig({
      ...base,
      clientInstance: { ...base.clientInstance, id: clientInstanceId },
      modules: { workflows: { enabled: true } }
    });
    const databaseUrl = await fileTestDatabaseUrl();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      for (let restart = 0; restart < 3; restart++) {
        // This is the production assembly that starts the Workflow job worker. Opening
        // the already migrated store must repair scheduling without any migration call.
        const app = await createClientInstanceApp({
          config,
          tools: [],
          capabilities: [],
          env: { DATABASE_URL: databaseUrl }
        });
        try {
          expect(await waiting(t)).toBe(1);
        } finally {
          await app.close();
        }
      }
      await withdraw();
      expect(await waiting(t)).toBe(0);
      const app = await createClientInstanceApp({
        config,
        tools: [],
        capabilities: [],
        env: { DATABASE_URL: databaseUrl }
      });
      try {
        expect(await waiting(t)).toBe(1);
      } finally {
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a refused definition, queues its next due time and runs after repair", async () => {
    let clock = NOW;
    const t = await ready(() => clock);
    const revision = await publish(t, [hourly], null);
    // Simulate a published revision an earlier release accepted: its schedule is valid,
    // but this release refuses the definition. Use stores as the historical writer did.
    const changed = await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [`${WORKFLOW_ASSET_KIND}:${WORKFLOW}`]: revision },
      mutations: [
        {
          type: "upsert",
          ...address,
          draft: true,
          config: z.record(z.string(), z.json()).parse({
            name: WORKFLOW,
            manifest: { ...scheduled([hourly]), id: "another-workflow" }
          })
        }
      ]
    });
    const held = changed.revisions[`${WORKFLOW_ASSET_KIND}:${WORKFLOW}`] ?? 0;
    const asset = await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address });
    const record = await t.stores.configAssets.getConfigAssetRevision({
      clientInstanceId,
      ...address,
      revision: held
    });
    await t.stores.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      ...address,
      assetId: asset?.id ?? "",
      revision: held,
      revisionId: record?.id ?? ""
    });
    const worker = t.worker(
      t.workflows.jobHandlers.filter(
        (handler) => handler.kind.kind === workflowScheduleJobKind.kind
      )
    );
    await worker.runDue();
    expect(await runsOf(t)).toEqual([]);
    const notices = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "workflow_run.tick_skipped"
    });
    expect(notices.map((event) => event.metadata)).toEqual([
      {
        workflow: WORKFLOW,
        scheduledFor: "2020-03-10T11:00:00.000Z",
        reason: "definition_invalid"
      }
    ]);
    expect(await waiting(t)).toBe(1);
    clock = new Date("2020-03-10T11:59:57Z");
    await publish(t, [hourly], held);
    await worker.runDue();
    expect(await runsOf(t)).toEqual([
      { trigger: "schedule", scheduledFor: "2020-03-10T12:00:00.000Z" }
    ]);
  });

  it("starts one run at the due time, with no process started since the publish", async () => {
    const t = await ready();
    await publish(t, [hourly], null);
    expect(await waiting(t)).toBe(1);

    const worker = t.worker();
    await worker.runDue();
    expect(await runsOf(t)).toEqual([
      { trigger: "schedule", scheduledFor: "2020-03-10T11:00:00.000Z" }
    ]);
    // One run, however often the worker looks, and the job of the time after it waits.
    await worker.runDue();
    expect(await runsOf(t)).toHaveLength(1);
    expect(await waiting(t)).toBe(1);
  });

  it("starts nothing at the due time of a schedule another publish replaced", async () => {
    const t = await ready();
    const first = await publish(t, [hourly], null);
    await publish(t, [halfPast], first);
    // The job of eleven o'clock is gone with the schedule that named it: one job waits, and
    // the run it starts below is the one of half past.
    expect(await waiting(t)).toBe(1);

    await t.worker().runDue();
    expect(await runsOf(t)).toEqual([
      { trigger: "schedule", scheduledFor: "2020-03-10T11:30:00.000Z" }
    ]);
  });

  it("waits for nothing once a publish takes the schedule away", async () => {
    const t = await ready();
    const first = await publish(t, [hourly], null);
    expect(await waiting(t)).toBe(1);
    await publish(t, [{ kind: "manual" }], first);
    expect(await waiting(t)).toBe(0);
    await t.worker().runDue();
    expect(await runsOf(t)).toEqual([]);
  });

  it("starts nothing for a Workflow that was deleted", async () => {
    const t = await ready();
    const revision = await publish(t, [hourly], null);
    expect(await waiting(t)).toBe(1);
    await t.expectOk(t.admin.id, "assets.delete", {
      params: address,
      payload: { expectedRevision: revision }
    });
    expect(await waiting(t)).toBe(0);
    await t.worker().runDue();
    expect(await runsOf(t)).toEqual([]);
  });
});
