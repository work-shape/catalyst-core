import { afterEach, describe, expect, it } from "vitest";
import {
  lastDueWithin,
  nextDueAfter,
  parseCron,
  parseWorkflowManifest,
  workflowScheduleJobKind
} from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";
import {
  publishedDefinitions,
  runSchema,
  type workflowFixture,
  type WorkflowFixture
} from "./support/workflow-instance";
import {
  notifyClients,
  readyWorkflows,
  start,
  stepRunsOf,
  writesOf
} from "./support/workflow-runs";

// The `schedule` trigger: a published Workflow with a cron expression has one job that waits
// for its next due time and starts the run of that time. The engine's clock is the test's, in
// a year no job of the test comes due in by itself, so each due time is fired by the test.

const at = (time: string) => new Date(time);
const iso = (date: Date | undefined) => date?.toISOString();

describe("a cron expression", () => {
  const crons = (...texts: string[]) =>
    texts.map((text) => {
      const cron = parseCron(text);
      if (!cron) throw new Error(`'${text}' is no cron expression`);
      return cron;
    });

  it("is five fields of numbers, ranges, steps and lists, and nothing else", () => {
    for (const text of ["* * * * *", "0 6 * * 1-5", "*/15 8-18 1,15 * *", "5/20 0 * 1-6/2 7"]) {
      expect(parseCron(text), text).toBeDefined();
    }
    for (const text of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "a * * * *"]) {
      expect(parseCron(text), text).toBeUndefined();
    }
    expect(parseCron("0 0 0 * *")).toBeUndefined();
    expect(parseCron("0 0 * 13 *")).toBeUndefined();
    expect(parseCron("0 0 * * 8")).toBeUndefined();
    expect(parseCron("5-1 * * * *")).toBeUndefined();
    expect(parseCron("*/0 * * * *")).toBeUndefined();
  });

  it("names the next due time after a moment and the latest within a span", () => {
    const hourly = crons("0 * * * *");
    expect(iso(nextDueAfter(hourly, at("2030-03-10T10:30:20Z"), "UTC"))).toBe(
      "2030-03-10T11:00:00.000Z"
    );
    // A moment that is itself due is not after itself.
    expect(iso(nextDueAfter(hourly, at("2030-03-10T11:00:00Z"), "UTC"))).toBe(
      "2030-03-10T12:00:00.000Z"
    );
    expect(
      iso(lastDueWithin(hourly, at("2030-03-10T07:00:00Z"), at("2030-03-10T10:30:20Z"), "UTC"))
    ).toBe("2030-03-10T10:00:00.000Z");
    // Both ends of the span are in it; a span without a due time has none.
    expect(
      iso(lastDueWithin(hourly, at("2030-03-10T10:00:00Z"), at("2030-03-10T10:00:00Z"), "UTC"))
    ).toBe("2030-03-10T10:00:00.000Z");
    expect(
      lastDueWithin(hourly, at("2030-03-10T10:01:00Z"), at("2030-03-10T10:59:00Z"), "UTC")
    ).toBeUndefined();
    // Weekdays at six, across a weekend: the 8th of March 2030 is a Friday.
    const weekdays = crons("0 6 * * 1-5");
    expect(iso(nextDueAfter(weekdays, at("2030-03-08T06:00:00Z"), "UTC"))).toBe(
      "2030-03-11T06:00:00.000Z"
    );
    // The first of a month or a Monday: with both named, a day that fits either is due.
    const either = crons("0 0 1 * 1");
    expect(iso(nextDueAfter(either, at("2030-03-25T00:00:00Z"), "UTC"))).toBe(
      "2030-04-01T00:00:00.000Z"
    );
    expect(iso(nextDueAfter(either, at("2030-04-01T00:00:00Z"), "UTC"))).toBe(
      "2030-04-08T00:00:00.000Z"
    );
    // Of two expressions the nearer one, and a day no month has is never due.
    expect(
      iso(nextDueAfter(crons("0 12 * * *", "30 9 * * *"), at("2030-03-10T08:00:00Z"), "UTC"))
    ).toBe("2030-03-10T09:30:00.000Z");
    expect(nextDueAfter(crons("0 0 31 2 *"), at("2030-01-01T00:00:00Z"), "UTC")).toBeUndefined();
  });

  it("reads the clock of the time zone, across the days the clock is changed", () => {
    const six = crons("0 6 * * *");
    // Berlin is an hour ahead of UTC in winter and two in summer; the clock changes on the
    // 31st of March 2030.
    expect(iso(nextDueAfter(six, at("2030-03-30T12:00:00Z"), "Europe/Berlin"))).toBe(
      "2030-03-31T04:00:00.000Z"
    );
    expect(iso(nextDueAfter(six, at("2030-03-29T12:00:00Z"), "Europe/Berlin"))).toBe(
      "2030-03-30T05:00:00.000Z"
    );
    expect(
      iso(
        lastDueWithin(six, at("2030-03-29T00:00:00Z"), at("2030-03-31T12:00:00Z"), "Europe/Berlin")
      )
    ).toBe("2030-03-31T04:00:00.000Z");
    // Half past midnight on the day after an hour was skipped is not skipped with it.
    expect(
      iso(nextDueAfter(crons("30 0 * * *"), at("2030-03-31T00:00:00Z"), "Europe/Berlin"))
    ).toBe("2030-03-31T22:30:00.000Z");
  });
});

