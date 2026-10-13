import { afterEach, describe, expect, it } from "vitest";
import { clientInstanceConfigSchema } from "@vivd-catalyst/config-schema";
import {
  lastDueWithin,
  nextDueAfter,
  parseCron,
  workflowScheduleJobKind,
  type WorkflowDefinitionSource
} from "@vivd-catalyst/workflows";
import { clientInstanceId } from "./support/access-instance";
import {
  publishedDefinitions,
  workflowFixture,
  type WorkflowFixture
} from "./support/workflow-instance";
import { readyWorkflows } from "./support/workflow-runs";

// The clocks of a schedule. The job of a due time is claimed on the database's clock and
// handled by a process with a clock of its own, and the due times are read on the clock of
// the instance's time zone, which is changed twice a year.

const at = (time: string) => new Date(time);
const iso = (date: Date | undefined) => date?.toISOString();
const cronOf = (text: string) => {
  const cron = parseCron(text);
  if (!cron) throw new Error(`'${text}' is no cron expression`);
  return [cron];
};

/** A Workflow that does nothing but run: its trigger and its result. */
const tick = (cron: string) => ({
  id: "tick",
  name: "Tick",
  runAs: "workflow-runner",
  inputs: { type: "object" },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "schedule", cron }] },
    { id: "result", name: "Result", type: "output", input: {} }
  ]
});

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

async function ready(
  cron: string,
  options: Parameters<typeof workflowFixture>[0] = {},
  wrap: (source: WorkflowDefinitionSource) => WorkflowDefinitionSource = (source) => source
) {
  const definitions = publishedDefinitions();
  definitions.publish(tick(cron));
  return readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: wrap(definitions.source), ...options }
  );
}

/** The job of one due time as the engine queues it, due at once. */
const due = (t: WorkflowFixture, dueAt: string) =>
  t.stores.jobs.enqueue(
    workflowScheduleJobKind,
    { workflow: "tick", dueAt },
    {
      clientInstanceId,
      subject: "tick",
      dedupeKey: `${workflowScheduleJobKind.kind}:tick:${dueAt}`
    }
  );

const scheduledFor = async (t: WorkflowFixture) =>
  (await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: "tick" }))
    .map((run) => run.scheduledFor)
    .sort();

const jobs = async (t: WorkflowFixture, status: "queued" | "dead") =>
  (
    await t.stores.jobs.listOverview({
      clientInstanceId,
      filters: { kind: workflowScheduleJobKind.kind, statuses: [status] }
    })
  ).length;

