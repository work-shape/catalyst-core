import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EVENTS } from "@work-shape/catalyst-core";
import type { MailSendResult, MailTransport, RenderedMail } from "@work-shape/catalyst-mail";
import { clientInstanceId } from "./support/access-instance";
import { required } from "./support/assertions";
import { withTestSql } from "./support/test-sql";
import { runSchema, workflowFixture, type WorkflowFixture } from "./support/workflow-instance";
import { stepRunsOf } from "./support/workflow-runs";

// MAIL-1: `mail.send` called by a published Workflow's `operation` step, end to end on the
// capture transport. Events checks 129, 130, 132, 133, 134 and 140.

let fixture: WorkflowFixture | undefined;
afterEach(async () => {
  await fixture?.instance.close();
  fixture = undefined;
});

const trigger = { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] };
const output = { id: "result", name: "Result", type: "output", input: {} };
const inputs = {
  type: "object",
  properties: {
    subject: { type: "string" },
    email: { type: "string" },
    people: { type: "array", items: { type: "object" } }
  }
};
const ref = (path: string) => ({ ref: { step: "start", path: `input.${path}` } });

function mailFlow(id: string, input: Record<string, unknown>) {
  return {
    id,
    name: `Flow ${id}`,
    runAs: "workflow-runner",
    inputs,
    outputs: { type: "object" },
    steps: [
      trigger,
      { id: "mail", name: "Mail the team", type: "operation", operation: "mail.send", input },
      output
    ]
  };
}

const basic = (to: unknown) => ({
  to,
  subject: { value: "Monthly check" },
  body: { value: "All **good**." }
});

async function ready(options: Parameters<typeof workflowFixture>[0] = {}) {
  fixture = await workflowFixture({ definitions: "assets", ...options });
  return fixture;
}

/** The Workflow's account holds `mail_sender.use` on `system`, as the publish screen gives it. */
async function grantSystem(t: WorkflowFixture) {
  await t.expectOk(t.root.id, "permissions.grant", {
    payload: {
      holderKind: "service_principal",
      holderId: t.principal.id,
      action: "mail_sender.use",
      scopeKind: "asset",
      scopeId: "system"
    }
  });
}

async function put(t: WorkflowFixture, manifest: ReturnType<typeof mailFlow>) {
  return t.call(t.admin.id, "assets.put", {
    params: { kind: "workflow", name: manifest.id },
    payload: { config: { name: manifest.id, manifest }, expectedRevision: null }
  });
}

async function save(t: WorkflowFixture, manifest: ReturnType<typeof mailFlow>) {
  const written = await put(t, manifest);
  expect(written.statusCode, written.body).toBe(200);
  const { revision } = z.object({ revision: z.number() }).parse(written.json());
  await t.expectOk(t.root.id, "assets.publish", {
    params: { kind: "workflow", name: manifest.id },
    payload: { revision }
  });
}

async function run(t: WorkflowFixture, workflow: string, input: Record<string, unknown> = {}) {
  const started = runSchema.parse(
    (
      await t.expectOk(t.root.id, "workflows.start", {
        params: { workflow },
        payload: { input }
      })
    ).json()
  );
  const ended = await t.finish(started.id);
  const step = required((await stepRunsOf(t, started.id)).find((s) => s.stepId === "mail"));
  return { run: ended, step };
}

/** The mail events so far, each held to its payload in the event registry. */
async function mailEvents() {
  const rows = await withTestSql(
    (sql) =>
      sql<{ type: "mail.sent" | "mail.refused"; metadata: Record<string, unknown> }[]>`
        select type, metadata from audit_events
        where client_instance_id = ${clientInstanceId} and type in ('mail.sent', 'mail.refused')
        order by created_at`
  );
  for (const { type, metadata } of rows) {
    const { required: needed, properties } = EVENTS[type].payload;
    expect(
      Object.keys(metadata).filter((key) => !Object.hasOwn(properties, key)),
      type
    ).toEqual([]);
    expect(
      needed.filter((key) => !Object.hasOwn(metadata, key)),
      type
    ).toEqual([]);
    expect(metadata.operationRunId, type).toEqual(expect.stringMatching(/^oprun_/u));
  }
  return rows;
}

