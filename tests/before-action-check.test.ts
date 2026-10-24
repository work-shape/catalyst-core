import { describe, expect, it } from "vitest";
import { operationRunSchema } from "@work-shape/catalyst-api-contract";
import {
  NO_BEFORE_ACTION_CHECK,
  combineBeforeActionChecks,
  refusingWhenUnavailable,
  type BeforeActionCheck,
  type BeforeActionInput
} from "@work-shape/catalyst-core";
import { skill } from "./support/access-instance";
import { errorOf, fixture } from "./support/operation-approval";
import { narrateWorkflow } from "./support/publish-narrative";
import {
  capabilityWithCheck,
  testBeforeActionCheck,
  type TestCheckRule
} from "./support/test-before-action-check";

// The hook core keeps at every before-event (core-extraction-guardrails.md, section 3): a
// capability's check answers beside the guardrails, through the assembly, in every consumer,
// and the strictest answer of all is the event's.

const block = (on: TestCheckRule["on"], name = "planted"): TestCheckRule => ({
  on,
  outcome: "block",
  name,
  displayName: "Planted",
  reason: "Planted refusal."
});

function input(fields: () => Promise<Record<string, string>>): BeforeActionInput {
  return {
    event: "operation.before_call",
    subject: { kind: "operation", name: "testRunChange" },
    match: { operation: "testRunChange" },
    fields
  };
}

describe("combineBeforeActionChecks", () => {
  it("answers nothing without a check, and is the one check where there is one", async () => {
    const one = testBeforeActionCheck();
    expect(combineBeforeActionChecks([])).toBe(NO_BEFORE_ACTION_CHECK);
    expect(combineBeforeActionChecks([one])).toBe(one);
    expect(
      await NO_BEFORE_ACTION_CHECK.answer(
        input(() => Promise.resolve({})),
        {
          correlationId: "c"
        }
      )
    ).toEqual([]);
  });

  it("answers every check's answers in their order, and reads the fields once for all", async () => {
    let reads = 0;
    const warn = testBeforeActionCheck([
      { on: "operation.before_call", outcome: "warn", name: "first", pattern: /IBAN/u }
    ]);
    const blocks = testBeforeActionCheck([
      { ...block("operation.before_call", "second"), pattern: /IBAN/u }
    ]);
    const answers = await combineBeforeActionChecks([warn, blocks]).answer(
      input(() => {
        reads += 1;
        return Promise.resolve({ input: "an IBAN" });
      }),
      { correlationId: "c" }
    );
    expect(answers.map((answer) => [answer.guardrailName, answer.outcome])).toEqual([
      ["first", "warn"],
      ["second", "block"]
    ]);
    expect(reads).toBe(1);
  });

  it("unites the kinds the checks protect, and previews each in one session", async () => {
    const sessions: string[] = [];
    const sessioned = {
      ...testBeforeActionCheck([block("operation.before_call", "sessioned")]),
      protectedKinds: ["guardrail"],
      previewSession() {
        sessions.push("opened");
        return this;
      }
    };
    const plain = { ...testBeforeActionCheck(), protectedKinds: ["policy", "guardrail"] };
    const combined = combineBeforeActionChecks([sessioned, plain]);
    expect(combined.protectedKinds).toEqual(["guardrail", "policy"]);
    const session = combined.previewSession?.();
    expect(sessions).toEqual(["opened"]);
    const previews = await session?.preview(
      input(() => Promise.resolve({})),
      false
    );
    expect(previews).toMatchObject([{ guardrailName: "sessioned", checked: true }]);
  });

  it("refuses where one check throws: the error reaches the caller", async () => {
    const failing = testBeforeActionCheck();
    failing.failWith(new Error("The check is unavailable"));
    await expect(
      combineBeforeActionChecks([testBeforeActionCheck(), failing]).answer(
        input(() => Promise.resolve({})),
        { correlationId: "c" }
      )
    ).rejects.toThrow("The check is unavailable");
  });
});

