import { accessOf, callerOf } from "./support/access";
import { createTestAssetKinds, createTestInstance } from "./support/test-instance";
import { ensureTestUser } from "./support/test-store";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { settleOnFakeClock, useFakeClockBesidePostgres } from "./support/fake-clock";
import {
  StoreBackedAuditRecorder,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  type ApprovalRequest,
  type ApprovalRequestHandler,
  type AuthenticatedUser,
  isJsonObject,
  unknownToJsonValue,
  type JsonObject,
  type RuntimeCallContext
} from "@vivd-catalyst/core";

import {
  GuardrailRunner,
  ApprovalRequestWorkflow,
  createSkillChangeApprovalHandler
} from "@vivd-catalyst/chat-server";
import {
  createSkillChangePreview,
  parseClientInstanceConfig,
  type ReleaseGuardrailConfig,
  type SkillChangeOperation
} from "@vivd-catalyst/config-schema";
import type { ModelCompletion } from "@vivd-catalyst/model-provider";
import {
  createScriptedInstanceModelGateway,
  type FakeModelProvider as ModelProvider
} from "./support/model-gateway";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { createProposeSkillChangeTool } from "@vivd-catalyst/tool-execution";
import { createModelVisibleToolOutput } from "../packages/agent-runtime/src/model-context-projection";
import { createConfigAssetSource } from "../packages/client-assembly/src/config-asset-source";
import { createTestConfig } from "./support/fixtures";
import { eventually } from "./support/assertions";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { withTestSql } from "./support/test-sql";

const clientInstanceId = asClientInstanceId("test-client");
const user: AuthenticatedUser = {
  id: "requester",
  externalUserId: "requester",
  displayLabel: "Requester",
  roles: ["user"],
  permissionRefs: [],
  clientInstanceId,
  authSource: "test"
};
const context: RuntimeCallContext = { user, clientInstanceId, correlationId: "check-correlation" };
const rule = { id: "no_personal_data" };
const instruction = "Prüfe, ob der neue Text personenbezogene Daten enthält.";
/** The guardrail `no_personal_data` on requests of kind `fake`, warning unless told otherwise. */
function guardrail(
  overrides: { outcome?: "warn" | "block"; kind?: string | null; instruction?: string } = {}
): ReleaseGuardrailConfig {
  const kind = overrides.kind === undefined ? "fake" : overrides.kind;
  return {
    on: "approval_request.before_create",
    ...(kind === null ? {} : { filter: { kind } }),
    check: {
      kind: "model_judge",
      modelBindingId: "guardrailCheck",
      instruction: overrides.instruction ?? instruction
    },
    outcome: overrides.outcome ?? "warn"
  };
}
const command: Pick<ApprovalRequest, "kind" | "summary" | "payload" | "origin"> = {
  kind: "fake",
  summary: "New summary",
  payload: { newText: "New content", oldText: "Private old text" },
  origin: {
    conversationId: asConversationId("conversation"),
    agentRunId: asAgentRunId("run"),
    toolCallId: asToolCallId("call"),
    agentName: "assistant"
  }
};
const handler: ApprovalRequestHandler = {
  kind: "fake",
  requiredPermission: "agent_skills.approve",
  validate: (payload) => payload,
  checkContent: (payload) => String(payload.newText),
  preview: async (payload) => payload,
  isStale: async () => false,
  apply: async () => ({})
};
function jsonObject(value: unknown): JsonObject {
  const converted = unknownToJsonValue(value);
  if (!isJsonObject(converted)) {
    throw new Error("Expected a JSON object");
  }
  return converted;
}
function completion(text: string): ModelCompletion {
  return {
    text,
    toolCalls: [],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      source: "provider_reported",
      webSearchCallCount: 0
    }
  };
}
/** The before-event the workflow raises for `command` under `handler`. */
function proposal(
  request: Pick<ApprovalRequest, "kind" | "summary" | "payload" | "origin"> = command,
  requestHandler: ApprovalRequestHandler = handler
) {
  return {
    event: "approval_request.before_create" as const,
    subjectKind: request.kind,
    fields: () => {
      const newContent = requestHandler.checkContent?.(request.payload);
      return newContent === undefined ? undefined : { summary: request.summary, newContent };
    },
    ...(request.origin ? { origin: request.origin } : {})
  };
}
async function fixture(
  guardrails: Record<string, ReleaseGuardrailConfig> = { [rule.id]: guardrail() }
) {
  const config = createTestConfig({
    modelBindings: [
      {
        id: "guardrailCheck",
        providerId: "local",
        model: "cheap-check",
        reasoningEffort: "low",
        agentSelectable: false
      }
    ]
  });
  config.guardrails = guardrails;
  const store = (await createTestInstance()).stores;
  // The requester exists: an event keeps its conversation only for a user that does.
  await ensureTestUser(clientInstanceId, user.id);
  const complete = vi
    .fn<ModelProvider["complete"]>()
    .mockResolvedValue(completion('{"violates":false,"reason":"Keine personenbezogenen Daten."}'));
  const usageGovernance = new ModelUsageGovernance({
    store: store.usage,
    budget: {},
    safeguards: {}
  });
  const runner = new GuardrailRunner({
    config,
    clientInstanceId,
    hits: store.guardrails,
    modelGateway: createScriptedInstanceModelGateway({
      config,
      modelProvider: { complete },
      usageGovernance
    })
  });
  const workflow = new ApprovalRequestWorkflow({
    clientInstanceId,
    store: store.approvals,
    handlers: new Map([[handler.kind, handler]]),
    guardrails: runner,
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: store.audit })
  });
  return { config, store, complete, runner, workflow, usageGovernance };
}
afterEach(() => vi.useRealTimers());