/** `notify-clients` with these triggers. A schedule gives a run no input, so no step reads one. */
const scheduled = (triggers: unknown[]) => {
  const definition = notifyClients();
  const [trigger, , , result] = definition.steps;
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
        id: "each_client",
        name: "For each client",
        type: "loop",
        items: { step: "clients", path: "clients" },
        steps: [
          {
            id: "send",
            name: "Send",
            type: "operation",
            operation: "connection.crm.write",
            input: { client: { ref: { step: "each_client", path: "id" } } }
          }
        ]
      },
      result
    ]
  };
};
const hourly = { kind: "schedule", cron: "0 * * * *" };

describe("a definition with a schedule trigger", () => {
  const refused = (triggers: unknown[]) => {
    const result = parseWorkflowManifest(scheduled(triggers));
    return result.ok ? [] : result.issues.map((issue) => [issue.code ?? "", issue.path]);
  };

  it("is accepted alone and beside the start by hand, with the defaults of a schedule", () => {
    expect(refused([hourly])).toEqual([]);
    expect(refused([{ kind: "manual" }, hourly])).toEqual([]);
    const result = parseWorkflowManifest(scheduled([hourly]));
    const [trigger] = result.ok ? result.manifest.steps : [];
    expect(trigger).toMatchObject({
      triggers: [{ kind: "schedule", cron: "0 * * * *", missed: "last", overlap: "skip" }]
    });
  });

  it("is refused for a cron expression that is none and for what a schedule does not do yet", () => {
    expect(refused([{ kind: "schedule", cron: "every hour" }])).toEqual([
      ["", "steps.start.triggers"]
    ]);
    expect(refused([{ ...hourly, missed: "all" }])).toEqual([
      ["not_supported_yet", "steps[0].triggers[0].missed"]
    ]);
    expect(refused([{ ...hourly, missed: "skip" }])).toEqual([
      ["not_supported_yet", "steps[0].triggers[0].missed"]
    ]);
    expect(refused([{ ...hourly, overlap: "queue" }])).toEqual([
      ["not_supported_yet", "steps[0].triggers[0].overlap"]
    ]);
    expect(refused([{ kind: "manual" }, { kind: "parent" }])).toEqual([
      ["not_supported_yet", "steps[0].triggers[1].kind"]
    ]);
  });
});