async function person(t: WorkflowFixture, displayLabel: string, email?: string) {
  return t.stores.users.createUser({
    clientInstanceId,
    displayLabel,
    roles: ["user"],
    permissions: [],
    ...(email ? { email } : {})
  });
}

describe("mail.send from a Workflow (MAIL-1)", () => {
  it("is refused at save with operation_not_found where outbound mail is off", async () => {
    const t = await ready();
    const refused = await put(t, mailFlow("no-mail", basic({ value: "a@kanzlei.de" })));
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: { details: { reason: "operation_not_found" } } });
    await expect(t.operationCalls.registry.resolve("mail.send", t.stores)).resolves.toBeUndefined();
  });

  it("sends one mail with every envelope field in the instance's frame and answers counts only", async () => {
    const t = await ready({ mail: { recipientDomains: ["kanzlei.de"] } });
    const pia = await person(t, "Pia Person", "pia@elsewhere.test");
    await grantSystem(t);
    await save(
      t,
      mailFlow("monthly", {
        to: { value: ["a@kanzlei.de", "b@kanzlei.de"] },
        cc: { value: [{ user: pia.id }] },
        bcc: { value: "c@kanzlei.de" },
        senderName: { value: "Kanzlei Team" },
        replyTo: { value: "office@kanzlei.de" },
        subject: ref("subject"),
        body: {
          value: "# Findings\n\n| Client | Open |\n| --- | --- |\n| Alpha | 2 |\n\nSee you."
        }
      })
    );
    const { run: ended, step } = await run(t, "monthly", { subject: "Monthly check" });
    expect(ended.status).toBe("done");
    const [mail, ...more] = t.capturedMail();
    expect(more).toEqual([]);
    expect(required(mail)).toMatchObject({
      from: { email: "catalyst@mail.example.test", name: "Kanzlei Team" },
      recipients: {
        to: [{ email: "a@kanzlei.de" }, { email: "b@kanzlei.de" }],
        cc: [{ email: "pia@elsewhere.test", displayLabel: "Pia Person" }],
        bcc: [{ email: "c@kanzlei.de" }]
      },
      replyTo: { email: "office@kanzlei.de" },
      subject: "Monthly check"
    });
    expect(mail?.text).toContain("Client | Open");
    expect(mail?.text).toContain('The Workflow "Flow monthly" of Example Catalyst sent');
    expect(mail?.html).toContain("<table");
    expect(mail?.html).toContain("#123456");
    expect(mail?.html).toContain("Example Catalyst");
    expect(mail?.html).toContain("Musterstrasse 1");
    expect(mail?.html).toContain("Flow monthly");
    const answered: unknown = JSON.parse(required(step.outputPreview).text);
    expect(answered).toMatchObject({
      messageId: expect.stringMatching(/^capture-/u),
      recipients: { to: 2, cc: 1, bcc: 1 },
      skipped: 0
    });
    expect(JSON.stringify(answered)).not.toContain("@");
    expect(await mailEvents()).toMatchObject([
      {
        type: "mail.sent",
        metadata: {
          sender: "system",
          target: "live",
          recipients: { to: 2, cc: 1, bcc: 1 },
          domains: ["elsewhere.test", "kanzlei.de"],
          outcome: "accepted"
        }
      }
    ]);
  });

  it("holds every address to the rule at save, at publish and at run", async () => {
    const t = await ready({ mail: { recipientDomains: ["kanzlei.de"] } });
    const pia = await person(t, "Pia Person", "pia@elsewhere.test");
    await grantSystem(t);
    // Save: a literal address outside the rule is refused with its domain named.
    const literal = await put(t, mailFlow("literal", basic({ value: "a@gmail.com" })));
    expect(literal.statusCode).toBe(422);
    expect(literal.json()).toMatchObject({
      error: {
        message: expect.stringContaining("gmail.com"),
        details: { reason: "recipient_not_allowed", domain: "gmail.com" }
      }
    });
    // A subdomain is not the domain.
    const sub = await put(t, mailFlow("sub", basic({ value: ["c@steuer.kanzlei.de"] })));
    expect(sub.json()).toMatchObject({ error: { details: { domain: "steuer.kanzlei.de" } } });
    // A person's address is theirs whatever the domain, written as an address or as the user.
    await save(t, mailFlow("people", basic({ value: ["pia@elsewhere.test", { user: pia.id }] })));
    // Literal fields the operation refuses are refused at save as input_invalid.
    for (const field of [
      { subject: { value: "Two\nlines" } },
      { senderName: { value: "team@kanzlei.de" } }
    ]) {
      const invalid = await put(
        t,
        mailFlow("invalid", { ...basic({ value: "a@kanzlei.de" }), ...field })
      );
      expect(invalid.json()).toMatchObject({ error: { details: { reason: "input_invalid" } } });
    }
    // Run: a referenced address outside the rule fails the step and sends to nobody.
    await save(t, mailFlow("by-ref", basic(ref("email"))));
    const refused = await run(t, "by-ref", { email: "b@gmail.com" });
    expect(refused.run.status).toBe("failed");
    expect(refused.step.error).toMatchObject({ code: "recipient_not_allowed" });
    expect(t.capturedMail()).toEqual([]);
    expect(await mailEvents()).toMatchObject([
      {
        type: "mail.refused",
        metadata: { reason: "recipient_not_allowed", domain: "gmail.com", target: "live" }
      }
    ]);
    const deeper = await run(t, "by-ref", { email: "c@steuer.kanzlei.de" });
    expect(deeper.step.error).toMatchObject({ code: "recipient_not_allowed" });
    const sent = await run(t, "people");
    expect(sent.run.status).toBe("done");
    expect(t.capturedMail()).toHaveLength(1);
  });

  it("takes a record of an earlier result by its email alone, whatever else it holds", async () => {
    const t = await ready({ mail: { recipientDomains: ["kanzlei.de"] } });
    const pia = await person(t, "Pia Person", "pia@elsewhere.test");
    const team = await t.stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Team",
      creatorUserId: pia.id
    });
    await grantSystem(t);
    await save(t, mailFlow("records", basic(ref("people"))));
    const sent = await run(t, "records", {
      people: [
        // The other fields of a record are its data, never a recipient of their own.
        { email: "anna@kanzlei.de", workspace: team.id, user: pia.id },
        { email: "bert@kanzlei.de", address: "otto@outside.test, c@kanzlei.de" }
      ]
    });
    expect(sent.run.status).toBe("done");
    expect(t.capturedMail()[0]?.recipients.to).toEqual([
      { email: "anna@kanzlei.de" },
      { email: "bert@kanzlei.de" }
    ]);
  });

  it("sends with an empty cc and bcc, and refuses a referenced to that holds nobody", async () => {
    const t = await ready({ mail: { recipientDomains: ["kanzlei.de"] } });
    await grantSystem(t);
    await save(
      t,
      mailFlow("copies", {
        ...basic({ value: "a@kanzlei.de" }),
        cc: { value: [] },
        bcc: { value: [] }
      })
    );
    expect((await run(t, "copies")).run.status).toBe("done");
    expect(t.capturedMail()[0]?.recipients).toEqual({
      to: [{ email: "a@kanzlei.de" }],
      cc: [],
      bcc: []
    });
    // A literal to names someone; a reference may resolve to nobody, which the run refuses.
    const literal = await put(t, mailFlow("nobody", basic({ value: [] })));
    expect(literal.json()).toMatchObject({ error: { details: { reason: "input_invalid" } } });
    await save(t, mailFlow("empty", basic(ref("people"))));
    const empty = await run(t, "empty", { people: [] });
    expect(empty.run.status).toBe("failed");
    expect(empty.step.error).toMatchObject({ code: "no_recipient" });
    expect(t.capturedMail()).toHaveLength(1);
    expect(await mailEvents()).toMatchObject([
      { type: "mail.sent", metadata: { recipients: { to: 1, cc: 0, bcc: 0 } } },
      { type: "mail.refused", metadata: { reason: "no_recipient", target: "live" } }
    ]);
  });

  it("mails the people of the instance with an empty list and fails a mail with nobody in to", async () => {
    const t = await ready({ mail: { recipientDomains: [] } });
    const pia = await person(t, "Pia Person", "pia@elsewhere.test");
    const noAddress = await person(t, "No Address");
    await grantSystem(t);
    await save(t, mailFlow("pia", basic({ value: [{ user: pia.id }] })));
    expect((await run(t, "pia")).run.status).toBe("done");
    expect(t.capturedMail()[0]?.recipients.to).toEqual([
      { email: "pia@elsewhere.test", displayLabel: "Pia Person" }
    ]);
    await save(t, mailFlow("nobody", basic({ value: [{ user: noAddress.id }] })));
    const nobody = await run(t, "nobody");
    expect(nobody.step.error).toMatchObject({ code: "no_recipient" });
    expect(t.capturedMail()).toHaveLength(1);
  });

  it("needs the account to hold mail_sender.use on system, given on that sender and nothing wider", async () => {
    const t = await ready({ mail: { recipientDomains: ["kanzlei.de"] } });
    const manifest = mailFlow("rights", basic({ value: "a@kanzlei.de" }));
    const written = await put(t, manifest);
    const { revision } = z.object({ revision: z.number() }).parse(written.json());
    const publish = () =>
      t.call(t.root.id, "assets.publish", {
        params: { kind: "workflow", name: manifest.id },
        payload: { revision }
      });
    const refused = await publish();
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      error: { details: { action: "mail_sender.use", reason: "no_grant" } }
    });
    const grant = (scope: Record<string, unknown>) =>
      t.call(t.root.id, "permissions.grant", {
        payload: {
          holderKind: "service_principal",
          holderId: t.principal.id,
          action: "mail_sender.use",
          ...scope
        }
      });
    // Never at instance scope, never on a sender the instance does not have.
    expect((await grant({ scopeKind: "instance" })).statusCode).toBe(422);
    const other = await grant({ scopeKind: "asset", scopeId: "other-sender" });
    expect(other.statusCode).toBe(422);
    expect(other.json()).toMatchObject({ error: { details: { reason: "invalid_scope" } } });
    expect((await grant({ scopeKind: "asset", scopeId: "system" })).statusCode).toBe(200);
    const rows = await t.stores.access.listGrants({
      clientInstanceId,
      holderKind: "service_principal",
      excludeLegacyKeyRows: true
    });
    expect(rows.map(({ action, scopeKind, scopeId }) => ({ action, scopeKind, scopeId }))).toEqual([
      { action: "mail_sender.use", scopeKind: "asset", scopeId: "system" }
    ]);
    expect((await publish()).statusCode).toBe(200);
  });

  it("keeps addresses, subject and body out of audit events and Operation Runs", async () => {
    const t = await ready({ mail: { recipientDomains: ["kanzlei.de"] } });
    await grantSystem(t);
    await save(
      t,
      mailFlow("private", {
        to: ref("email"),
        subject: { value: "Secret subject line" },
        body: { value: "Secret body paragraph" }
      })
    );
    expect((await run(t, "private", { email: "anna@kanzlei.de" })).run.status).toBe("done");
    expect((await run(t, "private", { email: "otto@outside.test" })).run.status).toBe("failed");
    expect((await mailEvents()).map((event) => event.type)).toEqual(["mail.sent", "mail.refused"]);
    const stored = await withTestSql(async (sql) =>
      JSON.stringify([
        await sql`select * from audit_events where client_instance_id = ${clientInstanceId}`,
        await sql`select * from operation_runs where operation = 'mail.send'`
      ])
    );
    for (const secret of [
      "anna@kanzlei.de",
      "otto@outside.test",
      "Secret subject line",
      "Secret body paragraph"
    ])
      expect(stored, secret).not.toContain(secret);
    expect(stored).toContain("outside.test");
  });
});

