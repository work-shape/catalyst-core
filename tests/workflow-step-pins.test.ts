import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_ASSET_KIND,
  type JsonValue,
  type WorkflowRun,
  type WorkflowStepPin
} from "@work-shape/catalyst-core";
import { createWorkflowStepPins } from "@work-shape/catalyst-workflows";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { withTestSql } from "./support/test-sql";
import { runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { CLIENTS, NOTE, notifyClients, readyWorkflows, stepRunsOf } from "./support/workflow-runs";

// Pinned step outputs for test runs (EW-10) over HTTP, on Postgres and the engine's jobs: a
// person who may write a Workflow pins the output a step had in a run, and their test runs of
// the draft end that step with it instead of calling. Acceptance checks 27 and 27a of the
// Events, Workflows And Guardrails spec.

const WORKFLOW = "notify-clients";
const address = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };
const pinSchema = z.object({ step: z.string(), runId: z.string(), pinnedAt: z.string() });
const pinsSchema = z.object({ items: z.array(pinSchema) });
const testRunSchema = runSchema.extend({
  mode: z.string(),
  pinnedSteps: z.array(z.object({ step: z.string(), sourceRunId: z.string() })).optional()
});

describe("a pinned step output", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  /** The draft of `notify-clients`, and Kai, who may write and test it. */
  async function ready() {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
    await t.allow({ kind: "user", id: t.kai.id }, "connection.use");
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.write");
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.read");
    await save(t, notifyClients(), null);
    return t;
  }

  async function save(t: WorkflowFixture, manifest: unknown, expectedRevision: number | null) {
    const response = await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: { config: { name: WORKFLOW, manifest }, expectedRevision }
    });
    return z.object({ revision: z.number() }).parse(response.json()).revision;
  }

  /** Runs a test run of the draft as Kai to its end; answers it and the calls it made. */
  async function testRun(t: WorkflowFixture) {
    const before = t.executed.length;
    const response = await t.call(t.kai.id, "workflows.test", {
      params: { workflow: WORKFLOW },
      payload: { input: { note: NOTE } }
    });
    expect(response.json()).not.toHaveProperty("error");
    const started = testRunSchema.parse(response.json());
    const ended = await t.finish(started.id);
    expect(ended.status).toBe("done");
    return {
      run: started,
      calls: t.executed.slice(before).map((call) => call.operation),
      steps: await stepRunsOf(t, started.id)
    };
  }

  const pin = (t: WorkflowFixture, step: string, runId: string) =>
    t.call(t.kai.id, "workflows.pin_step", {
      params: { workflow: WORKFLOW, step },
      payload: { runId }
    });

  const pins = async (t: WorkflowFixture) =>
    pinsSchema.parse(
      (await t.expectOk(t.kai.id, "workflows.list_pins", { params: { workflow: WORKFLOW } })).json()
    ).items;

  // Acceptance check 27.
  it("ends the pinned step with the earlier output, calls nothing for it, and records it on the run", async () => {
    const t = await ready();
    const first = await testRun(t);
    expect(first.calls).toEqual(["echo"]);

    const pinned = pinSchema.parse((await pin(t, "clients", first.run.id)).json());
    expect(pinned).toMatchObject({ step: "clients", runId: first.run.id });
    expect(await pins(t)).toEqual([pinned]);

    // The outside system now answers one client: a run that called it would loop once.
    t.setBehaviour((operation, input) =>
      Promise.resolve<JsonValue>(
        operation === "echo" ? { clients: [{ id: "client-zoe" }] } : { received: input }
      )
    );
    const second = await testRun(t);
    expect(second.calls).toEqual([]);
    expect(second.run.pinnedSteps).toEqual([{ step: "clients", sourceRunId: first.run.id }]);
    const clients = second.steps.find((step) => step.stepId === "clients");
    expect(clients?.status).toBe("done");
    expect(JSON.parse(clients?.outputPreview?.text ?? "null")).toEqual({ clients: CLIENTS });
    expect(second.steps.filter((step) => step.stepId === "send")).toHaveLength(CLIENTS.length);

    // Unpinned, the next test run calls the step again.
    expect(
      (
        await t.expectOk(t.kai.id, "workflows.unpin_step", {
          params: { workflow: WORKFLOW, step: "clients" }
        })
      ).json()
    ).toEqual({ removed: true });
    const third = await testRun(t);
    expect(third.calls).toEqual(["echo"]);
    expect(third.run.pinnedSteps).toBeUndefined();
  });

  // Acceptance check 27a.
  it("is cleared once its step changes, and kept while another step does", async () => {
    const t = await ready();
    const first = await testRun(t);
    expect((await pin(t, "clients", first.run.id)).statusCode).toBe(200);

    const renamed = notifyClients();
    const result = renamed.steps.at(-1);
    if (result) result.name = "The result";
    const revision = await save(t, renamed, 1);
    expect((await pins(t)).map((entry) => entry.step)).toEqual(["clients"]);

    const changed = notifyClients();
    Object.assign(changed.steps[1] ?? {}, { input: { text: { value: NOTE } } });
    await save(t, changed, revision);
    expect(await pins(t)).toEqual([]);
    const next = await testRun(t);
    expect(next.calls).toEqual(["echo"]);
    expect(next.run.pinnedSteps).toBeUndefined();
  });

  it("is never used by a run of the published revision or by another person's test run", async () => {
    const t = await ready();
    const first = await testRun(t);
    expect((await pin(t, "clients", first.run.id)).statusCode).toBe(200);

    await t.expectOk(t.root.id, "assets.publish", { params: address, payload: { revision: 1 } });
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.use");
    const before = t.executed.length;
    const started = await t.expectOk(t.kai.id, "workflows.start", {
      params: { workflow: WORKFLOW },
      payload: { input: { note: NOTE } }
    });
    const live = testRunSchema.parse(started.json());
    expect((await t.finish(live.id)).status).toBe("done");
    expect(live.pinnedSteps).toBeUndefined();
    expect(t.executed.slice(before).map((call) => call.operation)).toContain("echo");

    const other = testRunSchema.parse(
      (
        await t.expectOk(t.admin.id, "workflows.test", {
          params: { workflow: WORKFLOW },
          payload: { input: { note: NOTE } }
        })
      ).json()
    );
    expect(other.pinnedSteps).toBeUndefined();
  });

  it("is gone once its run's data was removed", async () => {
    const t = await ready();
    const first = await testRun(t);
    expect((await pin(t, "clients", first.run.id)).statusCode).toBe(200);
    await withTestSql(async (sql) => {
      await sql`update workflow_step_runs set output = null where run_id = ${first.run.id}`;
      await sql`update workflow_runs set data_pruned_at = now() where id = ${first.run.id}`;
    });
    expect(await pins(t)).toEqual([]);
    const refused = await pin(t, "clients", first.run.id);
    expect(refused.statusCode).toBe(409);
    expect(errorSchema.parse(refused.json()).error.details).toMatchObject({
      reason: "pin_output_gone"
    });
  });

  it("is refused on a step inside a block, on another Workflow's run, and to a reader", async () => {
    const t = await ready();
    const first = await testRun(t);
    const inLoop = await pin(t, "send", first.run.id);
    expect(inLoop.statusCode).toBe(409);
    expect(errorSchema.parse(inLoop.json()).error.details).toMatchObject({
      reason: "pin_step_not_pinnable"
    });
    expect((await pin(t, "clients", "wfr_missing")).statusCode).toBe(404);

    await t.allow({ kind: "user", id: t.lena.id }, "workflow.read");
    const reader = await t.call(t.lena.id, "workflows.pin_step", {
      params: { workflow: WORKFLOW, step: "clients" },
      payload: { runId: first.run.id }
    });
    expect(reader.statusCode).toBe(403);
  });
});

