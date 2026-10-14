import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createPlatformId,
  WORKFLOW_ASSET_KIND,
  type AuthenticatedIdentity,
  type OperationDraftContext,
  type ServicePrincipalRecord,
  type UserRecord
} from "@vivd-catalyst/core";
import { runOperation } from "@vivd-catalyst/tool-execution";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { runIdentity, workflowOrigin } from "./support/principal-grants";
import type { WorkflowFixture } from "./support/workflow-instance";
import { NOTE, notifyClients, readyWorkflows } from "./support/workflow-runs";

// Calls made by a draft (ADR-0031), on the real call path and Postgres: where `runOperation()`
// sends a call that carries a draft context, what the Operation Run records of it, "Run live
// once" with its audit rows, idempotency by target, and the rights of a Workflow test run. The
// draft is the Workflow `notify-clients`; its step `send` calls `connection.crm.write` and its
// step `clients` reads `connection.crm.echo`. The test run itself is EW-5t's: here a step's
// call is made the way a test run will make it.

const WORKFLOW = "notify-clients";
const address = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };
const writeSchema = z.object({ revision: z.number() });
const runResourceSchema = z.object({ id: z.string(), target: z.string() }).loose();

const identityOf = (user: UserRecord): AuthenticatedIdentity => ({
  id: user.id,
  externalUserId: user.id,
  displayLabel: user.displayLabel,
  roles: user.roles,
  permissions: user.permissions,
  permissionRefs: user.permissionRefs,
  clientInstanceId,
  authSource: "test",
  scopes: ["*"]
});

interface DraftCall {
  operation?: "write" | "echo";
  tester?: UserRecord;
  key?: string;
  /** The principal that bounds the call, where it is not the Workflow's own. */
  principal?: ServicePrincipalRecord;
  /** A call of what is live, which carries no draft context. */
  live?: true;
}

