import { afterEach, describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asToolCallId,
  createPlatformId,
  type OperationCall,
  type UserRecord
} from "@work-shape/catalyst-core";
import { executeConfirmedOperation, runOperation } from "@work-shape/catalyst-tool-execution";
import { clientInstanceId } from "./support/access-instance";
import { required } from "./support/assertions";
import { agentOrigin, identityOf } from "./support/connection-operations";
import { guardedEvents, IBAN, ibanPattern } from "./support/guardrails";
import {
  basic,
  grantSystem,
  mailEvents,
  mailFlow,
  mailInputs,
  output,
  person,
  put,
  ref,
  run,
  save,
  testRun,
  trigger
} from "./support/mail-workflows";
import { withTestSql } from "./support/test-sql";
import { runSchema, workflowFixture, type WorkflowFixture } from "./support/workflow-instance";
import { stepRunsOf } from "./support/workflow-runs";

// MAIL-2, "Safe to switch on": Run live once mails the tester alone, `outbound.limits` hold
// across workers, the guardrails of `operation.before_call` read no address, an agent's mail
// waits for its person with the mail as it goes out, and a workspace is mailed only by who may
// see it. Events checks 135 to 138; the publish question's sentence (139) is in
// publish-narrative.test.ts and the card of check 138 in chat-ui-tool-decision-card.test.ts.

let fixture: WorkflowFixture | undefined;
afterEach(async () => {
  await fixture?.instance.close();
  fixture = undefined;
});

async function ready(options: Parameters<typeof workflowFixture>[0] = {}) {
  fixture = await workflowFixture({
    definitions: "assets",
    mail: { recipientDomains: ["kanzlei.de"] },
    ...options
  });
  return fixture;
}

async function withEmail(t: WorkflowFixture, user: UserRecord, email: string) {
  return t.stores.users.updateUser({ clientInstanceId, userId: user.id, email });
}

/** A person holds `mail_sender.use` on `system`, as the rights screen gives it. */
async function grantSystemTo(t: WorkflowFixture, user: UserRecord) {
  await t.expectOk(t.root.id, "permissions.grant", {
    payload: {
      holderKind: "user",
      holderId: user.id,
      action: "mail_sender.use",
      scopeKind: "asset",
      scopeId: "system"
    }
  });
}

const sentMail = () =>
  withTestSql(
    (sql) => sql<{ target: string; status: string }[]>`
      select target, status from operation_runs
      where client_instance_id = ${clientInstanceId} and operation = 'mail.send'
      order by created_at`
  );

describe("Run live once of a mail.send step (check 135)", () => {
  async function switchedOn() {
    const t = await ready();
    const pia = await person(t, "Pia Person", "pia@elsewhere.test");
    await withEmail(t, t.root, "root@kanzlei.de");
    await grantSystem(t);
    await save(
      t,
      mailFlow("monthly", {
        ...basic(ref("email")),
        cc: { value: [{ user: pia.id }] },
        replyTo: { value: "office@kanzlei.de" }
      })
    );
    await t.expectOk(t.root.id, "assets.run_live_once", {
      params: { kind: "workflow", name: "monthly" },
      payload: { part: "mail", expectedRevision: 1 }
    });
    return t;
  }

  it("sends one mail to the tester alone, marked [Test], with whom it would have reached in a box", async () => {
    const t = await switchedOn();
    const step = await testRun(t, "monthly", { email: "anna@kanzlei.de" });
    expect(step.status).toBe("done");
    const [mail, ...more] = t.capturedMail();
    expect(more).toEqual([]);
    expect(required(mail)).toMatchObject({
      recipients: { to: [{ email: "root@kanzlei.de", displayLabel: "Root" }], cc: [], bcc: [] },
      subject: "[Test] Monthly check"
    });
    expect(mail?.replyTo).toBeUndefined();
    expect(mail?.text).toContain(
      "Test send\nThis e-mail went to you alone. It would have gone to:"
    );
    expect(mail?.text).toContain("anna@kanzlei.de");
    expect(mail?.text).toContain("Pia Person");
    expect(mail?.html).toContain("Test send");
    expect(JSON.parse(required(step.outputPreview).text)).toMatchObject({ test: true });
    expect(await sentMail()).toEqual([{ target: "test", status: "done" }]);
    expect(await mailEvents()).toMatchObject([
      {
        type: "mail.sent",
        metadata: { target: "test", recipients: { to: 1, cc: 0, bcc: 0 }, domains: ["kanzlei.de"] }
      }
    ]);
    // The switch covers one test run: the next one simulates the mail again.
    const next = await testRun(t, "monthly", { email: "anna@kanzlei.de" });
    expect(next).toMatchObject({ status: "done", target: "dry_run" });
    expect(t.capturedMail()).toHaveLength(1);
  });

  it("fails the test step of an address outside the rule, as a live run would, and mails nobody", async () => {
    const t = await switchedOn();
    const step = await testRun(t, "monthly", { email: "otto@outside.test" });
    expect(step.error).toMatchObject({ code: "recipient_not_allowed" });
    expect(t.capturedMail()).toEqual([]);
    expect(await mailEvents()).toMatchObject([
      {
        type: "mail.refused",
        metadata: { target: "test", reason: "recipient_not_allowed", domain: "outside.test" }
      }
    ]);
  });
});