describe("a capability's check through the assembly", () => {
  it("blocks, holds and warns a call at operation.before_call", async () => {
    const check = testBeforeActionCheck([block("operation.before_call")]);
    const t = await fixture({ capabilities: [capabilityWithCheck(check)], settings: () => [] });

    const blocked = await t.call("requester", "blocked");
    expect(blocked.statusCode).toBe(403);
    expect(errorOf(blocked)).toMatchObject({
      code: "GUARDRAIL_BLOCKED",
      details: { guardrailId: "planted" }
    });

    check.answerBy([{ on: "operation.before_call", outcome: "require_approval", name: "held" }]);
    const held = await t.call("requester", "held", "key-held");
    expect(held.statusCode).toBe(202);
    expect(operationRunSchema.parse(held.json()).approvalRequestId).toBeDefined();

    check.answerBy([{ on: "operation.before_call", outcome: "warn", name: "warned" }]);
    const warned = await t.call("requester", "warned");
    expect(warned.statusCode).toBe(200);

    expect(t.executed).toEqual(["requester:warned"]);
    expect(check.asked.map(({ input }) => input.match.operation)).toContain("testRunChange");
  });

  it("blocks and warns an asset write at asset.before_write", async () => {
    const check = testBeforeActionCheck([
      { ...block("asset.before_write"), match: { kind: "skill" }, pattern: /IBAN/u }
    ]);
    const t = await fixture({
      capabilities: [capabilityWithCheck(check)],
      settings: () => [],
      release: {
        modules: { assetManagement: { enabled: true } },
        administration: { agentConfiguration: { enabled: true, allowSkillEditing: true } }
      }
    });
    const put = (name: string, content: string) =>
      t.app.call("assets.put", {
        params: { kind: "skill", name },
        payload: { config: skill(name, content), expectedRevision: null },
        headers: t.as("approver")
      });

    const blocked = await put("blocked-skill", "Pay to this IBAN.");
    expect(blocked.statusCode).toBe(403);
    expect(errorOf(blocked)).toMatchObject({
      code: "GUARDRAIL_BLOCKED",
      details: { guardrailId: "planted" }
    });

    check.answerBy([{ on: "asset.before_write", outcome: "warn", match: { kind: "skill" } }]);
    const warned = await put("warned-skill", "Pay to this IBAN.");
    expect(warned.statusCode).toBe(200);
    const stored = (name: string) =>
      t.app.stores.configAssets.getConfigAsset({
        clientInstanceId: t.clientInstanceId,
        kind: "skill",
        name
      });
    expect(await stored("warned-skill")).toBeDefined();
    expect(await stored("blocked-skill")).toBeUndefined();
  });

  it("blocks and warns a request at approval_request.before_create", async () => {
    const check = testBeforeActionCheck([block("approval_request.before_create")]);
    const t = await fixture({ capabilities: [capabilityWithCheck(check)] });

    // As a guardrail's block there: the request is not filed, and the call does not wait.
    const blocked = await t.call("requester", "blocked", "key-blocked");
    expect(blocked.statusCode).toBe(422);
    expect(errorOf(blocked)).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Approval request blocked: Planted refusal."
    });
    expect(t.executed).toEqual([]);

    check.answerBy([{ on: "approval_request.before_create", outcome: "warn", name: "warned" }]);
    const { requestId } = await t.hold("warned", "key-warned");
    expect((await t.stored(requestId)).checks).toEqual([
      { id: "warned", status: "warned", message: "" }
    ]);
  });

  it("acts on the strictest answer of the guardrails and the capability's check", async () => {
    const check = testBeforeActionCheck([block("operation.before_call")]);
    const t = await fixture({
      capabilities: [capabilityWithCheck(check)],
      settings: () => [],
      release: {
        guardrails: {
          release_warn: {
            on: "operation.before_call",
            check: { kind: "pattern", pattern: "." },
            outcome: "warn"
          }
        }
      }
    });
    const blocked = await t.call("requester", "blocked");
    expect(blocked.statusCode).toBe(403);
    expect(errorOf(blocked)).toMatchObject({
      code: "GUARDRAIL_BLOCKED",
      details: { guardrailId: "planted" }
    });
    expect(t.executed).toEqual([]);
  });

  // Spec section 3 rule 2: a check that cannot answer refuses the action, named with the
  // reason `check_unavailable`, and nothing of it runs.
  it("refuses a call where the check throws, and never carries it out", async () => {
    const check = testBeforeActionCheck();
    check.failWith(new Error("The check is unavailable"));
    const t = await fixture({ capabilities: [capabilityWithCheck(check)], settings: () => [] });
    const refused = await t.call("requester", "refused");
    expect(refused.statusCode).toBe(403);
    expect(errorOf(refused)).toMatchObject({
      code: "GUARDRAIL_BLOCKED",
      details: { guardrailId: "operation.before_call", reason: "check_unavailable" }
    });
    expect((await t.run(String(refused.headers["operation-run-id"]))).status).toBe("denied");
    expect(t.executed).toEqual([]);
  });
});

describe("a check that cannot answer", () => {
  it("answers one block for the event where the check throws", async () => {
    const failing = testBeforeActionCheck();
    failing.failWith(new Error("The check is unavailable"));
    const answers = await refusingWhenUnavailable(failing).answer(
      input(() => Promise.resolve({})),
      { correlationId: "c" }
    );
    expect(answers).toEqual([
      expect.objectContaining({
        guardrailName: "operation.before_call",
        outcome: "block",
        unavailable: true
      })
    ]);
  });

  it("answers one block for the event where the check does not answer in time", async () => {
    const silent: BeforeActionCheck = {
      answer: () => new Promise(() => undefined),
      preview: () => Promise.resolve([])
    };
    const answers = await refusingWhenUnavailable(silent, 10).answer(
      input(() => Promise.resolve({})),
      { correlationId: "c" }
    );
    expect(answers).toMatchObject([{ outcome: "block", unavailable: true }]);
  });

  it("passes what a check answers in time through unchanged", async () => {
    const check = testBeforeActionCheck([block("operation.before_call")]);
    const answers = await refusingWhenUnavailable(check, 1000).answer(
      input(() => Promise.resolve({})),
      { correlationId: "c" }
    );
    expect(answers).toMatchObject([{ guardrailName: "planted", outcome: "block" }]);
    expect(answers[0]).not.toHaveProperty("unavailable");
  });
});

describe("the publish question with a capability's check", () => {
  it("names the step the planted check would refuse", async () => {
    const check = testBeforeActionCheck([
      {
        on: "operation.before_call",
        outcome: "block",
        name: "planted",
        displayName: "Kein Versand",
        match: { operation: "connection.outlook.send_mail" }
      }
    ]);
    const narrative = await narrateWorkflow("en", { check });
    expect(narrative.warnings).toEqual([
      "The step “Mail an Mandanten” may be refused: the guardrail “Kein Versand” blocks it when what it checks matches."
    ]);
    // Asked dry only: a preview has no call context, and nothing was answered for an action.
    expect(check.asked.length).toBeGreaterThan(0);
    expect(check.asked.every(({ context }) => context === undefined)).toBe(true);
  });
});
