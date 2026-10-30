import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORKFLOW_WEBHOOK_HEADERS, WORKFLOW_WEBHOOK_LIMITS } from "@work-shape/catalyst-core";
import { workflowWebhookSignature } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";
import { save } from "./support/mail-workflows";
import { runSchema, workflowFixture, type WorkflowFixture } from "./support/workflow-instance";

// The `webhook` trigger (EW-4), over HTTP on Postgres and the engine's jobs: an outside system
// posts a signed run report to a Workflow's address, and the Workflow's own account runs it.
// Acceptance checks 9 and 156 of the Events, Workflows And Guardrails spec.

const WORKFLOW = "pipeline-report";
const REPORT = { status: "failed", domains: 4, failingDomain: "billing" };

let fixture: WorkflowFixture | undefined;
afterEach(async () => {
  await fixture?.instance.close();
  fixture = undefined;
});

function pipelineReport(trigger: Record<string, unknown> = { kind: "webhook" }) {
  return {
    id: WORKFLOW,
    name: "Pipeline report",
    runAs: "workflow-runner",
    inputs: {
      type: "object",
      properties: {
        status: { type: "string" },
        domains: { type: "integer" },
        failingDomain: { type: "string" }
      },
      required: ["status"]
    },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Report arrives", type: "trigger", triggers: [trigger] },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { status: { ref: { step: "start", path: "input.status" } } }
      }
    ]
  };
}

async function ready(trigger?: Record<string, unknown>) {
  fixture = await workflowFixture({ definitions: "assets", webhooks: true });
  await save(fixture, pipelineReport(trigger));
  return fixture;
}

const secretSchema = z.object({ secret: z.string().min(32), version: z.number() });
const errorReason = (response: { json(): unknown }) =>
  z
    .object({ error: z.object({ details: z.object({ reason: z.string() }) }) })
    .parse(response.json()).error.details.reason;

async function rotate(t: WorkflowFixture) {
  return secretSchema.parse(
    (
      await t.expectOk(t.root.id, "workflows.rotate_webhook_secret", {
        params: { workflow: WORKFLOW }
      })
    ).json()
  );
}

/** Posts a body to the webhook, signed with the secret unless told otherwise. */
function post(
  t: WorkflowFixture,
  secret: string,
  options: {
    body?: string;
    timestamp?: number;
    nonce?: string;
    signature?: string;
    unsigned?: true;
    workflow?: string;
  } = {}
) {
  const body = options.body ?? JSON.stringify(REPORT);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomUUID();
  const signature = options.signature ?? workflowWebhookSignature(secret, timestamp, nonce, body);
  return t.instance.call("workflows.webhook_receive", {
    params: { workflow: options.workflow ?? WORKFLOW },
    payload: body,
    headers: {
      "content-type": "application/json",
      ...(options.unsigned
        ? {}
        : {
            [WORKFLOW_WEBHOOK_HEADERS.timestamp]: timestamp,
            [WORKFLOW_WEBHOOK_HEADERS.nonce]: nonce,
            [WORKFLOW_WEBHOOK_HEADERS.signature]: signature
          })
    }
  });
}

async function runsOf(t: WorkflowFixture) {
  const response = await t.expectOk(t.root.id, "workflows.list_runs", {
    params: { workflow: WORKFLOW }
  });
  return z
    .object({ items: z.array(runSchema.extend({ trigger: z.string() })) })
    .parse(response.json()).items;
}

async function auditOf(t: WorkflowFixture, type: string) {
  return t.stores.audit.listAuditEvents({ clientInstanceId, type });
}

