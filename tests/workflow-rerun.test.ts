import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_ASSET_KIND,
  asAgentRunId,
  asConversationId,
  asToolCallId,
  connectionCallError,
  createPlatformId,
  type JsonValue,
  type OperationExecutionContext
} from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { identityOf } from "./support/connection-operations";
import { runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { CLIENTS, NOTE, notifyClients, readyWorkflows, stepRunsOf } from "./support/workflow-runs";

// Re-running an ended run from a chosen step (EW-11) over HTTP, on Postgres and the engine's
// jobs: the steps before the chosen one end with the original's outputs and call nothing, the
// chosen step and those after it run on the Workflow's revision now. Acceptance checks 157 and
// 158 of the Events, Workflows And Guardrails spec.

const WORKFLOW = "notify-clients";
const address = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };
const rerunRunSchema = runSchema.extend({
  mode: z.string(),
  rerunOf: z
    .object({ runId: z.string(), fromStep: z.string(), reusedSteps: z.array(z.string()) })
    .optional()
});
const rerunStepsSchema = z.object({
  items: z.array(
    z.object({
      step: z.string(),
      changed: z.boolean(),
      refusal: z.object({ code: z.string(), step: z.string().optional() }).optional()
    })
  )
});

/** The Connection's `write` fails for good; its `echo` answers the three clients. */
const failingWrites = (operation: string, input: JsonValue) =>
  operation === "write"
    ? Promise.reject(connectionCallError("output_invalid"))
    : Promise.resolve<JsonValue>(operation === "echo" ? { clients: CLIENTS } : { received: input });
const answering = (operation: string, input: JsonValue) =>
  Promise.resolve<JsonValue>(operation === "echo" ? { clients: CLIENTS } : { received: input });