describe("the runs a schedule starts", () => {
  let open: WorkflowFixture | undefined;
  let clock = at("2030-03-10T10:30:20Z");
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
    clock = at("2030-03-10T10:30:20Z");
  });

  async function ready(triggers: unknown[], options: Parameters<typeof workflowFixture>[0] = {}) {
    const definitions = publishedDefinitions();
    definitions.publish(scheduled(triggers));
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: definitions.source, now: () => clock, ...options }
    );
    return { t, definitions };
  }

  /** Queues the job of one due time, due at once: the job as it stands when its time has come. */
  const due = (t: WorkflowFixture, dueAt: string) =>
    t.stores.jobs.enqueue(
      workflowScheduleJobKind,
      { workflow: "notify-clients", dueAt },
      { clientInstanceId, subject: "notify-clients", dedupeKey: `test:${dueAt}` }
    );

  const runsOf = async (t: WorkflowFixture) =>
    (await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: "notify-clients" })).map(
      (run) => ({
        trigger: run.trigger,
        scheduledFor: run.scheduledFor,
        startedBy: run.startedBy,
        status: run.status
      })
    );

  const queued = async (t: WorkflowFixture) =>
    (
      await t.stores.jobs.listOverview({
        clientInstanceId,
        filters: { kind: workflowScheduleJobKind.kind, statuses: ["queued"] }
      })
    ).map((job) => job.subject);

  const skipped = async (t: WorkflowFixture) =>
    (
      await t.stores.audit.listAuditEvents({ clientInstanceId, type: "workflow_run.tick_skipped" })
    ).map((event) => event.metadata);

  it("plans the next due time of each scheduled Workflow once, however often it is asked", async () => {
    const { t } = await ready([hourly]);
    expect(await t.workflows.planSchedules()).toEqual([
      { workflow: "notify-clients", dueAt: "2030-03-10T11:00:00.000Z" }
    ]);
    await t.workflows.planSchedules();
    await t.workflows.planSchedules();
    expect(await queued(t)).toEqual(["notify-clients"]);
    // Nothing is due yet, so nothing starts.
    await t.worker().runDue();
    expect(await runsOf(t)).toEqual([]);
  });

  it("plans nothing for a Workflow that is started by hand alone", async () => {
    const { t } = await ready([{ kind: "manual" }]);
    expect(await t.workflows.planSchedules()).toEqual([]);
    expect(await queued(t)).toEqual([]);
  });

  it("starts one run for the due time, as the Workflow's principal, and queues the next", async () => {
    const { t } = await ready([hourly]);
    await due(t, "2030-03-10T10:00:00.000Z");
    const worker = t.worker();
    await worker.runDue();

    const [run] = await t.stores.workflowRuns.listRuns({
      clientInstanceId,
      workflow: "notify-clients"
    });
    expect(run).toMatchObject({
      trigger: "schedule",
      scheduledFor: "2030-03-10T10:00:00.000Z",
      status: "queued",
      // Nobody started it: the schedule did, as the principal the Workflow runs as.
      startedBy: { kind: "service_principal", id: t.principal.id },
      principal: { id: t.principal.id }
    });
    // The job of the next due time waits for it.
    expect(await queued(t)).toEqual(["notify-clients"]);

    const ended = await t.finish(run?.id ?? "", worker);
    expect(ended.status).toBe("done");
    expect(writesOf(t)).toHaveLength(3);
    const calls = (await t.runs()).filter((call) => call.origin.kind === "workflow");
    expect(calls.every((call) => call.actor.id === t.principal.id)).toBe(true);
    // The trigger hands the due time on, and the API answers it on the run.
    const read = await t.expectOk(t.root.id, "workflows.get_run", {
      params: { runId: ended.id }
    });
    expect(read.json()).toMatchObject({
      trigger: "schedule",
      scheduledFor: "2030-03-10T10:00:00.000Z"
    });
    const [started] = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "workflow_run.started"
    });
    expect(started).toMatchObject({
      actor: { principalKind: "service", principalId: t.principal.id },
      metadata: { trigger: "schedule", scheduledFor: "2030-03-10T10:00:00.000Z" }
    });
  });

  it("starts once for the times it missed while the instance was down, at the latest of them", async () => {
    const { t } = await ready([hourly]);
    // The job was queued for seven; nothing ran it until half past ten.
    await due(t, "2030-03-10T07:00:00.000Z");
    await t.worker().runDue();
    expect(await runsOf(t)).toEqual([
      expect.objectContaining({ trigger: "schedule", scheduledFor: "2030-03-10T10:00:00.000Z" })
    ]);
    expect(await skipped(t)).toEqual([]);
  });

  it("starts a due time once, whichever worker fires it and however often", async () => {
    const { t } = await ready([hourly]);
    // Two jobs that both find ten o'clock due, as after a restart that planned a second one.
    await due(t, "2030-03-10T09:00:00.000Z");
    await due(t, "2030-03-10T10:00:00.000Z");
    await Promise.all([t.worker().runDue(), t.worker().runDue()]);
    await t.worker().runDue();
    expect(await runsOf(t)).toHaveLength(1);
    // And the same job again, when its first attempt has started the run already.
    await due(t, "2030-03-10T08:00:00.000Z");
    await t.worker().runDue();
    expect(await runsOf(t)).toHaveLength(1);
    // The second look is no skipped due time: the time has its run.
    expect(await skipped(t)).toEqual([]);
    expect(await queued(t)).toEqual(["notify-clients"]);
  });

  it("skips a due time that meets the open run of an earlier one, and says so", async () => {
    const { t } = await ready([hourly]);
    await due(t, "2030-03-10T10:00:00.000Z");
    await t.worker().runDue();
    // An hour on, the run of ten o'clock has not ended.
    clock = at("2030-03-10T11:00:30Z");
    await due(t, "2030-03-10T11:00:00.000Z");
    await t.worker().runDue();
    expect((await runsOf(t)).map((run) => run.scheduledFor)).toEqual(["2030-03-10T10:00:00.000Z"]);
    expect(await skipped(t)).toEqual([
      { workflow: "notify-clients", scheduledFor: "2030-03-10T11:00:00.000Z", reason: "overlap" }
    ]);
  });

  it("starts nothing as a principal that is disabled, and says so", async () => {
    const { t } = await ready([hourly]);
    await t.stores.apiAccess.updateServicePrincipal({
      clientInstanceId,
      servicePrincipalId: t.principal.id,
      status: "disabled"
    });
    await due(t, "2030-03-10T10:00:00.000Z");
    await t.worker().runDue();
    expect(await runsOf(t)).toEqual([]);
    expect(await skipped(t)).toEqual([
      {
        workflow: "notify-clients",
        scheduledFor: "2030-03-10T10:00:00.000Z",
        reason: "principal_inactive"
      }
    ]);
    // The schedule goes on: the next due time is queued.
    expect(await queued(t)).toEqual(["notify-clients"]);
  });

  it("ends its line of jobs where the Workflow has no schedule any more", async () => {
    const { t, definitions } = await ready([hourly]);
    definitions.publish(scheduled([{ kind: "manual" }]));
    await due(t, "2030-03-10T10:00:00.000Z");
    await t.worker().runDue();
    expect(await runsOf(t)).toEqual([]);
    expect(await queued(t)).toEqual([]);
  });

  it("is started by hand as well where the definition names both triggers", async () => {
    const { t } = await ready([{ kind: "manual" }, hourly]);
    const started = await start(t);
    const run = runSchema.parse(
      (await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: started.id } })).json()
    );
    expect(run.startedBy).toMatchObject({ kind: "user", id: t.root.id });
    expect((await t.finish(started.id)).status).toBe("done");
    // The clock of this test stands still, so the step runs are told apart by their step.
    const trigger = (await stepRunsOf(t, started.id)).find((stepRun) => stepRun.stepId === "start");
    expect(trigger).toMatchObject({ status: "done" });
    // A schedule alone is not started by hand.
    await t.instance.close();
    const alone = await ready([hourly]);
    await alone.t.expectRefused(
      alone.t.root.id,
      "workflows.start",
      { params: { workflow: "notify-clients" }, payload: {} },
      { status: 409, code: "CONFLICT" }
    );
  });
});
