import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_ASSET_KIND,
  createPlatformId,
  type OperationExecutionContext,
  asAgentRunId,
  asConversationId,
  asToolCallId,
  type UserRecord
} from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { identityOf, operationOf } from "./support/connection-operations";
import { fileTestDatabaseUrl } from "./support/test-database";
import { withTestSql } from "./support/test-sql";
import { runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { NOTE, notifyClients, readyWorkflows, stepRunsOf } from "./support/workflow-runs";

// The test run of a Workflow draft (EW-5t, ADR-0031) over HTTP, on Postgres and the engine's
// jobs: `workflows.test` runs the saved draft as the person who starts it, bounded by the
// Workflow's service principal. A reading step reads live, a changing step is simulated and
// says what it would have done, and "Run live once" makes one step live for the next test run.
// Acceptance checks 6, 7 and 7a of the Events, Workflows And Guardrails spec.

const WORKFLOW = "notify-clients";
const address = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };
const writeSchema = z.object({ revision: z.number() });
const liveOnceListSchema = z.object({
  items: z.array(
    z.object({
      part: z.string(),
      switchedAt: z.string(),
      usedByRunId: z.string().optional(),
      usedAt: z.string().optional()
    })
  )
});
const testRunSchema = runSchema.extend({ mode: z.string() });
const operationRunSchema = z
  .object({
    id: z.string(),
    target: z.string(),
    actor: z.object({ kind: z.string(), id: z.string() }).loose(),
    origin: z.object({ kind: z.string() }).loose(),
    decision: z.object({ mode: z.string(), by: z.string() }).loose().optional()
  })
  .loose();

/** `notify-clients` with a last step that writes to the Connection `billing`. */
function billingDraft() {
  const manifest = notifyClients();
  const [start, clients, loop, result] = manifest.steps;
  return {
    ...manifest,
    steps: [
      start,
      clients,
      loop,
      {
        id: "bill",
        name: "Bill the run",
        type: "operation",
        operation: "connection.billing.write",
        input: { note: { ref: { step: "start", path: "input.note" } } }
      },
      result
    ]
  };
}