describe("a Workflow's webhook", () => {
  it("starts a run as the Workflow's own account from a signed report, and audits it without the body", async () => {
    const t = await ready();
    const { secret } = await rotate(t);
    const response = await post(t, secret);
    expect(response.json()).not.toHaveProperty("error");
    expect(response.statusCode).toBe(200);
    const { runId } = z.object({ runId: z.string() }).parse(response.json());
    const ended = await t.finish(runId);
    expect(ended.status).toBe("done");
    const [run] = await runsOf(t);
    expect(run).toMatchObject({
      id: runId,
      trigger: "webhook",
      startedBy: { kind: "service_principal", id: t.principal.id }
    });
    const [started] = await auditOf(t, "workflow_run.started");
    expect(started?.metadata).toMatchObject({ trigger: "webhook", principalId: t.principal.id });
    expect(JSON.stringify(started)).not.toContain("billing");
  });

  it("refuses an unsigned request, a bad signature, an old timestamp and a replayed nonce before any run, and audits each", async () => {
    const t = await ready();
    const { secret } = await rotate(t);

    const unsigned = await post(t, secret, { unsigned: true });
    expect(unsigned.statusCode).toBe(401);
    expect(errorReason(unsigned)).toBe("webhook_unsigned");

    const forged = await post(t, secret, { signature: `v1=${"0".repeat(64)}` });
    expect(forged.statusCode).toBe(401);
    expect(errorReason(forged)).toBe("webhook_signature_invalid");
    const otherSecret = await post(t, "not-the-secret");
    expect(errorReason(otherSecret)).toBe("webhook_signature_invalid");

    const old = Math.floor((Date.now() - WORKFLOW_WEBHOOK_LIMITS.toleranceMs) / 1000) - 60;
    const expired = await post(t, secret, { timestamp: old });
    expect(expired.statusCode).toBe(401);
    expect(errorReason(expired)).toBe("webhook_timestamp_expired");

    const nonce = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000);
    expect((await post(t, secret, { nonce, timestamp })).statusCode).toBe(200);
    const replayed = await post(t, secret, { nonce, timestamp });
    expect(replayed.statusCode).toBe(401);
    expect(errorReason(replayed)).toBe("webhook_nonce_replayed");

    expect(await runsOf(t)).toHaveLength(1);
    const refused = await auditOf(t, "workflow.webhook_refused");
    expect(refused.map((event) => event.metadata?.reason).sort()).toEqual([
      "webhook_nonce_replayed",
      "webhook_signature_invalid",
      "webhook_signature_invalid",
      "webhook_timestamp_expired",
      "webhook_unsigned"
    ]);
    expect(JSON.stringify(refused)).not.toContain("billing");
  });

  it("refuses a body over the cap before it is read to the end", async () => {
    const t = await ready();
    const { secret } = await rotate(t);
    const body = JSON.stringify({
      status: "x".repeat(WORKFLOW_WEBHOOK_LIMITS.maxBodyBytes + 1)
    });
    const response = await post(t, secret, { body });
    expect(response.statusCode).toBe(400);
    expect(errorReason(response)).toBe("body_too_large");
    expect(await runsOf(t)).toEqual([]);
  });

  it("takes at most its trigger's requests a minute", async () => {
    const t = await ready({ kind: "webhook", perMinute: 2 });
    const { secret } = await rotate(t);
    expect((await post(t, secret)).statusCode).toBe(200);
    expect((await post(t, secret)).statusCode).toBe(200);
    const third = await post(t, secret);
    expect(third.statusCode).toBe(429);
    expect(errorReason(third)).toBe("webhook_rate_limited");
    expect(await runsOf(t)).toHaveLength(2);
  });

  it("rotates its secret: shown once, the old one signs nothing, and only a publisher makes it", async () => {
    const t = await ready();
    const status = async (userId: string) =>
      (await t.expectOk(userId, "workflows.webhook", { params: { workflow: WORKFLOW } })).json();
    expect(await status(t.root.id)).toEqual({
      enabled: true,
      perMinute: WORKFLOW_WEBHOOK_LIMITS.perMinute,
      secret: "not_set"
    });
    expect(errorReason(await post(t, "anything"))).toBe("webhook_no_secret");

    const first = await rotate(t);
    expect(first.version).toBe(1);
    const second = await rotate(t);
    expect(second.version).toBe(2);
    expect(second.secret).not.toBe(first.secret);
    expect(errorReason(await post(t, first.secret))).toBe("webhook_signature_invalid");
    expect((await post(t, second.secret)).statusCode).toBe(200);
    expect(await status(t.root.id)).toMatchObject({ secret: "set", version: 2 });

    // A reader sees the state, never the secret, and may not make one.
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.read");
    expect(JSON.stringify(await status(t.kai.id))).not.toContain(second.secret);
    const refused = await t.call(t.kai.id, "workflows.rotate_webhook_secret", {
      params: { workflow: WORKFLOW }
    });
    expect(refused.statusCode).toBe(403);

    const rotated = await auditOf(t, "workflow.webhook_secret_rotated");
    expect(rotated.map((event) => event.metadata?.version).sort()).toEqual([1, 2]);
    const audit = JSON.stringify(await t.stores.audit.listAuditEvents({ clientInstanceId }));
    expect(audit).not.toContain(first.secret);
    expect(audit).not.toContain(second.secret);
  });

  it("is no address for a Workflow without a webhook trigger", async () => {
    const t = await ready({ kind: "manual" });
    const response = await post(t, "anything");
    expect(response.statusCode).toBe(404);
    expect(
      (await t.expectOk(t.root.id, "workflows.webhook", { params: { workflow: WORKFLOW } })).json()
    ).toMatchObject({ enabled: false });
  });
});