/** A loop over `input.people` that mails each item's `email`. */
function loopFlow(id: string, limits?: Record<string, unknown>) {
  return {
    id,
    name: `Flow ${id}`,
    runAs: "workflow-runner",
    inputs: mailInputs,
    outputs: { type: "object" },
    ...(limits ? { limits } : {}),
    steps: [
      trigger,
      {
        id: "each",
        name: "For each person",
        type: "loop",
        items: { step: "start", path: "input.people" },
        itemLabel: "email",
        concurrency: 5,
        steps: [
          {
            id: "mail",
            name: "Mail one",
            type: "operation",
            operation: "mail.send",
            input: basic({ ref: { step: "each", path: "email" } })
          }
        ]
      },
      output
    ]
  };
}

const people = [1, 2, 3, 4, 5].map((n) => ({ email: `p${n}@kanzlei.de` }));

describe("outbound.limits (check 136)", () => {
  async function looping(limits?: Record<string, unknown>) {
    const t = await ready({
      mail: {
        recipientDomains: ["kanzlei.de"],
        limits: { perWorkflowPerHour: 3, perInstancePerDay: 100 }
      }
    });
    await grantSystem(t);
    await save(t, loopFlow("loop", limits));
    const started = runSchema.parse(
      (
        await t.expectOk(t.root.id, "workflows.start", {
          params: { workflow: "loop" },
          payload: { input: { people } }
        })
      ).json()
    );
    // Two worker processes take the items' steps at once.
    const workers = [t.worker(), t.worker()];
    for (let pass = 0; pass < 30; pass++) await Promise.all(workers.map((w) => w.runDue()));
    return { t, runId: started.id, workers };
  }

  const queuedSteps = () =>
    withTestSql(
      (sql) => sql<{ runAfter: Date; inMs: number }[]>`
        select run_after as "runAfter",
          extract(epoch from (run_after - now())) * 1000 as "inMs"
        from platform_jobs
        where client_instance_id = ${clientInstanceId}
          and kind = 'workflow_run.execute_step' and status = 'queued'`
    );

  const roomNow = () =>
    withTestSql(async (sql) => {
      await sql`
        update operation_runs set admitted_at = admitted_at - interval '1 hour'
        where client_instance_id = ${clientInstanceId} and operation = 'mail.send'
          and admitted_at is not null`;
      await sql`
        update platform_jobs set run_after = now()
        where client_instance_id = ${clientInstanceId}
          and kind = 'workflow_run.execute_step' and status = 'queued'`;
    });

  it("sends three of five within the hour from two workers, and the other two once the window has room", async () => {
    const { t, runId, workers } = await looping();
    expect(t.capturedMail()).toHaveLength(3);
    const steps = (await stepRunsOf(t, runId)).filter((step) => step.stepId === "mail");
    expect(steps.filter((step) => step.status === "done")).toHaveLength(3);
    expect(steps.filter((step) => step.status === "failed")).toEqual([]);
    const waiting = await queuedSteps();
    expect(waiting).toHaveLength(2);
    // They wait for the window: an hour after the first mail, not a poll.
    for (const job of waiting) expect(Number(job.inMs)).toBeGreaterThan(55 * 60_000);
    expect((await mailEvents()).map((event) => event.type)).toEqual([
      "mail.sent",
      "mail.sent",
      "mail.sent"
    ]);

    await roomNow();
    expect(await t.finish(runId, required(workers[0]))).toMatchObject({ status: "done" });
    expect(
      t
        .capturedMail()
        .map((mail) => mail.recipients.to[0]?.email)
        .sort()
    ).toEqual(people.map((p) => p.email));
    expect((await mailEvents()).map((event) => event.type)).toEqual(
      Array.from({ length: 5 }, () => "mail.sent")
    );
  });

  it("ends a run whose deadline passes before the window has room, with the deadline", async () => {
    const { t, runId, workers } = await looping({ duration: "10m" });
    expect(t.capturedMail()).toHaveLength(3);
    const [deadline] = await withTestSql(
      (sql) => sql<{ deadlineAt: Date }[]>`
        select deadline_at as "deadlineAt" from workflow_runs where id = ${runId}`
    );
    // The wait ends at the deadline at the latest, not when the window has room.
    for (const job of await queuedSteps())
      expect(job.runAfter.getTime()).toBeLessThanOrEqual(required(deadline).deadlineAt.getTime());
    await withTestSql(async (sql) => {
      await sql`update workflow_runs set deadline_at = now() - interval '1 second'
        where id = ${runId}`;
      await sql`update platform_jobs set run_after = now()
        where client_instance_id = ${clientInstanceId}
          and kind = 'workflow_run.execute_step' and status = 'queued'`;
    });
    expect(await t.finish(runId, required(workers[0]))).toMatchObject({
      status: "limit_reached",
      error: { code: "duration_limit" }
    });
    expect(t.capturedMail()).toHaveLength(3);
  });

  it("answers an agent's call at the instance's limit rate_limited, after its person confirmed it", async () => {
    const t = await ready({
      mail: {
        recipientDomains: ["kanzlei.de"],
        limits: { perWorkflowPerHour: 10, perInstancePerDay: 1 }
      }
    });
    t.state.agentTools.set("assistant", ["mail.send"]);
    const input = { to: ["anna@kanzlei.de"], subject: "Stand", body: "Alles **gut**." };
    const call = (toolCallId: string): OperationCall => ({
      operation: "mail.send",
      effect: "changing",
      input,
      actor: identityOf(t.root),
      origin: { ...agentOrigin("mail.send"), toolCallId: asToolCallId(toolCallId) },
      correlationId: "corr_test"
    });
    const worker = {
      runFence: {
        runId: asAgentRunId("agentrun_test"),
        lease: { jobId: createPlatformId<"JobId">("job"), leaseToken: "lease_test" }
      }
    };
    const confirmed = async (toolCallId: string) => {
      // In the worker of its Agent Run, which pauses on the call for its person.
      const held = await runOperation(call(toolCallId), t.operationCalls.deps, worker);
      expect(held.result).toMatchObject({
        status: "pending_confirmation",
        simulation: {
          simulated: true,
          preview: {
            from: { name: "Example Catalyst", address: "catalyst@mail.example.test" },
            to: [{ kind: "address", label: "anna@kanzlei.de" }],
            subject: "Stand",
            text: expect.stringContaining("Alles gut.")
          }
        }
      });
      await withTestSql(
        (sql) => sql`
          update operation_runs
          set decision = ${sql.json({ mode: "confirmed", by: t.root.id, at: new Date().toISOString() })}
          where id = ${held.run.id}`
      );
      // The call as its run froze it: the input as the operation parsed it.
      const definition = required(await t.operationCalls.registry.resolve("mail.send", t.stores));
      const frozen = { ...call(toolCallId), input: definition.inputSchema.parse(input) };
      return executeConfirmedOperation(
        { runId: held.run.id, call: frozen },
        t.operationCalls.deps,
        { runtime: worker }
      );
    };
    expect(await confirmed("call_1")).toMatchObject({ execution: "done" });
    expect(t.capturedMail()).toHaveLength(1);
    const limited = await confirmed("call_2");
    expect(limited).toMatchObject({
      execution: "failed",
      error: { code: "RATE_LIMITED" },
      run: { status: "failed", error: { reason: "rate_limited" } }
    });
    expect(t.capturedMail()).toHaveLength(1);
  });
});

