import { describe, expect, it } from "vitest";
import {
  DATA_STORE_ACTIONS,
  asUserId,
  callerCanConfirm,
  createPlatformId,
  dataStoreOperationName,
  resolvePolicy,
  type DataStoreOperationVerb,
  type OperationOrigin,
  type PolicyValue,
  type WorkflowRunPrincipal
} from "@vivd-catalyst/core";
import { runOperation } from "@vivd-catalyst/tool-execution";
import { required } from "./support/assertions";
import { clientInstanceId, finding, useDataStoreInstance } from "./support/data-store-instance";

// A step of a Workflow Run on a Data Store, through the call path of an assembled instance:
// whose rights decide, what the instance's policy asks of a call nobody is there to confirm,
// and what a step run that is tried again is answered.

const INSERT = dataStoreOperationName("findings", "insert");

describe("a step of a Workflow Run on a Data Store", () => {
  const { start, publishStore, person } = useDataStoreInstance();

  /** An instance with the published store and the service principal a Workflow names. */
  async function monthlyCheck(changing?: PolicyValue) {
    const instance = await start(true, changing);
    // Whoever starts the run and publishes the Workflow holds every right; no call is theirs.
    const admin = await person(instance, "user-1", ["user", "admin", "superadmin"]);
    const record = await publishStore(instance);
    const principal = await instance.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      name: "monthly-check",
      displayLabel: "Monthly check",
      createdByUserId: asUserId(admin.id)
    });
    const workflowRunId = createPlatformId<"WorkflowRunId">("wfrun");
    const actor: WorkflowRunPrincipal = {
      kind: "service",
      id: principal.id,
      displayLabel: principal.displayLabel,
      permissionRefs: principal.permissionRefs,
      permissions: principal.permissions,
      clientInstanceId,
      authSource: "workflow",
      scopes: [],
      workflowRunId
    };
    const grant = (action: string) =>
      instance.stores.access.createGrant({
        clientInstanceId,
        holderKind: "service_principal",
        holderId: principal.id,
        action,
        effect: "allow",
        scopeKind: "asset",
        scopeId: record.id,
        grantedBy: asUserId(admin.id)
      });
    const step = async (verb: DataStoreOperationVerb, input: unknown, stepRunId: string) => {
      const outcome = await runOperation(
        {
          operation: dataStoreOperationName("findings", verb),
          effect: verb === "insert" || verb === "load" ? "changing" : "reading",
          input,
          actor,
          origin: { kind: "workflow", workflowRunId, stepRunId },
          correlationId: "corr_monthly_check",
          // The key of a step's changing call is the id of its step run.
          idempotencyKey: stepRunId
        },
        instance.execution.operationCalls.deps
      );
      return {
        ...outcome,
        answer: outcome.result.status === "denied" ? outcome.result.reason : outcome.result.status
      };
    };
    return { instance, admin, record, principal, workflowRunId, grant, step };
  }

  const denied = (action: string) => ({ kind: "forbidden", action, reason: "no_grant" });
  const insert = { table: "findings", rows: [finding], onConflict: "fail" };
  const count = { sql: "select count(*)::integer as count from findings" };
  const dataset = { $dataset: "ds_findings", rowCount: 1, bytes: 100 };

  it("runs as the run's service principal, by that principal's grants and no one else's", async () => {
    const { principal, workflowRunId, grant, step } = await monthlyCheck("allow");

    expect((await step("query", count, "step_1")).answer).toEqual(denied(DATA_STORE_ACTIONS.read));
    expect((await step("insert", insert, "step_2")).answer).toEqual(
      denied(DATA_STORE_ACTIONS.insert)
    );

    await grant(DATA_STORE_ACTIONS.insert);
    const added = await step("insert", insert, "step_3");
    expect(added).toMatchObject({
      answer: "done",
      replayed: false,
      run: {
        effect: "changing",
        actor: { kind: "service_principal", id: principal.id },
        origin: { kind: "workflow", workflowRunId, stepRunId: "step_3" }
      }
    });
    // The step run that is tried again is answered what it was answered, and adds nothing.
    expect(await step("insert", insert, "step_3")).toMatchObject({
      answer: "done",
      replayed: true
    });
    // Adding rows does not read them.
    expect((await step("query", count, "step_4")).answer).toEqual(denied(DATA_STORE_ACTIONS.read));

    await grant(DATA_STORE_ACTIONS.read);
    const read = await step("query", count, "step_5");
    expect(read).toMatchObject({
      answer: "done",
      result: { output: { rows: [{ count: 1 }] } },
      run: { effect: "reading", actor: { kind: "service_principal", id: principal.id } }
    });

    // A load that changes or removes rows that are stored needs more than adding rows.
    for (const more of [
      { key: ["run_id"], onConflict: "update" },
      { key: ["run_id"], replace: { by: ["run_id"] } }
    ]) {
      expect(
        (
          await step(
            "load",
            { table: "findings", dataset, ...more },
            `step_load_${more.onConflict ?? "replace"}`
          )
        ).answer
      ).toEqual(denied(DATA_STORE_ACTIONS.execute));
    }
    // One that only adds is the principal's to make; no dataset of a run exists to read yet.
    expect(await step("load", { table: "findings", dataset }, "step_load")).toMatchObject({
      result: { status: "failed", error: { details: { reason: "not_supported_yet" } } }
    });
  });

  // `confirm` is the default of an instance. A run has nobody to ask, so its confirmation is
  // an approval, and a call of a service principal cannot be held for one.
  it.each([["confirm"], ["approval"]] as const)(
    "needs an approval under the instance's policy '%s', which nobody can give its call yet: it is refused and says so",
    async (changing) => {
      const { grant, step } = await monthlyCheck(changing === "confirm" ? undefined : changing);
      await grant(DATA_STORE_ACTIONS.insert);
      await grant(DATA_STORE_ACTIONS.read);

      expect((await step("insert", insert, "step_1")).answer).toEqual({
        kind: "policy",
        operation: INSERT,
        reason: "approval_unavailable"
      });
      expect(await step("query", count, "step_2")).toMatchObject({
        result: { output: { rows: [{ count: 0 }] } }
      });
    }
  );

  it("is refused under the instance's policy 'deny'", async () => {
    const { grant, step } = await monthlyCheck("deny");
    await grant(DATA_STORE_ACTIONS.insert);

    expect((await step("insert", insert, "step_1")).answer).toEqual({
      kind: "policy",
      operation: INSERT
    });
  });

  it("leaves the instance's policy to every other caller: deny refuses a person's insert and approval holds an agent's", async () => {
    const { instance, admin } = await monthlyCheck("deny");
    const own = await runOperation(
      {
        operation: INSERT,
        effect: "changing",
        input: insert,
        actor: admin,
        origin: { kind: "user" },
        correlationId: "corr_data_store"
      },
      instance.execution.operationCalls.deps
    );
    expect(own.result).toMatchObject({
      status: "denied",
      reason: { kind: "policy", operation: INSERT }
    });

    // What the policy asks of an agent's call of the same operation, as the call path asks it.
    const definition = required(await instance.execution.operationCalls.registry.resolve(INSERT));
    const agent: OperationOrigin = {
      kind: "agent",
      agentRunId: createPlatformId<"AgentRunId">("run"),
      conversationId: createPlatformId<"ConversationId">("conv"),
      agentName: "bookkeeper",
      toolCallId: createPlatformId<"ToolCallId">("call"),
      toolName: INSERT
    };
    const asked = (changing: PolicyValue) =>
      resolvePolicy({
        definition,
        origin: agent,
        instanceDefaults: { reading: "allow", changing },
        centralSettings: [],
        callerCanConfirm: callerCanConfirm(agent),
        canPause: false
      });
    expect(asked("approval")).toMatchObject({ value: "approval", next: "await_approval" });
    expect(asked("confirm")).toMatchObject({ next: "refuse", source: "surface_cannot_pause" });
    expect(asked("deny")).toMatchObject({ next: "refuse" });
    expect(asked("allow")).toMatchObject({ next: "run" });
  });

  it("runs a step run again under its key after a failure that changed nothing, and answers a kept one again", async () => {
    const { instance, record, grant, step } = await monthlyCheck("allow");
    await grant(DATA_STORE_ACTIONS.insert);
    await grant(DATA_STORE_ACTIONS.read);
    const limit = (bytes: number) =>
      instance.stores.dataStores.putDataStore({ ...record, sizeLimitBytes: bytes });

    await limit(1024);
    const full = await step("insert", insert, "step_1");
    expect(full).toMatchObject({
      replayed: false,
      result: { status: "failed", error: { code: "CONFLICT" } },
      run: { status: "failed", error: { code: "CONFLICT", unexecuted: true } }
    });

    // Its cause is gone: the same step run, tried again, adds its rows.
    await limit(record.sizeLimitBytes);
    expect(await step("insert", insert, "step_1")).toMatchObject({
      answer: "done",
      replayed: false,
      result: { output: { inserted: 1 } }
    });
    // What is kept is answered again and never added twice.
    expect(await step("insert", insert, "step_1")).toMatchObject({
      answer: "done",
      replayed: true
    });
    expect(await step("query", count, "step_2")).toMatchObject({
      result: { output: { rows: [{ count: 1 }] } }
    });
  });
});