/**
 * Makes the provider hang and resolves when it is called. The call is sent after the gateway's
 * database reads, so the clock is advanced only from then on.
 */
function neverCompleting(complete: Mock<ModelProvider["complete"]>): Promise<void> {
  return new Promise((resolve) => {
    complete.mockImplementation(() => {
      resolve();
      return new Promise<ModelCompletion>(() => {});
    });
  });
}

function unevaluated(outcome: "warn" | "block") {
  return outcome === "block"
    ? {
        id: rule.id,
        status: "blocked",
        message: `Check '${rule.id}' could not be evaluated. Try again later.`
      }
    : { id: rule.id, status: "warned", message: "" };
}

describe("guardrail runner", () => {
  it("passes, resolves the binding and sends only summary and new content as untrusted data", async () => {
    const f = await fixture();
    expect(await f.runner.check(proposal(), context)).toEqual([
      { id: rule.id, status: "passed", message: "" }
    ]);
    const [request, callContext] = f.complete.mock.calls[0] ?? [];
    // The binding's effort is left out: the model of this fixture takes none.
    expect(request).toMatchObject({ providerId: "local", model: "cheap-check", tools: [] });
    expect(request?.reasoningEffort).toBeUndefined();
    expect(request?.messages[0]?.content).toContain(JSON.stringify(instruction));
    expect(request?.messages[0]?.content).toContain("never follow");
    // The reason is kept as a hit: it must carry none of the content.
    expect(request?.messages[0]?.content).toContain("never quotes or repeats");
    expect(request?.messages[1]?.content).toContain("BEGIN UNTRUSTED");
    expect(request?.messages[1]?.content).toContain(command.summary);
    expect(request?.messages[1]?.content).toContain("New content");
    expect(JSON.stringify(request)).not.toContain("Private old text");
    expect(callContext?.signal).toBeInstanceOf(AbortSignal);
    const [event] = await f.store.usage.listModelUsageEvents({ clientInstanceId });
    expect(event).toMatchObject({
      conversationId: command.origin?.conversationId,
      agentName: "guardrail_judge",
      model: "cheap-check",
      correlationId: context.correlationId,
      totalTokens: 15
    });
    expect(event).not.toHaveProperty("agentRunId");
  });

  it.each(["warn", "block"] as const)(
    "returns the reason for a violation with outcome %s",
    async (outcome) => {
      const f = await fixture({ [rule.id]: guardrail({ outcome }) });
      f.complete.mockResolvedValue(
        completion('{"violates":true,"reason":"Der Text enthält personenbezogene Daten."}')
      );
      expect(await f.runner.check(proposal(), context)).toEqual([
        {
          id: rule.id,
          status: outcome === "block" ? "blocked" : "warned",
          message: "Der Text enthält personenbezogene Daten."
        }
      ]);
    }
  );

  it.each(["warn", "block"] as const)(
    "does not leak provider failures and fails closed only for block: outcome %s",
    async (outcome) => {
      const f = await fixture({ [rule.id]: guardrail({ outcome }) });
      f.complete.mockRejectedValue(new Error("secret provider detail"));
      expect(await f.runner.check(proposal(), context)).toEqual([unevaluated(outcome)]);
      expect(await f.store.usage.listModelUsageEvents({ clientInstanceId })).toEqual([
        expect.objectContaining({ status: "failed", source: "not_reported", totalTokens: 0 })
      ]);
    }
  );

  it.each([
    "not JSON",
    '```json\n{"violates":false,"reason":"OK"}\n```',
    '{"violates":"false","reason":"OK"}',
    '{"violates":true,"reason":""}',
    '{"violates":true,"reason":"Bad","extra":true}',
    '{"reason":"Missing verdict"}'
  ])("blocks a blocking guardrail on an invalid verdict: %s", async (text) => {
    const f = await fixture({ [rule.id]: guardrail({ outcome: "block" }) });
    f.complete.mockResolvedValue(completion(text));
    expect(await f.runner.check(proposal(), context)).toEqual([unevaluated("block")]);
    expect(await f.store.usage.listModelUsageEvents({ clientInstanceId })).toHaveLength(1);
  });

  it.each(["warn", "block"] as const)(
    "gives a slow check 60 seconds, then bounds a provider that ignores cancellation with outcome %s",
    async (outcome) => {
      const f = await fixture({ [rule.id]: guardrail({ outcome }) });
      const called = neverCompleting(f.complete);
      useFakeClockBesidePostgres();
      const startedAt = Date.now();
      const result = f.runner.check(proposal(), context);
      await settleOnFakeClock(called);
      // No caller sets a deadline on the context, so the runner's own limit is the effective one.
      const deadline = f.complete.mock.calls[0]?.[1].deadline?.getTime() ?? 0;
      expect(deadline - startedAt).toBeGreaterThanOrEqual(60_000);
      expect(deadline - startedAt).toBeLessThan(60_100);
      await vi.advanceTimersByTimeAsync(deadline - Date.now() - 1_000);
      expect(f.complete.mock.calls[0]?.[1].signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await settleOnFakeClock(result)).toEqual([
        outcome === "block"
          ? {
              id: rule.id,
              status: "blocked",
              message: `Check '${rule.id}' did not answer within 60 seconds. Try again later.`
            }
          : unevaluated("warn")
      ]);
      vi.useRealTimers();
      expect(f.complete.mock.calls[0]?.[1].signal?.aborted).toBe(true);
      expect(await f.store.usage.listModelUsageEvents({ clientInstanceId })).toEqual([
        expect.objectContaining({ agentName: "guardrail_judge", totalTokens: 0 })
      ]);
    }
  );

  it("honors an earlier caller deadline", async () => {
    const f = await fixture();
    const called = neverCompleting(f.complete);
    useFakeClockBesidePostgres();
    const result = f.runner.check(proposal(), {
      ...context,
      deadline: new Date(Date.now() + 100)
    });
    await settleOnFakeClock(called);
    await vi.advanceTimersByTimeAsync(100);
    expect((await settleOnFakeClock(result))[0]?.status).toBe("warned");
  });

  it("runs checks concurrently, retains configured order and isolates a failed check", async () => {
    const second = { instruction: "Second instruction." };
    const f = await fixture({
      [rule.id]: guardrail(),
      second: guardrail({ outcome: "block", instruction: second.instruction })
    });
    let releaseFirst: ((value: ModelCompletion) => void) | undefined;
    let releaseSecond: ((value: ModelCompletion) => void) | undefined;
    // Which check reaches the model first is not fixed: each is admitted in the database
    // before it is sent. The request says which one it is.
    f.complete.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          if (JSON.stringify(request.messages).includes(second.instruction)) {
            releaseSecond = resolve;
          } else {
            releaseFirst = resolve;
          }
        })
    );
    const pending = f.runner.check(proposal(), context);
    await eventually(() => expect(f.complete).toHaveBeenCalledTimes(2));
    releaseSecond?.(completion("invalid"));
    releaseFirst?.(completion('{"violates":false,"reason":"OK"}'));
    expect(await pending).toEqual([
      { id: rule.id, status: "passed", message: "" },
      {
        id: "second",
        status: "blocked",
        message: "Check 'second' could not be evaluated. Try again later."
      }
    ]);
    expect(await f.store.usage.listModelUsageEvents({ clientInstanceId })).toHaveLength(2);
  });

  it("ignores guardrails for another kind, empty configuration, and handlers without checkContent", async () => {
    const f = await fixture({ [rule.id]: guardrail({ kind: "other" }) });
    expect(await f.runner.check(proposal(), context)).toEqual([]);
    f.config.guardrails = {};
    expect(await f.runner.check(proposal(), context)).toEqual([]);
    f.config.guardrails = { [rule.id]: guardrail() };
    const { checkContent: _checkContent, ...withoutContent } = handler;
    expect(await f.runner.check(proposal(command, withoutContent), context)).toEqual([]);
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("applies a guardrail without a filter to every kind of request", async () => {
    const f = await fixture({ [rule.id]: guardrail({ kind: null }) });
    expect(await f.runner.check(proposal({ ...command, kind: "other" }), context)).toEqual([
      { id: rule.id, status: "passed", message: "" }
    ]);
  });

  it("keeps a hit for each warning and block, naming neither the person nor the content", async () => {
    const f = await fixture({
      [rule.id]: guardrail({ instruction: "warns" }),
      blocking: guardrail({ outcome: "block", instruction: "blocks" }),
      passing: guardrail({ instruction: "passes" }),
      silent: guardrail({ instruction: "cannot run" })
    });
    f.complete.mockImplementation(async (request) => {
      const rules = JSON.stringify(request.messages[0]?.content);
      if (rules.includes("cannot run")) throw new Error("Unavailable");
      return completion(
        rules.includes("passes")
          ? '{"violates":false,"reason":"OK"}'
          : '{"violates":true,"reason":"Personal data."}'
      );
    });
    await f.runner.check(proposal(), context);
    const hits = async (guardrailName: string) =>
      f.store.guardrails.listHits({ clientInstanceId, guardrailName, limit: 10 });
    expect(await hits(rule.id)).toEqual([
      {
        id: expect.any(String),
        guardrailName: rule.id,
        event: "approval_request.before_create",
        outcome: "warn",
        message: "Personal data.",
        subjectKind: "fake",
        createdAt: expect.any(String)
      }
    ]);
    expect(await hits("blocking")).toEqual([
      expect.objectContaining({ outcome: "block", message: "Personal data." })
    ]);
    expect(await hits("passing")).toEqual([]);
    // A warning guardrail that could not run is a hit without a reason.
    expect(await hits("silent")).toEqual([
      expect.objectContaining({ outcome: "warn", message: "" })
    ]);
    const kept = JSON.stringify(await hits(rule.id));
    expect(kept).not.toContain("New content");
    expect(kept).not.toContain(user.id);
    expect(kept).not.toContain(user.displayLabel);
    // The table has no column for a person.
    const columns = await withTestSql(
      (sql) => sql<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_name = 'guardrail_hits'`
    );
    expect(columns.map((column) => column.column_name).sort()).toEqual([
      "client_instance_id",
      "created_at",
      "event",
      "guardrail_name",
      "id",
      "message",
      "outcome",
      "subject_id",
      "subject_kind",
      "subject_name"
    ]);
  });

  it("judges a legacy approval check exactly as the guardrail it becomes", async () => {
    const legacy = parseClientInstanceConfig({
      clientInstance: { id: "legacy", displayName: "Legacy" },
      infrastructure: { models: { local: { provider: "deterministic" } } },
      modelBindings: [{ id: "guardrailCheck", providerId: "local", agentSelectable: false }],
      approvalChecks: [
        {
          id: rule.id,
          appliesTo: "fake",
          modelBindingId: "guardrailCheck",
          instruction,
          onFail: "warn"
        }
      ]
    });
    expect(legacy.guardrails).toEqual({ [rule.id]: guardrail() });
    const translated = await fixture(legacy.guardrails);
    const current = await fixture();
    for (const f of [translated, current]) {
      f.complete.mockResolvedValue(completion('{"violates":true,"reason":"Personal data."}'));
    }
    const results = [
      await translated.runner.check(proposal(), context),
      await current.runner.check(proposal(), context)
    ];
    expect(results[0]).toEqual(results[1]);
    expect(translated.complete.mock.calls[0]?.[0].messages).toEqual(
      current.complete.mock.calls[0]?.[0].messages
    );
    // One check, run once: the old key leaves no second check beside the guardrail.
    expect(translated.complete).toHaveBeenCalledTimes(1);
  });

  it("evaluates a request without origin and records its usage without a conversation", async () => {
    const f = await fixture();
    expect(
      (await f.runner.check(proposal({ ...command, origin: undefined }), context))[0]?.status
    ).toBe("passed");
    expect(f.complete).toHaveBeenCalledTimes(1);
    const events = await f.store.usage.listModelUsageEvents({ clientInstanceId });
    expect(events).toEqual([
      expect.objectContaining({ agentName: "guardrail_judge", totalTokens: 15 })
    ]);
    expect(events[0]).not.toHaveProperty("conversationId");
    expect(events[0]).not.toHaveProperty("agentRunId");
  });
});

describe("guardrails before an approval request is filed", () => {
  it("blocks before persistence and surfaces the reason without a creation audit", async () => {
    const f = await fixture({ [rule.id]: guardrail({ outcome: "block" }) });
    f.complete.mockResolvedValue(
      completion('{"violates":true,"reason":"Remove the personal data."}')
    );
    const create = vi.spyOn(f.store.approvals, "createApprovalRequest");
    await expect(f.workflow.createRequest(user, context, command)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Approval request blocked: Remove the personal data."
    });
    expect(create).not.toHaveBeenCalled();
    expect(
      await f.store.approvals.listApprovalRequests({ clientInstanceId, kinds: [command.kind] })
    ).toEqual([]);
    expect(await f.store.audit.listAuditEvents({ clientInstanceId })).toEqual([]);
    expect(await f.store.usage.listModelUsageEvents({ clientInstanceId })).toHaveLength(1);
  });

  it("does not let a proposal past a blocking rule when usage storage fails", async () => {
    const f = await fixture({ [rule.id]: guardrail({ outcome: "block" }) });
    f.complete.mockResolvedValue(
      completion('{"violates":false,"reason":"Keine personenbezogenen Daten."}')
    );
    vi.spyOn(f.usageGovernance, "settleModelCall").mockRejectedValueOnce(
      new Error("Storage unavailable")
    );
    // An answer whose usage could not be recorded is no answer: the rule was not evaluated.
    await expect(f.workflow.createRequest(user, context, command)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: `Approval request blocked: Check '${rule.id}' could not be evaluated. Try again later.`
    });
    expect(
      await f.store.approvals.listApprovalRequests({ clientInstanceId, kinds: [command.kind] })
    ).toEqual([]);
  });

  it("stores warnings, exposes them in views, and audits only check ids and statuses", async () => {
    const f = await fixture();
    f.complete.mockResolvedValue(
      completion('{"violates":true,"reason":"Remove the personal data."}')
    );
    const request = await f.workflow.createRequest(user, context, command);
    const checks = [{ id: rule.id, status: "warned", message: "Remove the personal data." }];
    expect(request.checks).toEqual(checks);
    expect(await f.workflow.getRequest(user, accessOf(user), context, request.id)).toMatchObject({
      checks
    });
    expect(
      await f.store.approvals.getApprovalRequest({ clientInstanceId, requestId: request.id })
    ).toMatchObject({ checks });
    expect((await f.store.audit.listAuditEvents({ clientInstanceId }))[0]?.metadata).toEqual({
      requestId: request.id,
      kind: command.kind,
      status: "pending",
      checks: [{ id: rule.id, status: "warned" }]
    });
    await f.workflow.decideRequest(
      ...callerOf({ ...user, permissions: ["agent_skills.approve"] }),
      context,
      {
        requestId: request.id,
        decision: "approve"
      }
    );
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it("stores passed checks and refuses creation when a block rule cannot be evaluated", async () => {
    const f = await fixture({ [rule.id]: guardrail({ outcome: "block" }) });
    expect((await f.workflow.createRequest(user, context, command)).checks[0]?.status).toBe(
      "passed"
    );
    f.complete.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(f.workflow.createRequest(user, context, command)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: `Approval request blocked: Check '${rule.id}' could not be evaluated. Try again later.`
    });
    expect(
      await f.store.approvals.listApprovalRequests({ clientInstanceId, kinds: [command.kind] })
    ).toHaveLength(1);
  });

  it("stores a neutral warning when a warn rule cannot be evaluated", async () => {
    const f = await fixture();
    f.complete.mockRejectedValueOnce(new Error("Unavailable"));
    const request = await f.workflow.createRequest(user, context, command);
    expect(await f.workflow.getRequest(user, accessOf(user), context, request.id)).toMatchObject({
      status: "pending",
      checks: [{ id: rule.id, status: "warned", message: "" }]
    });
  });
});

async function skillFixture() {
  const f = await fixture({
    [rule.id]: guardrail({ kind: "skill_change", outcome: "block" })
  });
  f.config.administration.agentConfiguration.agentSkillChanges = {
    enabled: true,
    allowSkillCreation: true
  };
  const skill = {
    name: "review",
    title: "Existing title",
    description: "Existing description",
    content: "Private old text",
    resources: []
  };
  const agent = {
    name: "assistant",
    displayName: "Assistant",
    instructions: "Help",
    toolNames: ["propose_skill_change"],
    skillNames: [skill.name],
    initialPrompts: []
  };
  await applyAtCurrentRevisions(f.store.configAssets, {
    clientInstanceId,
    mutations: [
      { type: "upsert", kind: "skill", name: skill.name, config: skill },
      { type: "upsert", kind: "agent", name: agent.name, config: agent }
    ]
  });
  const source = createConfigAssetSource({ store: f.store.configAssets, clientInstanceId });
  const validationRefs = {
    modelProviderIds: ["local"],
    modelBindingIds: ["guardrailCheck"],
    modelBindings: [{ id: "guardrailCheck", model: "cheap-check" }],
    fastModeModelBindingIds: [],
    reasoningEfforts: ["low"],
    enabledToolNames: ["propose_skill_change"]
  };
  const skillHandler = createSkillChangeApprovalHandler({
    config: f.config,
    clientInstanceId,
    configAssets: {
      store: f.store.configAssets,
      source,
      kinds: createTestAssetKinds({ config: f.config, validationRefs }),
      validationRefs
    }
  });
  const workflow = new ApprovalRequestWorkflow({
    clientInstanceId,
    store: f.store.approvals,
    handlers: new Map([[skillHandler.kind, skillHandler]]),
    guardrails: f.runner,
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: f.store.audit })
  });
  const tool = createProposeSkillChangeTool({
    assetSource: source,
    policy: f.config.administration.agentConfiguration.agentSkillChanges,
    creator: workflow
  });
  return { ...f, skill, skillHandler, tool, workflow };
}

describe("guardrails on a skill change", () => {
  it("extracts new text for every operation, excluding old text and the existing preview", async () => {
    const f = await skillFixture();
    const operations: SkillChangeOperation[] = [
      { type: "replace_text", target: "root", oldText: "Private old text", newText: "Replacement" },
      { type: "append_text", target: "root", text: "Addition" },
      { type: "create_resource", resourcePath: "references/new.md", content: "Resource content" }
    ];
    const payload = f.skillHandler.validate(
      jsonObject({
        agentName: "assistant",
        skillName: f.skill.name,
        operations,
        baseSourceVersion: `sha256:${"0".repeat(64)}`,
        preview: createSkillChangePreview(f.skill, operations)
      })
    );
    const content = f.skillHandler.checkContent?.(payload);
    for (const expected of ["Replacement", "Addition", "Resource content"]) {
      expect(content).toContain(expected);
    }
    expect(content).not.toContain("Private old text");
    expect(content).not.toContain("Existing title");
    expect(content).not.toContain("Existing description");
    const creation = {
      type: "create_skill" as const,
      name: "new_skill",
      title: "New title",
      description: "New description",
      content: "New body"
    };
    const newPayload = f.skillHandler.validate(
      jsonObject({
        agentName: "assistant",
        skillName: "new_skill",
        operations: [creation],
        baseSourceVersion: null,
        preview: createSkillChangePreview(undefined, [creation])
      })
    );
    for (const expected of ["New title", "New description", "New body"]) {
      expect(f.skillHandler.checkContent?.(newPayload)).toContain(expected);
    }
  });

  // Fails without the change: a guardrail on `asset.before_write` never saw a skill an agent
  // proposed, and the approval wrote it.
  it("hands asset.before_write the skill as the change would write it", async () => {
    const f = await skillFixture();
    const events =
      (await f.tool.beforeEvents?.(
        {
          skillName: f.skill.name,
          summary: "Bank details",
          operations: [
            {
              type: "replace_text",
              target: "root",
              oldText: "Private old text",
              newText: "Überweise an DE89 3704 0044 0532 0130 00."
            }
          ]
        },
        { conversationId: asConversationId("conversation") }
      )) ?? [];
    expect(events.map((event) => [event.name, event.subject])).toEqual([
      ["asset.before_write", { kind: "skill", name: f.skill.name }]
    ]);
    const fields = await events[0]?.checkable();
    expect(fields?.name).toBe(f.skill.name);
    expect(fields?.content).toContain("DE89 3704 0044 0532 0130 00");
    expect(fields?.content).toContain("Existing title");
    expect(fields?.content).not.toContain("Private old text");
  });

  it("returns a model-readable blocked proposal failure and stores no request or asset change", async () => {
    const f = await skillFixture();
    f.complete.mockResolvedValue(
      completion('{"violates":true,"reason":"Remove the personal data."}')
    );
    const result = await f.tool.execute(
      {
        skillName: f.skill.name,
        summary: "A new instruction",
        operations: [
          {
            type: "replace_text",
            target: "root",
            oldText: "Private old text",
            newText: "New content"
          }
        ]
      },
      {
        ...context,
        toolRequest: {
          agentName: "assistant",
          conversationId: asConversationId("conversation"),
          agentRunId: asAgentRunId("run"),
          toolCallId: asToolCallId("call"),
          toolName: "propose_skill_change",
          input: {}
        }
      }
    );
    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "validation_failed",
        message: "Approval request blocked: Remove the personal data."
      }
    });
    expect(
      (await createModelVisibleToolOutput(result, { toolOutput: { maxTokens: 1000 } })).text
    ).toContain("Remove the personal data.");
    expect(
      await f.store.approvals.listApprovalRequests({ clientInstanceId, kinds: ["skill_change"] })
    ).toEqual([]);
    expect(
      await f.store.configAssets.listConfigAssetRevisions({
        clientInstanceId,
        kind: "skill",
        name: f.skill.name
      })
    ).toHaveLength(1);
    expect(JSON.stringify(f.complete.mock.calls[0]?.[0].messages)).not.toContain(
      "Private old text"
    );
  });
});