describe("pinning an output that names its run's dataset", () => {
  it("is refused, since no other run can read it", async () => {
    const step = { id: "load", name: "Load", type: "operation", operation: "connection.crm.echo" };
    const manifest = {
      id: WORKFLOW,
      name: "Notify",
      steps: [{ id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] }, step]
    };
    const put: WorkflowStepPin[] = [];
    const source = { id: "wfr_source" } as WorkflowRun;
    const pins = createWorkflowStepPins({
      clientInstanceId,
      now: () => new Date("2026-10-30T10:00:00.000Z"),
      stores: {
        workflowRuns: {
          readRunDefinition: () => Promise.resolve(manifest),
          findStepOutput: () =>
            Promise.resolve({ value: { rows: { $dataset: "wds_1", rowCount: 1, bytes: 2 } } })
        },
        workflowStepPins: {
          put: ({ pin }) => {
            put.push(pin);
            return Promise.resolve();
          },
          list: () => Promise.resolve([]),
          remove: () => Promise.resolve(0)
        }
      } as unknown as Parameters<typeof createWorkflowStepPins>[0]["stores"]
    });
    await expect(
      pins.pin({
        assetId: "asset",
        pinnedBy: "user",
        draft: manifest as never,
        step: "load",
        source
      })
    ).rejects.toMatchObject({ details: { reason: "pin_output_not_portable" } });
    expect(put).toEqual([]);
  });
});