describe("a call made by a draft", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  /**
   * The draft of `notify-clients`, written by the administrator, and Kai, who tests it: he
   * holds `workflow.write` and `connection.use`, as the principal of the Workflow does.
   */
  async function ready() {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
    await t.allow({ kind: "user", id: t.kai.id }, "connection.use");
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.write");
    await save(t, null);
    return t;
  }

  /** Saves the draft again. Answers its new revision. */
  async function save(t: WorkflowFixture, expectedRevision: number | null) {
    const manifest = notifyClients();
    const response = await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: {
        config: {
          name: WORKFLOW,
          manifest: expectedRevision === null ? manifest : { ...manifest, name: "Notify again" }
        },
        expectedRevision
      }
    });
    return writeSchema.parse(response.json()).revision;
  }

  /** The draft as it is stored now: its id and the revision a step of it calls from. */
  async function draftOf(t: WorkflowFixture, part: string): Promise<OperationDraftContext> {
    const asset = await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address });
    if (!asset) throw new Error("The draft was not written");
    return {
      asset: { kind: WORKFLOW_ASSET_KIND, id: asset.id, name: WORKFLOW },
      revisionId: asset.activeRevisionId,
      part
    };
  }

  /** A step of a test run calls the Connection, as the tester bounded by a principal. */
  async function stepCall(t: WorkflowFixture, call: DraftCall = {}) {
    const operation = call.operation ?? "write";
    const tester = call.tester ?? t.kai;
    t.executed.length = 0;
    const draft = await draftOf(t, operation === "write" ? "send" : "clients");
    return runOperation(
      {
        operation: `connection.crm.${operation}`,
        effect: operation === "write" ? "changing" : "reading",
        input: operation === "write" ? { client: "client-anna", note: NOTE } : { text: NOTE },
        actor: identityOf(tester),
        // Each call stands for a step of a test run of its own: a switch covers one run.
        origin: { ...workflowOrigin, workflowRunId: createPlatformId<"WorkflowRunId">("wfr") },
        correlationId: "corr_draft",
        ...(operation === "write" ? { idempotencyKey: call.key ?? crypto.randomUUID() } : {}),
        ...(call.live
          ? {}
          : { draft: { ...draft, boundBy: runIdentity(call.principal ?? t.principal) } })
      },
      t.operationCalls.deps
    );
  }

  const switchOn = (t: WorkflowFixture, expectedRevision: number, userId = t.kai.id) =>
    t.call(userId, "assets.run_live_once", {
      params: address,
      payload: { part: "send", expectedRevision }
    });

  /** The audit rows of "Run live once", oldest first, as type and the part they name. */
  async function switchRows(t: WorkflowFixture) {
    const events = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 });
    return events
      .filter((event) => event.type.startsWith("live_once."))
      .reverse()
      .map((event) => ({
        type: event.type,
        part: event.metadata?.part,
        revisionId: event.metadata?.revisionId,
        actor: event.actor?.principalId
      }));
  }

  // Fails without DT-1a: the call was made and wrote to the outside system.
  it("answers a changing call with what it would have done, changes nothing and records dry_run", async () => {
    const t = await ready();
    const { result, run } = await stepCall(t, { key: "send-anna" });

    expect(result).toEqual({
      status: "dry_run",
      runId: run.id,
      input: { client: "client-anna", note: NOTE }
    });
    expect(t.executed).toEqual([]);
    expect(run).toMatchObject({ target: "dry_run", status: "done", effect: "changing" });
    // A dry run keeps neither the input, an answer nor the key.
    expect(run.output).toBeUndefined();
    expect(run.idempotencyKey).toBeUndefined();
    const stored = await t.expectOk(t.root.id, "operations.get_run", {
      params: { runId: run.id }
    });
    expect(runResourceSchema.parse(stored.json()).target).toBe("dry_run");
    const audit = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 });
    expect(
      audit.filter((event) => event.metadata?.operationRunId === run.id).map(({ type }) => type)
    ).toContain("operation.simulated");
  });

  it("resolves the policy of a simulated call as for the live call", async () => {
    const t = await ready();
    // Without the setting, the instance default `confirm` of a step nobody attends is an
    // approval. The dry run says so and files no request.
    t.state.centralSettings = [];
    const asked = await stepCall(t);
    expect(asked.result).toMatchObject({ status: "dry_run", wouldAsk: "approval" });
    expect(asked.run.approvalRequestId).toBeUndefined();

    t.state.centralSettings = [{ operation: "connection.crm.write", value: "deny" }];
    const refused = await stepCall(t);
    expect(refused.result).toMatchObject({ status: "denied", reason: { kind: "policy" } });
    expect(refused.run.target).toBe("dry_run");
    expect(t.executed).toEqual([]);
  });

  it("reads live with the rights of the person testing", async () => {
    const t = await ready();
    const read = await stepCall(t, { operation: "echo" });
    expect(read.result).toMatchObject({ status: "done", output: { clients: expect.any(Array) } });
    expect(t.executed.map((call) => call.operation)).toEqual(["echo"]);
    expect(read.run).toMatchObject({ target: "live", actor: { kind: "user", id: t.kai.id } });

    // Lena may not use the Connection, and her test does not read it through the principal.
    const refused = await stepCall(t, { operation: "echo", tester: t.lena });
    expect(refused.result).toEqual({
      status: "denied",
      runId: refused.run.id,
      reason: {
        kind: "forbidden",
        action: "connection.use",
        reason: "no_grant",
        message: expect.stringContaining("does not hold the right")
      }
    });
    expect(t.executed).toEqual([]);
  });

  it("runs live once after a switch, then simulates again, and audits both", async () => {
    const t = await ready();
    expect((await switchOn(t, 1)).json()).toEqual({ draftRevision: 1, part: "send" });

    const live = await stepCall(t);
    expect(live.result).toMatchObject({ status: "done", output: { received: expect.anything() } });
    expect(live.run.target).toBe("live");
    expect(t.executed.map((call) => call.operation)).toEqual(["write"]);

    const after = await stepCall(t);
    expect(after.result.status).toBe("dry_run");
    expect(t.executed).toEqual([]);

    const { revisionId } = await draftOf(t, "send");
    expect(await switchRows(t)).toEqual([
      { type: "live_once.switched_on", part: "send", revisionId, actor: t.kai.id },
      { type: "live_once.used", part: "send", revisionId, actor: t.kai.id }
    ]);
  });

  it("clears an unused switch once the draft changes, and audits the clearing", async () => {
    const t = await ready();
    await switchOn(t, 1);
    const { revisionId: switched } = await draftOf(t, "send");
    const revision = await save(t, 1);

    // The switch was for the revision before: the call of the saved draft is simulated.
    const call = await stepCall(t);
    expect(call.result.status).toBe("dry_run");
    expect(t.executed).toEqual([]);
    expect(await switchRows(t)).toEqual([
      { type: "live_once.switched_on", part: "send", revisionId: switched, actor: t.kai.id },
      { type: "live_once.cleared", part: "send", revisionId: switched, actor: t.kai.id }
    ]);

    // A switch for a revision the caller has not seen is refused, and nobody without the
    // write right on the draft switches one.
    expect((await switchOn(t, 1)).statusCode).toBe(412);
    const refused = await switchOn(t, revision, t.lena.id);
    expect(refused.statusCode).toBe(403);
    expect(errorSchema.parse(refused.json()).error.details).toMatchObject({
      action: "workflow.write"
    });
  });

  // ADR-0031, acceptance check 27 of the Operations spec.
  it("keeps a dry run's key apart from the live call's", async () => {
    const t = await ready();
    const simulated = await stepCall(t, { key: "send-anna" });
    expect(simulated.result.status).toBe("dry_run");

    await switchOn(t, 1);
    const live = await stepCall(t, { key: "send-anna" });
    expect(live.run.id).not.toBe(simulated.run.id);
    expect(live.run).toMatchObject({ target: "live", idempotencyKey: "send-anna" });
    expect(t.executed.map((call) => call.operation)).toEqual(["write"]);

    // The same call again is answered from the live run, though the switch is used up.
    const again = await stepCall(t, { key: "send-anna" });
    expect(again).toMatchObject({ replayed: true, run: { id: live.run.id, target: "live" } });
    expect(t.executed).toEqual([]);
  });

  // A draft goes live only through "Run live once": a key a live call left free to run again
  // is no way around it.
  it("never carries a draft's call out live under the key of a live call", async () => {
    const t = await ready();
    // A live call under the key failed before it reached the outside system, so its run is
    // taken again by the next call under the key. The dry run before it has the same input.
    const simulated = await stepCall(t, { key: "send-anna" });
    const same = simulated.run;
    const started = await t.stores.operationRuns.create({
      id: createPlatformId<"OperationRunId">("oprun"),
      clientInstanceId,
      operation: same.operation,
      effect: same.effect,
      actor: same.actor,
      origin: same.origin,
      target: "live",
      idempotencyKey: "send-anna",
      inputHash: same.inputHash,
      correlationId: same.correlationId,
      startedAt: new Date().toISOString()
    });
    if (!started) throw new Error("The live run was not started");
    const failed = await t.stores.operationRuns.finish({
      clientInstanceId,
      id: started.id,
      end: {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: { code: "unavailable", message: "Not reached", unexecuted: true }
      }
    });
    expect(failed).toMatchObject({ target: "live", status: "failed" });

    const draft = await stepCall(t, { key: "send-anna" });
    expect(draft.result.status).toBe("dry_run");
    expect(draft.run.target).toBe("dry_run");
    expect(t.executed).toEqual([]);

    // A done live call under the key answers the draft's call again and is not made twice.
    const live = await stepCall(t, { key: "send-anna", live: true });
    expect(live.result.status).toBe("done");
    const again = await stepCall(t, { key: "send-anna" });
    expect(again).toMatchObject({ replayed: true, run: { id: live.run.id, target: "live" } });
    expect(t.executed).toEqual([]);
  });

  // A switch is the builder's: a call refused for a right it lacks leaves it for the next.
  it("keeps the switch when the call that would use it is refused for a right", async () => {
    const t = await ready();
    await switchOn(t, 1);

    // Lena may not use the Connection: her call is refused and does not use up the switch.
    const refused = await stepCall(t, { tester: t.lena });
    expect(refused.result).toMatchObject({ status: "denied", reason: { kind: "forbidden" } });
    // The principal that bounds the call lacks the right: the switch stays too.
    const bookkeeping = await t.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "Bookkeeping"
    });
    const bounded = await stepCall(t, { principal: bookkeeping });
    expect(bounded.result).toMatchObject({
      status: "denied",
      reason: { boundBy: { id: bookkeeping.id } }
    });
    expect(t.executed).toEqual([]);

    const live = await stepCall(t);
    expect(live.run.target).toBe("live");
    expect(t.executed.map((call) => call.operation)).toEqual(["write"]);
    expect((await switchRows(t)).map(({ type }) => type)).toEqual([
      "live_once.switched_on",
      "live_once.used"
    ]);
  });

  // The draft changed twice and is the earlier revision again: the switch is gone all the same.
  it("does not bring a switch back with a discarded draft", async () => {
    const t = await ready();
    await t.expectOk(t.root.id, "assets.publish", { params: address, payload: { revision: 1 } });
    await switchOn(t, 1);
    const { revisionId: switched } = await draftOf(t, "send");
    const revision = await save(t, 1);
    await t.expectOk(t.admin.id, "assets.discard_draft", {
      params: address,
      payload: { expectedRevision: revision }
    });
    expect((await draftOf(t, "send")).revisionId).toBe(switched);

    const call = await stepCall(t);
    expect(call.result.status).toBe("dry_run");
    expect(t.executed).toEqual([]);
    expect((await switchRows(t)).map(({ type }) => type)).toEqual([
      "live_once.switched_on",
      "live_once.cleared"
    ]);
  });

  // A dry run answers its input, and an input that holds a secret is not handed back.
  it("answers a simulated call whose input holds a secret without its input", async () => {
    const t = await ready();
    const draft = await draftOf(t, "send");
    const password = "a-new-password-for-kai";
    const { result, run } = await runOperation(
      {
        operation: "users.password.reset",
        effect: "changing",
        input: { userId: t.kai.id, password },
        actor: identityOf(t.root),
        origin: workflowOrigin,
        correlationId: "corr_draft",
        idempotencyKey: "reset-kai",
        draft
      },
      t.operationCalls.deps
    );
    expect(result).toEqual({ status: "dry_run", runId: run.id, wouldAsk: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(run)).not.toContain(password);
  });

  it("allows a call of a test run only where the tester and the principal both hold the right", async () => {
    const t = await ready();
    const bookkeeping = await t.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "Bookkeeping"
    });

    // The principal lacks the right: the refusal names it, and publishing would fail here.
    const bounded = await stepCall(t, { operation: "echo", principal: bookkeeping });
    expect(bounded.result).toEqual({
      status: "denied",
      runId: bounded.run.id,
      reason: {
        kind: "forbidden",
        action: "connection.use",
        reason: "no_grant",
        boundBy: { id: bookkeeping.id, label: "Bookkeeping" }
      }
    });
    expect(t.executed).toEqual([]);

    // Both hold it: the call is made as the tester, and its origin names the principal.
    const both = await stepCall(t, { operation: "echo" });
    expect(both.result.status).toBe("done");
    expect(both.run).toMatchObject({
      actor: { kind: "user", id: t.kai.id },
      origin: { kind: "workflow", boundBy: { id: t.principal.id, label: t.principal.displayLabel } }
    });
  });

  it("bounds only a person's call from a step of a Workflow", async () => {
    const t = await ready();
    const draft = await draftOf(t, "clients");
    const call = {
      operation: "connection.crm.echo",
      effect: "reading" as const,
      input: { text: NOTE },
      correlationId: "corr_draft",
      draft: { ...draft, boundBy: runIdentity(t.principal) }
    };
    await expect(
      runOperation(
        { ...call, actor: identityOf(t.kai), origin: { kind: "user" } },
        t.operationCalls.deps
      )
    ).rejects.toThrow(/Only a person's call from a Workflow test run is bounded/u);
    await expect(
      runOperation(
        {
          ...call,
          actor: runIdentity(t.principal),
          origin: workflowOrigin
        },
        t.operationCalls.deps
      )
    ).rejects.toThrow(/Only a person's call from a Workflow test run is bounded/u);
  });
});
