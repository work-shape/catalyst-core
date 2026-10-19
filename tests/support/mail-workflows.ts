import { expect } from "vitest";
import { z } from "zod";
import { EVENTS, type UserId, type UserRecord, type UserRole } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./access-instance";
import { required } from "./assertions";
import { withTestSql } from "./test-sql";
import { runSchema, type WorkflowFixture } from "./workflow-instance";
import { stepRunsOf } from "./workflow-runs";

// Workflows with a `mail.send` step on the capture transport, for the MAIL tests.

export const trigger = {
  id: "start",
  name: "Start",
  type: "trigger",
  triggers: [{ kind: "manual" }]
};
export const output = { id: "result", name: "Result", type: "output", input: {} };
export const mailInputs = {
  type: "object",
  properties: {
    subject: { type: "string" },
    email: { type: "string" },
    workspace: { type: "string" },
    people: { type: "array", items: { type: "object" } }
  }
};
export const ref = (path: string) => ({ ref: { step: "start", path: `input.${path}` } });

/** A Workflow of one `mail.send` step, `mail`, with the input given. */
export function mailFlow(id: string, input: Record<string, unknown>) {
  return {
    id,
    name: `Flow ${id}`,
    runAs: "workflow-runner",
    inputs: mailInputs,
    outputs: { type: "object" },
    steps: [
      trigger,
      { id: "mail", name: "Mail the team", type: "operation", operation: "mail.send", input },
      output
    ]
  };
}

export const basic = (to: unknown) => ({
  to,
  subject: { value: "Monthly check" },
  body: { value: "All **good**." }
});

/** The Workflow's account holds `mail_sender.use` on `system`, as the publish screen gives it. */
export async function grantSystem(t: WorkflowFixture) {
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

type FixtureResponse = Awaited<ReturnType<WorkflowFixture["call"]>>;

/** Writes a new Workflow, as the administrator unless another writer is named. */
export async function put(
  t: WorkflowFixture,
  manifest: { id: string },
  writer: UserId = t.admin.id
): Promise<FixtureResponse> {
  return t.call(writer, "assets.put", {
    params: { kind: "workflow", name: manifest.id },
    payload: { config: { name: manifest.id, manifest }, expectedRevision: null }
  });
}

/** Writes a Workflow and publishes it, by the administrator and the root unless named. */
export async function save(
  t: WorkflowFixture,
  manifest: { id: string },
  people: { writer?: UserId; publisher?: UserId } = {}
) {
  const written = await put(t, manifest, people.writer);
  expect(written.statusCode, written.body).toBe(200);
  const { revision } = z.object({ revision: z.number() }).parse(written.json());
  await t.expectOk(people.publisher ?? t.root.id, "assets.publish", {
    params: { kind: "workflow", name: manifest.id },
    payload: { revision }
  });
  return revision;
}

/** Runs the published Workflow by hand to its end. Returns the run and its step `mail`. */
export async function run(
  t: WorkflowFixture,
  workflow: string,
  input: Record<string, unknown> = {}
) {
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

/** Test-runs the Workflow's draft as the tester to its end. Returns its step `mail`. */
export async function testRun(
  t: WorkflowFixture,
  workflow: string,
  input: Record<string, unknown>,
  tester: UserRecord = t.root
) {
  const started = runSchema.parse(
    (
      await t.expectOk(tester.id, "workflows.test", {
        params: { workflow },
        payload: { input }
      })
    ).json()
  );
  await t.finish(started.id);
  return required((await stepRunsOf(t, started.id)).find((s) => s.stepId === "mail"));
}

/** The mail events so far, each held to its payload in the event registry. */
export async function mailEvents() {
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

export async function person(
  t: WorkflowFixture,
  displayLabel: string,
  email?: string,
  roles: UserRole[] = ["user"]
) {
  return t.stores.users.createUser({
    clientInstanceId,
    displayLabel,
    roles,
    permissions: [],
    ...(email ? { email } : {})
  });
}