describe("guardrails on a mail (check 137)", () => {
  const guarded = (guardrails: Record<string, unknown>) =>
    ready({
      mail: { recipientDomains: ["kanzlei.de", "rivale.de"] },
      events: (stores) => guardedEvents(stores, guardrails).events
    });

  it("stops a step whose resolved body holds an IBAN, failing the published run with the guardrail's reason", async () => {
    const t = await guarded({
      "mail-iban": {
        displayName: "E-Mail senden: IBAN → Freigabe",
        on: "operation.before_call",
        filter: { operation: "mail.send" },
        check: {
          kind: "pattern",
          pattern: ibanPattern,
          reason: "Eine IBAN braucht eine Freigabe."
        },
        outcome: "require_approval"
      }
    });
    await grantSystem(t);
    await save(
      t,
      mailFlow("iban", { ...basic({ value: "anna@kanzlei.de" }), body: ref("subject") })
    );
    const stopped = await run(t, "iban", { subject: `Bitte auf ${IBAN} überweisen.` });
    expect(stopped.run.status).toBe("failed");
    expect(stopped.step.error).toMatchObject({ code: "POLICY_DENIED" });
    expect(stopped.step.error?.message).toContain(
      "The guardrail 'E-Mail senden: IBAN → Freigabe' asks for another person's approval of 'mail.send': Eine IBAN braucht eine Freigabe."
    );
    const passed = await run(t, "iban", { subject: "Kein Konto hier." });
    expect(passed.run.status).toBe("done");
    expect(t.capturedMail()).toHaveLength(1);
  });

  it("reads no address: an e-mail pattern does not fire, and a pattern on a domain stops mail to it", async () => {
    const t = await guarded({
      "no-addresses": {
        displayName: "Keine Adressen",
        on: "operation.before_call",
        filter: { operation: "mail.send" },
        check: { kind: "pattern", pattern: "[\\w.+-]+@[\\w-]+\\.[\\w.]+" },
        outcome: "block"
      },
      "no-rival": {
        displayName: "Nicht an Rivale",
        on: "operation.before_call",
        filter: { operation: "mail.send" },
        check: { kind: "pattern", pattern: "rivale\\.de" },
        outcome: "block"
      }
    });
    await grantSystem(t);
    await save(t, mailFlow("to", basic(ref("email"))));
    expect((await run(t, "to", { email: "anna@kanzlei.de" })).run.status).toBe("done");
    const rival = await run(t, "to", { email: "otto@rivale.de" });
    expect(rival.step.error).toMatchObject({ code: "GUARDRAIL_BLOCKED" });
    expect(rival.step.error?.message).toContain("Nicht an Rivale");
    expect(t.capturedMail().map((mail) => mail.recipients.to[0]?.email)).toEqual([
      "anna@kanzlei.de"
    ]);
  });
});

