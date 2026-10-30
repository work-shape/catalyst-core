import { describe, expect, it } from "vitest";
import {
  askGuardrailResponseSchema,
  guardrailAnswerRefSchema,
  rulesInForceSchema,
  type RuleInForceView
} from "@work-shape/catalyst-api-contract";
import { createGuardrailAssetKind } from "@work-shape/catalyst-server";
import {
  asCollaborationWorkspaceId,
  createPlatformId,
  type GuardrailAnswer
} from "@work-shape/catalyst-core";
import {
  guardrailDenial,
  toolResultFromOperationResult
} from "@work-shape/catalyst-tool-execution";
import { clientInstanceId, errorSchema, skill } from "./support/access-instance";
import { setupAppInstance } from "./support/app-instance";
import { IBAN, configWith, guardedEvents, noIban } from "./support/guardrails";
import { fixture } from "./support/operation-approval";

// What a person is shown of a guardrail where they act, and Rules in force (GR-3). Spec:
// events-workflows-and-guardrails.md, What a stopped person sees, acceptance check 58.

const noSecret = (outcome: "block" | "require_approval" | "warn", name = "No secrets") => ({
  displayName: name,
  on: "operation.before_call",
  check: { kind: "pattern", pattern: "secret", reason: "Calls carry no secrets." },
  outcome
});

describe("a guardrail's answer on a call", () => {
  // Fails without the change: a refusal named the guardrail by its id alone, with no reason,
  // outcome or origin the interface could show.
  it("names the guardrail, its reason, its outcome and its origin on a refused call", async () => {
    const t = await fixture({
      settings: () => [],
      release: { guardrails: { no_secret: noSecret("block") } }
    });
    const blocked = await t.call("requester", "my-secret");
    expect(blocked.statusCode).toBe(403);
    const error = errorSchema.parse(blocked.json()).error;
    expect(error.code).toBe("GUARDRAIL_BLOCKED");
    expect(guardrailAnswerRefSchema.parse(error.details?.guardrail)).toEqual({
      name: "no_secret",
      title: "No secrets",
      outcome: "block",
      reason: "Calls carry no secrets.",
      origin: "release"
    });
    expect(t.executed).toEqual([]);
  });

  // Fails without the change: a held call's Inbox item did not say which guardrail held it.
  it("keeps the guardrails that held or warned about a call on its approval request", async () => {
    const t = await fixture({
      settings: () => [],
      release: {
        guardrails: {
          held_secret: noSecret("require_approval", "Secrets need approval"),
          warned_secret: noSecret("warn", "Secrets warn")
        }
      }
    });
    const { requestId } = await t.hold("my-secret");
    const detail = await t.app.call("approval_requests.get", {
      params: { requestId },
      headers: t.as("approver")
    });
    expect(detail.statusCode).toBe(200);
    const preview = detail.json<{ preview: { guardrails?: unknown[] } }>().preview;
    expect(preview.guardrails?.map((answer) => guardrailAnswerRefSchema.parse(answer))).toEqual([
      expect.objectContaining({ name: "held_secret", outcome: "require_approval" }),
      expect.objectContaining({ name: "warned_secret", outcome: "warn" })
    ]);
  });
});

describe("a guardrail's answer on the tool card", () => {
  // Fails without the change: the card of a refused agent call had only the model's sentence.
  it("hands the card the answer beside the refusal, outside what the model reads", () => {
    const answer: GuardrailAnswer = {
      guardrailName: "no-iban",
      displayName: "Keine IBAN",
      outcome: "block",
      reason: "Bankdaten sind hier nicht erlaubt.",
      origin: "asset",
      scope: { kind: "workspace", workspaceId: asCollaborationWorkspaceId("cw_sales") },
      revision: 3
    };
    const reason = guardrailDenial(
      [{ outcome: "block", guardrails: [answer], subject: { kind: "skill", name: "faq" } }],
      "asset.before_write",
      "de"
    );
    const result = toolResultFromOperationResult(
      {
        result: { status: "denied", runId: createPlatformId<"OperationRunId">("operation"), reason }
      },
      { toolName: "save_skill", agentName: "helper", correlationId: "test", locale: "de" }
    );
    if (result.status !== "failed") throw new Error("Expected a refusal");
    expect(result.guardrail).toEqual({
      name: "no-iban",
      title: "Keine IBAN",
      outcome: "block",
      reason: "Bankdaten sind hier nicht erlaubt.",
      origin: "asset",
      scope: { kind: "workspace", workspaceId: "cw_sales" },
      revision: 3
    });
    // The model reads the error alone, which names no revision or scope.
    expect(JSON.stringify(result.error)).not.toContain("cw_sales");
  });
});

/** An instance with a floor rule, the shipped guardrails and guardrails written as assets. */
async function instance() {
  const floor = { floor_iban: noIban({ displayName: "Floor: no IBAN in skills" }) };
  const t = await setupAppInstance({
    furtherKinds: [createGuardrailAssetKind()],
    server: (stores, config) => ({
      config: { ...config, guardrails: configWith(floor).guardrails },
      operations: { events: guardedEvents(stores, floor, { shipped: true }).events }
    })
  });
  const guardrail = (name: string, overrides: Record<string, unknown> = {}) => ({
    name,
    displayName: `Rule ${name}`,
    on: "asset.before_write",
    filter: { kind: "skill" },
    check: { kind: "pattern", pattern: "Kontonummer", reason: "No account numbers here." },
    outcome: "warn",
    ...overrides
  });
  const enforce = async (name: string, workspaceId?: string) => {
    const scoped = workspaceId === undefined ? {} : { workspaceId };
    const written = await t.call(t.admin.id, "assets.put", {
      params: { kind: "guardrail", name },
      payload: { config: guardrail(name), ...scoped }
    });
    expect(written.statusCode, written.body).toBe(200);
    const published = await t.call(t.admin.id, "assets.publish", {
      params: { kind: "guardrail", name },
      payload: { revision: 1, ...scoped }
    });
    expect(published.statusCode, published.body).toBe(200);
  };
  const rulesOf = async (userId: string) => {
    const response = await t.call(userId, "guardrails.in_force", {});
    expect(response.statusCode, response.body).toBe(200);
    // Strict: an answer that carried who was stopped, or what, fails here.
    return rulesInForceSchema.strict().parse(response.json());
  };
  const lena = await t.stores.users
    .listUsers({ clientInstanceId })
    .then((users) => users.find((user) => user.displayLabel === "Lena"));
  if (!lena) throw new Error("No Lena");
  return { ...t, enforce, rulesOf, lena };
}

