import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
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

  const ready = () =>
    readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets", now: () => NOW }
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