/** A transport that answers what a test gives it, once each, and counts its calls. */
class ScriptedTransport implements MailTransport {
  readonly delivered: RenderedMail[] = [];
  constructor(private readonly answers: MailSendResult[]) {}
  async deliver(mail: RenderedMail): Promise<MailSendResult> {
    this.delivered.push(mail);
    return this.answers.shift() ?? { ok: true, messageId: "mj-1" };
  }
}

describe("mail.send's provider failures (MAIL-1, check 140)", () => {
  async function failing(answers: MailSendResult[]) {
    const transport = new ScriptedTransport(answers);
    const t = await ready({ mail: { recipientDomains: ["kanzlei.de"], transport } });
    await grantSystem(t);
    await save(t, mailFlow("failing", basic({ value: "a@kanzlei.de" })));
    return { t, transport, ...(await run(t, "failing")) };
  }

  it("fails the step with mail_rejected and the provider's code in one attempt", async () => {
    const { transport, step } = await failing([
      { ok: false, reason: "provider_rejected", failure: "rejected", providerCode: "mj-0013" }
    ]);
    expect(step.error).toMatchObject({ code: "mail_rejected" });
    expect(step.attempt).toBe(1);
    expect(transport.delivered).toHaveLength(1);
    expect(await mailEvents()).toMatchObject([
      { type: "mail.refused", metadata: { reason: "mail_rejected" } }
    ]);
  });

  it("makes a call again whose connection was refused, and sends one mail", async () => {
    const { run: ended, transport } = await failing([
      { ok: false, reason: "provider_unreachable", failure: "unsent" }
    ]);
    expect(ended.status).toBe("done");
    expect(transport.delivered).toHaveLength(2);
    expect((await mailEvents()).map((event) => event.type)).toEqual(["mail.sent"]);
  });

  it("fails as operation_interrupted where the answer was lost, and sends no second mail", async () => {
    const { step, transport } = await failing([
      { ok: false, reason: "provider_uncertain", failure: "uncertain" }
    ]);
    expect(step.error).toMatchObject({ code: "operation_interrupted" });
    expect(step.error?.message).toContain("may or may not");
    expect(transport.delivered).toHaveLength(1);
    expect(await mailEvents()).toMatchObject([
      { type: "mail.sent", metadata: { outcome: "uncertain" } }
    ]);
  });
});