describe("a test run of a Workflow draft", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  /**
   * The draft of `notify-clients`, saved by the administrator and never published, and Kai,
   * who tests it: he holds `workflow.write` and `connection.use`, as the principal does, and
   * not `api_access.manage`.
   */
  async function ready(manifest: unknown = notifyClients()) {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
    await t.allow({ kind: "user", id: t.kai.id }, "connection.use");
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.write");
    await save(t, manifest, null);
    return t;
  }

  async function save(t: WorkflowFixture, manifest: unknown, expectedRevision: number | null) {
    const response = await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: { config: { name: WORKFLOW, manifest }, expectedRevision }
    });
    return writeSchema.parse(response.json()).revision;
  }

  const startTest = (t: WorkflowFixture, tester: UserRecord = t.kai) =>
    t.call(tester.id, "workflows.test", {
      params: { workflow: WORKFLOW },
      payload: { input: { note: NOTE } }
    });

  /** Starts a test run as the tester and runs it to its end. */
  async function testRun(t: WorkflowFixture, tester: UserRecord = t.kai) {
    const response = await startTest(t, tester);
    expect(response.json()).not.toHaveProperty("error");
    const started = testRunSchema.parse(response.json());
    const ended = await t.finish(started.id);
    return { started, ended, steps: await stepRunsOf(t, started.id) };
  }

  it("continues on the same draft revision, with its labels, while a different revision is published", async () => {
    const draft = {
      kind: "data",
      ...notifyClients({ continueAsNew: { position: "offset", after: 1 } }),
      labels: { customer: { value: "Draft label" } },
      inputs: {
        type: "object",
        properties: { note: { type: "string" }, offset: { type: "integer" } },
        required: ["note"]
      }
    };
    const t = await ready(draft);
    const initial = testRunSchema.parse((await startTest(t)).json());
    // Publish a different draft while the test Lauf still owns its original definition.
    const revision = await save(
      t,
      {
        ...draft,
        description: "A newer published definition",
        labels: { customer: { value: "Published label" } }
      },
      1
    );
    await t.expectOk(t.root.id, "assets.publish", {
      params: address,
      payload: { revision }
    });
    const worker = t.worker();
    for (let pass = 0; pass < 40; pass++) {
      await worker.runDue();
      const chain = await t.stores.workflowRuns.listRuns({
        clientInstanceId,
        workflow: WORKFLOW,
        page: { limit: 20 }
      });
      if (chain.some((run) => run.status === "done" || run.status === "failed")) {
        expect(chain).toHaveLength(3);
        expect(
          chain.every(
            (run) =>
              run.definitionRevisionId === initial.definitionRevisionId && run.mode === "test"
          )
        ).toBe(true);
        expect(chain.every((run) => run.labels?.customer === "Draft label")).toBe(true);
        expect(chain.map((run) => run.status).sort()).toEqual(["continued", "continued", "done"]);
        return;
      }
    }
    throw new Error("The draft Lauf did not end");
  });

  async function operationRun(t: WorkflowFixture, runId: string | undefined) {
    if (runId === undefined) throw new Error("The step made no call");
    // A refused run carries its refusal under `error`, so its read is not checked for one.
    const response = await t.call(t.root.id, "operations.get_run", { params: { runId } });
    expect(response.statusCode).toBe(200);
    return operationRunSchema.parse(response.json());
  }

  const switchOn = (t: WorkflowFixture, expectedRevision: number, part = "send") =>
    t.expectOk(t.kai.id, "assets.run_live_once", {
      params: address,
      payload: { part, expectedRevision }
    });

  /** The real registered operation, from an agent working in Kai's subject conversation. */
  async function agentTest(t: WorkflowFixture) {
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.read");
    const conversation = await t.expectOk(t.kai.id, "conversations.create", {
      payload: { title: "Test this draft", subject: address }
    });
    const { id } = z.object({ id: z.string() }).parse(conversation.json());
    t.state.agentTools.set("builder", ["workflows.test"]);
    const outcome = await t.invoke(
      t.kai,
      "workflows.test",
      {
        workflow: WORKFLOW,
        input: { note: NOTE }
      },
      {
        effect: "changing",
        origin: {
          kind: "agent",
          agentName: "builder",
          agentRunId: asAgentRunId("agent-run"),
          conversationId: asConversationId(id),
          toolCallId: asToolCallId("test-call"),
          toolName: "workflows.test"
        }
      }
    );
    expect(outcome.result.status).toBe("done");
    if (outcome.result.status !== "done") throw new Error("The agent's test did not start");
    expect(outcome.run).toMatchObject({
      actor: { kind: "user", id: t.kai.id },
      origin: { kind: "agent", conversationId: id }
    });
    return testRunSchema.parse(outcome.result.output);
  }

  it("starts for the person from an agent without confirmation, and simulates changing steps under both sets of rights", async () => {
    const t = await ready();
    const started = await agentTest(t);
    expect(started).toMatchObject({ mode: "test", startedBy: { kind: "user", id: t.kai.id } });
    expect((await t.finish(started.id)).status).toBe("done");
    const steps = await stepRunsOf(t, started.id);
    const sends = steps.filter((step) => step.stepId === "send");
    expect(sends).toHaveLength(3);
    for (const send of sends) {
      expect(send).toMatchObject({ status: "done", target: "dry_run" });
      expect(send.outputPreview?.text).toContain('"wouldHaveDone"');
      expect(send.outputPreview?.text).toContain(NOTE);
      expect(await operationRun(t, send.operationRunId)).toMatchObject({
        actor: { kind: "user", id: t.kai.id },
        origin: { kind: "workflow", boundBy: { id: t.principal.id } }
      });
    }
    expect(t.executed.map((call) => call.operation)).toEqual(["echo"]);
  });

  it("lends an agent's tester none of the principal's rights", async () => {
    const t = await ready();
    const grants = await t.stores.access.listGrants({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "connection.use"
    });
    expect(grants).not.toHaveLength(0);
    for (const grant of grants) {
      await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });
    }
    const started = await agentTest(t);
    expect((await t.finish(started.id)).status).toBe("failed");
    expect(await stepRunsOf(t, started.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "clients",
          status: "failed",
          error: expect.objectContaining({ code: "tester_missing_right" })
        })
      ])
    );
    expect(t.executed).toEqual([]);
  });

  it("does not treat an agent's start as the person's confirmation of a Run live once switch", async () => {
    const t = await ready();
    t.state.centralSettings = [];
    await switchOn(t, 1);
    const started = await agentTest(t);
    expect((await t.finish(started.id)).status).toBe("failed");
    expect(await stepRunsOf(t, started.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "send",
          status: "failed",
          error: expect.objectContaining({
            code: "POLICY_DENIED",
            message: expect.stringContaining("start the test run yourself from the Workflow canvas")
          })
        })
      ])
    );
    expect(t.executed.filter((call) => call.operation === "write")).toEqual([]);
  });

  it.each(["agent", "app"] as const)(
    "refuses published Workflow starts from a marked %s conversation at authorization and execution",
    async (kind) => {
      const t = await ready();
      await t.expectOk(t.root.id, "assets.publish", { params: address, payload: { revision: 1 } });
      await t.allow({ kind: "user", id: t.kai.id }, "workflow.use");
      const created = await t.expectOk(t.kai.id, "conversations.create", {
        payload: { title: "Private Workflow input" }
      });
      const conversationId = asConversationId(
        z.object({ id: z.string() }).parse(created.json()).id
      );
      const operation = `workflow.${WORKFLOW}.start`;
      const binding = await t.operationCalls.registry.resolve(operation);
      if (!binding || binding.action !== null) throw new Error("Workflow start check missing");
      const actor = identityOf(t.kai);
      const context: OperationExecutionContext = {
        actor,
        origin:
          kind === "agent"
            ? {
                kind: "agent",
                agentName: "builder",
                agentRunId: asAgentRunId("run"),
                conversationId,
                toolCallId: asToolCallId("start"),
                toolName: operation
              }
            : {
                kind: "app",
                appRevisionId: "published",
                actionName: "start",
                pageSessionId: "session",
                conversationId
              },
        runId: createPlatformId<"OperationRunId">("oprun"),
        correlationId: "start-check",
        runtime: {},
        access: await t.operationCalls.deps.authorizer.forActor(actor),
        audit: t.operationCalls.deps.audit
      };
      const authorize = () =>
        binding.authorize(
          { note: NOTE },
          { ...context, resource: binding.resource({ note: NOTE }) }
        );
      expect(await authorize()).toEqual({ allowed: true });
      await t.stores.conversations.markPersonalData({
        clientInstanceId,
        conversationId,
        userId: t.kai.id,
        at: "2026-10-23T10:00:00.000Z"
      });
      for (const invoke of [authorize, () => binding.execute({ note: NOTE }, context)]) {
        await expect(invoke()).rejects.toMatchObject({
          details: { reason: "personal_data_conversation" }
        });
      }
      const reads = vi.spyOn(t.stores.conversations, "getConversation");
      try {
        reads.mockResolvedValue(undefined);
        await expect(authorize()).rejects.toMatchObject({
          details: { reason: "personal_data_conversation" }
        });
        reads.mockRejectedValue(new Error("unreadable root"));
        await expect(binding.execute({ note: NOTE }, context)).rejects.toMatchObject({
          details: { reason: "personal_data_conversation" }
        });
      } finally {
        reads.mockRestore();
      }
      expect(
        await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: WORKFLOW })
      ).toEqual([]);
    }
  );

  it("keeps an agent preview's Workflow test target from consuming Run live once", async () => {
    const t = await ready();
    await t.expectOk(t.root.id, "assets.publish", { params: address, payload: { revision: 1 } });
    await switchOn(t, 1);
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.use");
    const created = await t.expectOk(t.kai.id, "conversations.create", {
      payload: { title: "Preview test target" }
    });
    const conversationId = asConversationId(z.object({ id: z.string() }).parse(created.json()).id);
    const operation = `workflow.${WORKFLOW}.start`;
    t.state.centralSettings.push({ operation, value: "allow" });
    t.state.agentTools.set("builder", [operation]);
    const outcome = await t.invoke(
      t.kai,
      operation,
      { note: NOTE },
      {
        effect: "changing",
        origin: {
          kind: "agent",
          agentName: "builder",
          agentRunId: asAgentRunId("preview-run"),
          conversationId,
          toolCallId: asToolCallId("preview-test-target"),
          toolName: operation
        },
        draft: {
          kind: "agent_preview",
          asset: { kind: "agent", id: "preview-agent", name: "builder" },
          revisionId: "draft:1",
          part: conversationId
        }
      }
    );
    expect(outcome.run.target).toBe("test");
    expect(outcome.result.status, JSON.stringify(outcome.result)).toBe("done");
    if (outcome.result.status !== "done") throw new Error("Preview test target did not start");
    const { id } = z.object({ id: z.string() }).parse(outcome.result.output);
    expect((await t.finish(id)).status).toBe("done");
    expect(
      (await stepRunsOf(t, id)).filter((step) => step.stepId === "send").map((step) => step.target)
    ).toEqual(["dry_run", "dry_run", "dry_run"]);
    expect(t.executed.map((call) => call.operation)).toEqual(["echo"]);
  });

  // Acceptance check 6.
  it("reads live, simulates the changing step and marks each step with its target", async () => {
    const t = await ready();
    const { started, ended, steps } = await testRun(t);

    const draft = await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address });
    expect(started).toMatchObject({
      mode: "test",
      workflow: WORKFLOW,
      definitionRevisionId: draft?.activeRevisionId,
      startedBy: { kind: "user", id: t.kai.id },
      principal: { id: t.principal.id }
    });
    expect(ended.status).toBe("done");
    // The read reached the Connection; no write did.
    expect(t.executed.map((call) => call.operation)).toEqual(["echo"]);

    const clients = steps.find((step) => step.stepId === "clients");
    expect(clients).toMatchObject({ status: "done", effect: "reading", target: "live" });
    const sends = steps.filter((step) => step.stepId === "send");
    expect(sends).toHaveLength(3);
    for (const send of sends) {
      expect(send).toMatchObject({ status: "done", effect: "changing", target: "dry_run" });
      expect(send.outputPreview?.text).toContain('"wouldHaveDone"');
      expect(send.outputPreview?.text).toContain(NOTE);
    }

    // Every call is the tester's, bounded by the principal, which the origin names.
    const read = await operationRun(t, clients?.operationRunId);
    expect(read).toMatchObject({
      target: "live",
      actor: { kind: "user", id: t.kai.id },
      origin: { kind: "workflow", boundBy: { id: t.principal.id } }
    });
    expect((await operationRun(t, sends[0]?.operationRunId)).target).toBe("dry_run");

    // The test run lent nothing: the Workflow is still not published.
    const refused = await t.call(t.root.id, "workflows.start", {
      params: { workflow: WORKFLOW },
      payload: { input: { note: NOTE } }
    });
    expect(refused.statusCode).toBe(404);
  });

  // Acceptance check 7.
  it("runs a switched step live for one test run under the policy, audited, then simulates again", async () => {
    const t = await ready();
    // The instance default `confirm`: Kai's own start of the test run is his confirmation.
    t.state.centralSettings = [];
    await switchOn(t, 1);

    const live = await testRun(t);
    expect(live.ended.status).toBe("done");
    const sends = live.steps.filter((step) => step.stepId === "send");
    // The switch covers the step for the whole run: each item of the loop wrote.
    expect(sends.map((step) => step.target)).toEqual(["live", "live", "live"]);
    expect(t.executed.filter((call) => call.operation === "write")).toHaveLength(3);
    const first = await operationRun(t, sends[0]?.operationRunId);
    expect(first).toMatchObject({
      target: "live",
      actor: { kind: "user", id: t.kai.id },
      decision: { mode: "direct", by: t.kai.id }
    });
    const audit = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 });
    // The switch is used once, by the run, and both rows name its owner.
    expect(
      audit
        .filter((event) => event.type.startsWith("live_once."))
        .map((event) => [event.type, event.metadata?.part, event.metadata?.switchedBy])
        .reverse()
    ).toEqual([
      ["live_once.switched_on", "send", t.kai.id],
      ["live_once.used", "send", t.kai.id]
    ]);
    // The tester's start satisfied `confirm`, and so does the publish of a published run: it
    // asks nobody here either.
    expect(sends.map((step) => step.publishedWouldAsk)).toEqual([undefined, undefined, undefined]);
    expect(live.steps.find((step) => step.stepId === "clients")?.publishedWouldAsk).toBeUndefined();

    // The next test run simulates the step again.
    t.executed.length = 0;
    const again = await testRun(t);
    expect(again.steps.filter((step) => step.stepId === "send").map((step) => step.target)).toEqual(
      ["dry_run", "dry_run", "dry_run"]
    );
    expect(t.executed.map((call) => call.operation)).toEqual(["echo"]);
  });

  it("says nothing of an approval where a published run would not ask one", async () => {
    const t = await ready();
    // `readyWorkflows` lets the write run without asking, as a published run would too.
    const { steps } = await testRun(t);
    const sends = steps.filter((step) => step.stepId === "send");
    expect(sends.map((step) => step.publishedWouldAsk)).toEqual([undefined, undefined, undefined]);
  });

  it("keeps a switch its owner's, and says which of their test runs used it", async () => {
    const t = await ready();
    await t.allow({ kind: "user", id: t.lena.id }, "connection.use");
    await t.allow({ kind: "user", id: t.lena.id }, "workflow.write");
    await switchOn(t, 1);
    const listed = async (user: UserRecord) =>
      liveOnceListSchema.parse(
        (await t.expectOk(user.id, "assets.list_live_once", { params: address })).json()
      ).items;
    expect(await listed(t.kai)).toEqual([{ part: "send", switchedAt: expect.any(String) }]);
    // Lena sees none of Kai's switches, and her test run is simulated.
    expect(await listed(t.lena)).toEqual([]);
    const lenas = await testRun(t, t.lena);
    expect(lenas.steps.filter((step) => step.stepId === "send").map((step) => step.target)).toEqual(
      ["dry_run", "dry_run", "dry_run"]
    );
    expect(await listed(t.kai)).toEqual([{ part: "send", switchedAt: expect.any(String) }]);

    // Kai's own test run uses it, and the read says so after any reload.
    const kais = await testRun(t);
    expect(kais.steps.filter((step) => step.stepId === "send").map((step) => step.target)).toEqual([
      "live",
      "live",
      "live"
    ]);
    expect(await listed(t.kai)).toEqual([
      {
        part: "send",
        switchedAt: expect.any(String),
        usedByRunId: kais.started.id,
        usedAt: expect.any(String)
      }
    ]);
    // Set again, it is a new switch for the next run, beside the run that used the last one.
    await switchOn(t, 1);
    expect(await listed(t.kai)).toEqual([
      { part: "send", switchedAt: expect.any(String) },
      {
        part: "send",
        switchedAt: expect.any(String),
        usedByRunId: kais.started.id,
        usedAt: expect.any(String)
      }
    ]);
  });

  it("removes a run's bindings of its switches with the run", async () => {
    const t = await ready();
    await switchOn(t, 1);
    const { started } = await testRun(t);
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice: () => undefined });
    try {
      const bindings = async () =>
        (
          await sql<{ count: number }[]>`
            select count(*)::int as count from live_once_runs where workflow_run_id = ${started.id}`
        )[0]?.count;
      expect(await bindings()).toBe(1);
      await sql`delete from workflow_runs where id = ${started.id}`;
      expect(await bindings()).toBe(0);
    } finally {
      await sql.end();
    }
  });

  // A step of a test run carries its draft, so the publish of the Workflow confirms none of its
  // calls: only the tester's own start does.
  it("runs no switched 'confirm' step live where the tester's start was not their own confirmation", async () => {
    const t = await ready();
    // The instance default `confirm`, which a published run's publish would satisfy.
    t.state.centralSettings = [];
    await switchOn(t, 1);
    const started = testRunSchema.parse((await startTest(t)).json());
    // An agent's start for the tester: no call of `workflows.test` that was theirs.
    await withTestSql(
      (sql) => sql`update workflow_runs set operation_run_id = null where id = ${started.id}`
    );

    const ended = await t.finish(started.id);
    expect(ended.status).toBe("failed");
    const send = (await stepRunsOf(t, started.id)).find((step) => step.stepId === "send");
    expect(send).toMatchObject({ status: "failed", error: { code: "POLICY_DENIED" } });
    expect(t.executed.filter((call) => call.operation === "write")).toEqual([]);
  });

  it("gates a switched step on an approval the policy asks for", async () => {
    const t = await ready();
    t.state.centralSettings = [{ operation: "connection.crm.write", value: "approval" }];
    await switchOn(t, 1);

    const { ended, steps } = await testRun(t);
    expect(ended.status).toBe("failed");
    const send = steps.find((step) => step.stepId === "send");
    expect(send).toMatchObject({ status: "failed", error: { code: "POLICY_DENIED" } });
    expect(send?.error?.message).toContain("approval");
    expect(t.executed.filter((call) => call.operation === "write")).toEqual([]);
  });

  it("clears a switch nobody used once the draft is saved again", async () => {
    const t = await ready();
    await switchOn(t, 1);
    await save(t, { ...notifyClients(), name: "Notify again" }, 1);

    const { steps } = await testRun(t);
    expect(steps.filter((step) => step.stepId === "send").map((step) => step.target)).toEqual([
      "dry_run",
      "dry_run",
      "dry_run"
    ]);
    expect(t.executed.filter((call) => call.operation === "write")).toEqual([]);
  });

  // Acceptance check 7a, the principal's side.
  it("refuses a step the principal may not call, naming the principal, for a tester who may", async () => {
    const t = await ready(billingDraft());
    const billing = await t.seed("billing", {
      operations: [operationOf("write", { effect: "changing", exposure: ["workflow"] })]
    });
    // Kai holds `connection.use` on every Connection; the principal is denied it on billing.
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: t.principal.id,
      action: "connection.use",
      effect: "deny",
      scopeKind: "asset",
      scopeId: billing,
      grantedBy: t.admin.id
    });

    const { ended, steps } = await testRun(t);
    expect(ended.status).toBe("failed");
    expect(steps.find((step) => step.stepId === "clients")).toMatchObject({
      status: "done",
      target: "live"
    });
    const bill = steps.find((step) => step.stepId === "bill");
    expect(bill).toMatchObject({
      status: "failed",
      error: { code: "FORBIDDEN", action: "connection.use" }
    });
    expect(bill?.error?.message).toBe(
      `The principal 'workflow-runner' does not hold the right 'connection.use' on 'billing' to call 'connection.billing.write'; publishing would fail at this step`
    );
    expect(await operationRun(t, bill?.operationRunId)).toMatchObject({
      actor: { kind: "user", id: t.kai.id }
    });
  });

  // Acceptance check 7a, the tester's side.
  it("refuses a tester the reading step's right although the principal holds it", async () => {
    const t = await ready();
    // Lena may write the Workflow and may not use the Connection.
    await t.allow({ kind: "user", id: t.lena.id }, "workflow.write");

    const { ended, steps } = await testRun(t, t.lena);
    expect(ended.status).toBe("failed");
    const clients = steps.find((step) => step.stepId === "clients");
    expect(clients).toMatchObject({
      status: "failed",
      error: { code: "tester_missing_right", action: "connection.use" }
    });
    expect(clients?.error?.message).toMatch(
      /^You do not hold the right 'connection\.use' on 'crm'/u
    );
    expect(t.executed).toEqual([]);
  });

  it("is started by a holder of workflow.write only, and never as a disabled principal", async () => {
    const t = await ready();
    const refused = await startTest(t, t.lena);
    expect(refused.statusCode).toBe(403);
    expect(errorSchema.parse(refused.json()).error.details).toMatchObject({
      action: "workflow.write"
    });

    await t.stores.apiAccess.updateServicePrincipal({
      clientInstanceId,
      servicePrincipalId: t.principal.id,
      status: "disabled"
    });
    const disabled = await startTest(t);
    expect(disabled.statusCode).toBe(422);
    expect(errorSchema.parse(disabled.json()).error.details).toMatchObject({
      reason: "run_as_disabled"
    });
  });
});