const byName = (items: RuleInForceView[], name: string) => items.find((rule) => rule.name === name);

describe("Rules in force", () => {
  // Acceptance check 58. Fails without the change: nothing listed the rules for a person.
  it("lists the floor, the shipped guardrails and those published for the viewer's workspaces", async () => {
    const t = await instance();
    const support = await t.sharedWorkspace("Support");
    await t.enforce("instance-rule");
    await t.enforce("sales-rule", t.workspaceId);
    await t.enforce("support-rule", support);

    // A hit of the instance rule, counted and never named.
    const put = await t.call(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "kunden-faq" },
      payload: { config: skill("kunden-faq", "Die Kontonummer steht im Vertrag.") }
    });
    expect(put.statusCode, put.body).toBe(200);

    const { items } = await t.rulesOf(t.kai.id);
    expect(items.map((rule) => [rule.origin, rule.name])).toEqual(
      expect.arrayContaining([
        ["release", "floor_iban"],
        ["shipped", "publishing-needs-approval"],
        ["asset", "instance-rule"],
        ["asset", "sales-rule"]
      ])
    );
    expect(byName(items, "support-rule")).toBeUndefined();

    expect(byName(items, "floor_iban")).toMatchObject({
      origin: "release",
      scope: { kind: "instance" },
      changers: [],
      askable: false
    });
    expect(byName(items, "floor_iban")?.changedBy).toBeUndefined();
    expect(byName(items, "sales-rule")).toMatchObject({
      scope: { kind: "workspace", workspaceId: t.workspaceId, workspaceName: "Sales" },
      revision: 1,
      reason: "No account numbers here.",
      on: ["asset.before_write"],
      filter: { kind: "skill" },
      outcome: "warn"
    });
    const instanceRule = byName(items, "instance-rule");
    expect(instanceRule).toMatchObject({
      revision: 1,
      askable: true,
      hitsLast30Days: 1,
      // Kai shares Sales with Admin, who published it and can change it.
      changedBy: "Admin",
      changedAt: expect.any(String)
    });
    expect(instanceRule?.changers).toContain("Admin");
    // A superadmin is named to a superadmin only.
    expect(instanceRule?.changers).not.toContain("Root");
  });

  // Fails without the change: the page named people the viewer may not see in the directory.
  it("names nobody a viewer without a shared workspace may not see", async () => {
    const t = await instance();
    await t.enforce("instance-rule");
    const { items } = await t.rulesOf(t.lena.id);
    const rule = byName(items, "instance-rule");
    expect(rule).toMatchObject({ changedByHidden: true, changers: [] });
    expect(rule?.changedBy).toBeUndefined();
    expect(byName(items, "sales-rule")).toBeUndefined();
    expect(JSON.stringify(items)).not.toContain("Admin");
  });

  it("sends a question to the Inbox of who can change a rule, never about the floor", async () => {
    const t = await instance();
    await t.enforce("instance-rule");
    const asked = await t.call(t.kai.id, "guardrails.ask", {
      params: { name: "instance-rule" },
      payload: { text: "Warum warnt das bei Kontonummern?" }
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const { addressees } = askGuardrailResponseSchema.parse(asked.json());
    expect(addressees).toBeGreaterThanOrEqual(1);
    const notices = await t.stores.approvals.listApprovalRequests({
      clientInstanceId,
      kinds: ["notice"]
    });
    expect(notices.map((notice) => notice.addresseeUserId)).toContain(t.admin.id);
    expect(notices.map((notice) => notice.addresseeUserId)).not.toContain(t.kai.id);

    const floor = await t.call(t.kai.id, "guardrails.ask", {
      params: { name: "floor_iban" },
      payload: { text: "Wer hat das festgelegt?" }
    });
    expect(floor.statusCode).toBe(409);
    expect(errorSchema.parse(floor.json()).error.details?.reason).toBe("set_by_operator");

    const unknown = await t.call(t.kai.id, "guardrails.ask", {
      params: { name: "nowhere" },
      payload: { text: "?" }
    });
    expect(unknown.statusCode).toBe(404);
  });

  // Fails without the change: a refused save named the guardrail by its id alone.
  it("answers a refused save with the guardrail the page lists", async () => {
    const t = await instance();
    const blocked = await t.call(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "kunden-faq" },
      payload: { config: skill("kunden-faq", `Überweise an ${IBAN}.`) }
    });
    expect(blocked.statusCode).toBe(403);
    const error = errorSchema.parse(blocked.json()).error;
    expect(error.code).toBe("GUARDRAIL_BLOCKED");
    const answer = guardrailAnswerRefSchema.parse(error.details?.guardrail);
    expect(answer).toMatchObject({ name: "floor_iban", outcome: "block", origin: "release" });
    const { items } = await t.rulesOf(t.kai.id);
    expect(byName(items, answer.name)).toMatchObject({ origin: "release", askable: false });
  });
});