describe("a test run of a mail.send step", () => {
  it("sends nothing and answers the mail as it would go out, held to the rule", async () => {
    const t = await ready({ mail: { recipientDomains: ["kanzlei.de"] } });
    await grantSystem(t);
    await save(t, mailFlow("draft", basic(ref("email"))));
    const test = async (email: string) => {
      const started = runSchema.parse(
        (
          await t.expectOk(t.root.id, "workflows.test", {
            params: { workflow: "draft" },
            payload: { input: { email } }
          })
        ).json()
      );
      await t.finish(started.id);
      return required((await stepRunsOf(t, started.id)).find((s) => s.stepId === "mail"));
    };
    const simulated = await test("anna@kanzlei.de");
    expect(simulated).toMatchObject({ status: "done", target: "dry_run" });
    const preview: unknown = JSON.parse(required(simulated.outputPreview).text);
    expect(preview).toMatchObject({
      simulated: true,
      preview: {
        from: { name: "Example Catalyst", address: "catalyst@mail.example.test" },
        to: [{ kind: "address", label: "anna@kanzlei.de" }],
        subject: "Monthly check"
      }
    });
    expect(t.capturedMail()).toEqual([]);
    const outside = await test("otto@outside.test");
    expect(outside.error).toMatchObject({ code: "recipient_not_allowed" });
    expect(t.capturedMail()).toEqual([]);
    expect(await mailEvents()).toMatchObject([
      { type: "mail.refused", metadata: { reason: "recipient_not_allowed", target: "dry_run" } }
    ]);
  });
});