describe("a workspace as recipient (MAIL-2)", () => {
  async function team() {
    const t = await ready();
    const pia = await person(t, "Pia Person", "pia@kanzlei.de");
    const ben = await person(t, "Ben Kurz", "ben@kanzlei.de");
    const shared = await t.sharedWorkspace("Team");
    for (const member of [pia, ben])
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: shared,
        userId: member.id,
        role: "member"
      });
    await grantSystem(t);
    return { t, pia, ben, shared };
  }

  const refusedFor = (response: { statusCode: number; json(): unknown }) => {
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { details: { reason: "workspace_not_allowed" } }
    });
  };

  it("mails the members of a Shared Workspace its author belongs to, or any for an admin", async () => {
    const { t, shared } = await team();
    await save(t, mailFlow("team", basic({ value: [{ workspace: shared }] })));
    expect((await run(t, "team")).run.status).toBe("done");
    expect(
      t
        .capturedMail()[0]
        ?.recipients.to.map((to) => to.email)
        .sort()
    ).toEqual(["ben@kanzlei.de", "pia@kanzlei.de"]);
  });

  it("is refused at save where the writer is no member of it", async () => {
    const { t, shared, pia } = await team();
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.write");
    refusedFor(await put(t, mailFlow("team", basic({ value: [{ workspace: shared }] })), t.kai.id));
    // Nor is a Personal Workspace ever a recipient, whoever writes it.
    const personal = await t.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: pia.id
    });
    refusedFor(await put(t, mailFlow("own", basic({ value: [{ workspace: personal.id }] }))));
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: shared,
      userId: t.kai.id,
      role: "member"
    });
    const member = await put(
      t,
      mailFlow("team", basic({ value: [{ workspace: shared }] })),
      t.kai.id
    );
    expect(member.statusCode, member.body).toBe(200);
  });

  it("is refused at publish where the publisher is no member of it", async () => {
    const { t, shared } = await team();
    for (const action of ["workflow.write", "workflow.publish"])
      await t.allow({ kind: "user", id: t.kai.id }, action);
    // Kai holds the right the Workflow's account acts with, so the workspace alone refuses.
    await grantSystemTo(t, t.kai);
    const written = await put(t, mailFlow("team", basic({ value: [{ workspace: shared }] })));
    expect(written.statusCode, written.body).toBe(200);
    const published = await t.call(t.kai.id, "assets.publish", {
      params: { kind: "workflow", name: "team" },
      payload: { revision: 1 }
    });
    refusedFor(published);
  });

  it("fails the run of a revision whose publisher may no longer mail it, and of a workspace a run reads", async () => {
    const { t, shared, pia } = await team();
    const ada = await person(t, "Ada Admin", "ada@kanzlei.de", ["user", "admin"]);
    await save(t, mailFlow("team", basic({ value: [{ workspace: shared }] })), {
      writer: ada.id,
      publisher: ada.id
    });
    await t.stores.users.updateUser({ clientInstanceId, userId: ada.id, roles: ["user"] });
    const literal = await run(t, "team");
    expect(literal.step.error).toMatchObject({ code: "workspace_not_allowed" });
    expect(literal.step.error?.message).not.toMatch(/Pia|Ben|kanzlei/u);
    // A run reads a workspace from its input: a Personal Workspace is mailed by nobody.
    await save(t, mailFlow("by-ref", basic(ref("people"))));
    const personal = await t.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: pia.id
    });
    const read = await run(t, "by-ref", { people: [{ workspace: personal.id }] });
    expect(read.step.error).toMatchObject({ code: "workspace_not_allowed" });
    expect(t.capturedMail()).toEqual([]);
    expect(await mailEvents()).toMatchObject([
      { type: "mail.refused", metadata: { reason: "workspace_not_allowed", target: "live" } },
      { type: "mail.refused", metadata: { reason: "workspace_not_allowed", target: "live" } }
    ]);
    expect((await run(t, "by-ref", { people: [{ workspace: shared }] })).run.status).toBe("done");
  });

  it("previews no member of a workspace the tester may not mail", async () => {
    const { t, shared } = await team();
    for (const action of ["workflow.write", "workflow.read"])
      await t.allow({ kind: "user", id: t.kai.id }, action);
    await grantSystemTo(t, t.kai);
    await put(t, mailFlow("draft", basic(ref("people"))));
    const hidden = await testRun(t, "draft", { people: [{ workspace: shared }] }, t.kai);
    expect(hidden.error).toMatchObject({ code: "workspace_not_allowed" });
    expect(hidden.outputPreview).toBeUndefined();
    expect(JSON.stringify(hidden)).not.toMatch(/Pia|Ben|pia@|ben@/u);
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: shared,
      userId: t.kai.id,
      role: "member"
    });
    const shown = await testRun(t, "draft", { people: [{ workspace: shared }] }, t.kai);
    expect(shown).toMatchObject({ status: "done", target: "dry_run" });
    expect(JSON.parse(required(shown.outputPreview).text)).toMatchObject({
      preview: { to: expect.arrayContaining([{ kind: "person", label: "Pia Person" }]) }
    });
    expect(t.capturedMail()).toEqual([]);
  });
});