describe("a schedule on the days the clock of its time zone is changed", () => {
  const berlin = "Europe/Berlin";

  it("runs a time the clock skips once, at the first minute after the gap", () => {
    // On the 31st of March 2030 the clock in Berlin goes from 01:59 to 03:00.
    const halfPastTwo = cronOf("30 2 * * *");
    expect(iso(nextDueAfter(halfPastTwo, at("2030-03-30T12:00:00Z"), berlin))).toBe(
      "2030-03-31T01:00:00.000Z"
    );
    // Once: the next one is half past two on the day after.
    expect(iso(nextDueAfter(halfPastTwo, at("2030-03-31T01:00:00Z"), berlin))).toBe(
      "2030-04-01T00:30:00.000Z"
    );
    // Looking back finds the same minute, from any moment of that day.
    expect(
      iso(
        lastDueWithin(halfPastTwo, at("2030-03-30T12:00:00Z"), at("2030-03-31T20:00:00Z"), berlin)
      )
    ).toBe("2030-03-31T01:00:00.000Z");
    expect(
      iso(
        lastDueWithin(halfPastTwo, at("2030-03-31T01:00:00Z"), at("2030-03-31T01:00:00Z"), berlin)
      )
    ).toBe("2030-03-31T01:00:00.000Z");
    // Every quarter of an hour: the four of the skipped hour are one run, and then it goes on.
    const quarters = cronOf("*/15 * * * *");
    expect(iso(nextDueAfter(quarters, at("2030-03-31T00:45:00Z"), berlin))).toBe(
      "2030-03-31T01:00:00.000Z"
    );
    expect(iso(nextDueAfter(quarters, at("2030-03-31T01:00:00Z"), berlin))).toBe(
      "2030-03-31T01:15:00.000Z"
    );
    // A time that exists that day is not moved.
    expect(iso(nextDueAfter(cronOf("30 3 * * *"), at("2030-03-30T12:00:00Z"), berlin))).toBe(
      "2030-03-31T01:30:00.000Z"
    );
  });

  it("runs a time the clock shows twice once, the first time", () => {
    // On the 27th of October 2030 the clock in Berlin goes from 02:59 back to 02:00.
    const halfPastTwo = cronOf("30 2 * * *");
    expect(iso(nextDueAfter(halfPastTwo, at("2030-10-26T12:00:00Z"), berlin))).toBe(
      "2030-10-27T00:30:00.000Z"
    );
    // The second half past two, an hour later, is not due.
    expect(iso(nextDueAfter(halfPastTwo, at("2030-10-27T00:30:00Z"), berlin))).toBe(
      "2030-10-28T01:30:00.000Z"
    );
    expect(
      iso(
        lastDueWithin(halfPastTwo, at("2030-10-26T12:00:00Z"), at("2030-10-27T12:00:00Z"), berlin)
      )
    ).toBe("2030-10-27T00:30:00.000Z");
    expect(
      lastDueWithin(halfPastTwo, at("2030-10-27T01:00:00Z"), at("2030-10-27T02:00:00Z"), berlin)
    ).toBeUndefined();
    // Every hour on the hour that day: 25 hours, and the hour shown twice runs once.
    const hourly = cronOf("0 * * * *");
    const times: string[] = [];
    for (
      let time = nextDueAfter(hourly, at("2030-10-26T21:59:00Z"), berlin);
      time && time < at("2030-10-27T23:00:00Z");
      time = nextDueAfter(hourly, time, berlin)
    ) {
      times.push(time.toISOString().slice(11, 16));
    }
    expect(times).toHaveLength(24);
    expect(times).toContain("00:00");
    expect(times).not.toContain("01:00");
  });

  it("starts those runs once in an instance whose time zone is Berlin", async () => {
    const march = await ready("30 2 * * *", {
      timeZone: berlin,
      now: () => at("2030-03-31T01:10:00Z")
    });
    expect(await march.workflows.planSchedule("tick")).toEqual({
      workflow: "tick",
      dueAt: "2030-04-01T00:30:00.000Z"
    });
    await due(march, "2030-03-31T01:00:00.000Z");
    await march.worker().runDue();
    expect(await scheduledFor(march)).toEqual(["2030-03-31T01:00:00.000Z"]);
  });

  it("starts the time shown twice once in an instance whose time zone is Berlin", async () => {
    const october = await ready("30 2 * * *", {
      timeZone: berlin,
      now: () => at("2030-10-27T01:40:00Z")
    });
    await due(october, "2030-10-27T00:30:00.000Z");
    // A job for the second half past two, were one queued, finds nothing due.
    await due(october, "2030-10-27T01:30:00.000Z");
    await october.worker().runDue();
    await october.worker().runDue();
    expect(await scheduledFor(october)).toEqual(["2030-10-27T00:30:00.000Z"]);
  });

  it("is UTC where the instance names no time zone, and refuses a name that is none", async () => {
    const clientInstance = clientInstanceConfigSchema.shape.clientInstance;
    const named = (timeZone?: string) =>
      clientInstance.safeParse({ id: "demo", displayName: "Demo", timeZone });
    expect(named("Europe/Berlin")).toMatchObject({ success: true });
    expect(named("UTC")).toMatchObject({ success: true });
    expect(named()).toMatchObject({ success: true, data: { id: "demo" } });
    expect(named("Europe/Atlantis").success).toBe(false);
    expect(named("").success).toBe(false);
    await expect(workflowFixture({ timeZone: "Europe/Atlantis" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });

    const t = await ready("30 2 * * *", { now: () => at("2030-03-31T01:10:00Z") });
    expect(await t.workflows.planSchedule("tick")).toEqual({
      workflow: "tick",
      dueAt: "2030-03-31T02:30:00.000Z"
    });
  });
});

describe("a schedule whose process and database disagree on the time", () => {
  /** This minute of every hour, and the start of this minute: a due time on the real clock. */
  function thisMinute() {
    const dueAt = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    return { cron: `${String(dueAt.getUTCMinutes())} * * * *`, dueAt: dueAt.toISOString() };
  }

  it.each([
    ["behind the database's by ten minutes", -10 * 60_000],
    ["behind the database's by half a second", -500],
    ["ahead of the database's by ninety seconds", 90_000]
  ])("starts the run and queues the next due time with a process clock %s", async (_, skew) => {
    const { cron, dueAt } = thisMinute();
    const t = await ready(cron, { now: () => new Date(Date.now() + skew) });
    // The database's clock has reached the job's time: it claims the job.
    await due(t, dueAt);
    await t.worker().runDue();
    // The job is due whatever the process's clock says, and it is the job of that time.
    expect(await scheduledFor(t)).toEqual([dueAt]);
    // The schedule goes on: the job of the next due time exists, and it is another job.
    expect(await jobs(t, "queued")).toBe(1);
  });

  it("queues the next due time when every attempt of one failed", async () => {
    const { cron, dueAt } = thisMinute();
    let reads = 0;
    const t = await ready(cron, {}, (source) => ({
      list: () => source.list(),
      // The store of the definitions is away for the three attempts of this due time.
      read(id) {
        reads += 1;
        return reads <= 3 ? Promise.reject(new Error("The store is away")) : source.read(id);
      }
    }));
    await due(t, dueAt);
    const worker = t.worker();
    for (let pass = 0; pass < 200 && (await jobs(t, "dead")) === 0; pass++) {
      await worker.runDue();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await jobs(t, "dead")).toBe(1);
    expect(await scheduledFor(t)).toEqual([]);
    // That due time is lost, and the schedule is not: the next one is queued.
    expect(await jobs(t, "queued")).toBe(1);
  }, 60_000);
});

describe("the schedule of one Workflow", () => {
  it("is planned when its definition is published and ends when it is taken back", async () => {
    const definitions = publishedDefinitions();
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: definitions.source, now: () => at("2030-03-10T10:30:20Z") }
    );
    // Nothing is published yet.
    expect(await t.workflows.planSchedule("tick")).toBeUndefined();
    definitions.publish(tick("0 * * * *"));
    expect(await t.workflows.planSchedule("tick")).toEqual({
      workflow: "tick",
      dueAt: "2030-03-10T11:00:00.000Z"
    });
    // Asked again, it queues no second job.
    await t.workflows.planSchedule("tick");
    expect(await jobs(t, "queued")).toBe(1);
    // A Workflow that is started by hand alone has nothing to plan.
    definitions.publish({
      ...tick("0 * * * *"),
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    });
    expect(await t.workflows.planSchedule("tick")).toBeUndefined();
  });
});