describe("a re-run from a chosen step", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  /** `notify-clients` saved and published; Kai may use, read and write it. */
  async function ready() {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
    await t.allow({ kind: "user", id: t.kai.id }, "connection.use");
    for (const action of ["workflow.use", "workflow.read", "workflow.write"]) {
      await t.allow({ kind: "user", id: t.kai.id }, action);
    }
    await save(t, notifyClients(), null);
    await t.expectOk(t.root.id, "assets.publish", { params: address, payload: { revision: 1 } });
    return t;
  }

  async function save(t: WorkflowFixture, manifest: unknown, expectedRevision: number | null) {
    const response = await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: { config: { name: WORKFLOW, manifest }, expectedRevision }
    });
    return z.object({ revision: z.number() }).parse(response.json()).revision;
  }

  /** Runs `operation` as Kai to its end; answers the run and the calls it made. */
  async function ran(t: WorkflowFixture, start: () => Promise<{ json(): unknown }>) {
    const before = t.executed.length;
    const started = rerunRunSchema.parse((await start()).json());
    const ended = await t.finish(started.id);
    return {
      run: { ...started, status: ended.status, definitionRevisionId: ended.definitionRevisionId },
      calls: t.executed.slice(before).map((call) => call.operation)
    };
  }

  const startLive = (t: WorkflowFixture) =>
    ran(t, () =>
      t.expectOk(t.kai.id, "workflows.start", {
        params: { workflow: WORKFLOW },
        payload: { input: { note: NOTE } }
      })
    );

  const rerun = (t: WorkflowFixture, runId: string, fromStep: string, userId = t.kai.id) =>
    t.call(userId, "workflows.rerun", { params: { runId }, payload: { fromStep } });

  const rerunSteps = async (t: WorkflowFixture, runId: string) =>
    rerunStepsSchema.parse(
      (await t.expectOk(t.kai.id, "workflows.rerun_steps", { params: { runId } })).json()
    ).items;

  // Acceptance check 157.
  it("reuses the outputs before the chosen step, runs the rest, and links the original", async () => {
    const t = await ready();
    t.setBehaviour(failingWrites);
    const failed = await startLive(t);
    expect(failed.run.status).toBe("failed");
    expect(failed.calls[0]).toBe("echo");

    // The run failed in the loop: it is re-run from the loop, and not from the step after it.
    expect(await rerunSteps(t, failed.run.id)).toEqual([
      { step: "start", changed: false, refusal: { code: "rerun_step_not_offered" } },
      { step: "clients", changed: false },
      { step: "each_client", changed: false },
      {
        step: "result",
        changed: false,
        refusal: { code: "rerun_output_gone", step: "each_client" }
      }
    ]);

    t.setBehaviour(answering);
    const again = await ran(t, () =>
      t.expectOk(t.kai.id, "workflows.rerun", {
        params: { runId: failed.run.id },
        payload: { fromStep: "each_client" }
      })
    );
    expect(again.run.status).toBe("done");
    expect(again.run.mode).toBe("live");
    expect(again.run.rerunOf).toEqual({
      runId: failed.run.id,
      fromStep: "each_client",
      reusedSteps: ["clients"]
    });
    // The clients were not read again: only the loop's writes were made.
    expect(again.calls).toEqual(CLIENTS.map(() => "write"));
    const steps = await stepRunsOf(t, again.run.id);
    const clients = steps.find((step) => step.stepId === "clients");
    expect(clients?.status).toBe("done");
    expect(JSON.parse(clients?.outputPreview?.text ?? "null")).toEqual({ clients: CLIENTS });

    // A done run re-run from its last step reuses the loop as a whole: nothing is called.
    const last = await ran(t, () =>
      t.expectOk(t.kai.id, "workflows.rerun", {
        params: { runId: again.run.id },
        payload: { fromStep: "result" }
      })
    );
    expect(last.run.status).toBe("done");
    expect(last.calls).toEqual([]);
    expect(last.run.rerunOf?.reusedSteps).toEqual(["clients", "each_client"]);
    expect(
      (await stepRunsOf(t, last.run.id)).filter((step) => step.stepId === "send")
    ).toHaveLength(0);
    const read = await t.expectOk(t.kai.id, "workflows.get_run", {
      params: { runId: last.run.id }
    });
    expect(JSON.parse(rerunRunSchema.parse(read.json()).outputPreview?.text ?? "null")).toEqual({
      sent: CLIENTS.length,
      failed: 0
    });
  });

  it("runs on the published revision now, and refuses to reuse a step that changed", async () => {
    const t = await ready();
    const first = await startLive(t);
    expect(first.run.status).toBe("done");

    const changed = notifyClients();
    Object.assign(changed.steps[1] ?? {}, { input: { text: { value: NOTE } } });
    await save(t, changed, 1);
    await t.expectOk(t.root.id, "assets.publish", { params: address, payload: { revision: 2 } });

    // Acceptance check 158.
    const steps = await rerunSteps(t, first.run.id);
    expect(steps.map(({ step, changed: stepChanged }) => [step, stepChanged])).toEqual([
      ["start", false],
      ["clients", true],
      ["each_client", false],
      ["result", false]
    ]);
    expect(steps[2]?.refusal).toEqual({ code: "rerun_step_changed", step: "clients" });
    const refused = await rerun(t, first.run.id, "each_client");
    expect(refused.statusCode).toBe(409);
    expect(errorSchema.parse(refused.json()).error.details).toMatchObject({
      reason: "rerun_step_changed",
      step: "clients"
    });

    // From the changed step itself the run starts again on the new revision.
    const again = await ran(t, () => rerun(t, first.run.id, "clients"));
    expect(again.run.status).toBe("done");
    expect(again.run.definitionRevisionId).not.toBe(first.run.definitionRevisionId);
    expect(again.calls[0]).toBe("echo");
  });

  it("re-runs a test run as a test run of the draft", async () => {
    const t = await ready();
    const tested = await ran(t, () =>
      t.expectOk(t.kai.id, "workflows.test", {
        params: { workflow: WORKFLOW },
        payload: { input: { note: NOTE } }
      })
    );
    expect(tested.run.status).toBe("done");
    const again = await ran(t, () => rerun(t, tested.run.id, "result"));
    expect(again.run.mode).toBe("test");
    expect(again.run.status).toBe("done");
    expect(again.run.rerunOf?.reusedSteps).toEqual(["clients", "each_client"]);
    expect(again.calls).toEqual([]);
  });

  it("asks what a start asks, and the right to read the run", async () => {
    const t = await ready();
    const first = await startLive(t);

    // Lena may read the Workflow but not start it.
    await t.allow({ kind: "user", id: t.lena.id }, "workflow.read");
    expect((await rerun(t, first.run.id, "clients", t.lena.id)).statusCode).toBe(403);
    expect((await rerun(t, "wfr_missing", "clients")).statusCode).toBe(404);
    const unknown = await rerun(t, first.run.id, "send");
    expect(unknown.statusCode).toBe(422);
    expect(errorSchema.parse(unknown.json()).error.details).toMatchObject({
      reason: "rerun_step_not_offered"
    });
    const trigger = await rerun(t, first.run.id, "start");
    expect(errorSchema.parse(trigger.json()).error.details).toMatchObject({
      reason: "rerun_step_not_offered"
    });
  });

  it("refuses a re-run from a marked personal conversation at authorization and execution", async () => {
    const t = await ready();
    const first = await startLive(t);
    const created = await t.expectOk(t.kai.id, "conversations.create", {
      payload: { title: "Private Workflow input" }
    });
    const conversationId = asConversationId(z.object({ id: z.string() }).parse(created.json()).id);
    const binding = await t.operationCalls.registry.resolve("workflows.rerun");
    if (!binding) throw new Error("The re-run operation is missing");
    const actor = identityOf(t.kai);
    const context: OperationExecutionContext = {
      actor,
      origin: {
        kind: "agent",
        agentName: "builder",
        agentRunId: asAgentRunId("run"),
        conversationId,
        toolCallId: asToolCallId("rerun"),
        toolName: "workflows.rerun"
      },
      runId: createPlatformId<"OperationRunId">("oprun"),
      correlationId: "rerun-check",
      runtime: {},
      access: await t.operationCalls.deps.authorizer.forActor(actor),
      audit: t.operationCalls.deps.audit
    };
    const input = { runId: first.run.id, fromStep: "result" };
    await t.stores.conversations.markPersonalData({
      clientInstanceId,
      conversationId,
      userId: t.kai.id,
      at: "2026-10-30T10:00:00.000Z"
    });
    for (const invoke of [
      () => binding.authorize?.(input, { ...context, resource: binding.resource?.(input) }),
      () => binding.execute(input, context)
    ]) {
      await expect(invoke()).rejects.toMatchObject({
        details: { reason: "personal_data_conversation" }
      });
    }
  });
});
