import { builtInModelCapabilities } from "./support/model-gateway";
import { createTestInstance, getTestExecution } from "./support/test-instance";
import { describe, expect, it, vi } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  isJsonObject,
  StoreBackedAuditRecorder,
  unknownToJsonValue,
  type AuthenticatedUser,
  type JsonObject,
  type SkillConfig
} from "@vivd-catalyst/core";

import {
  agentConfigSchema,
  createSkillChangePreview,
  getModelProviderConfigs,
  type SkillChangeOperation
} from "@vivd-catalyst/config-schema";
import {
  ApprovalRequestWorkflow,
  createSkillChangeApprovalHandler
} from "@vivd-catalyst/chat-server";
import {
  createProposeSkillChangeTool,
  createSkillSourceVersion
} from "@vivd-catalyst/tool-execution";

import { createConfigAssetSource } from "../packages/client-assembly/src/config-asset-source";
import { findConfigAssetAgentValidationIssues } from "../packages/client-assembly/src/assembly-validation";
import { createSystemInstructions } from "../packages/agent-runtime/src/system-instructions";
import { createTestConfig } from "./support/fixtures";

const clientInstanceId = asClientInstanceId("test-client");
const requester: AuthenticatedUser = {
  id: "requester",
  externalUserId: "requester",
  displayLabel: "Requester",
  roles: ["user"],
  permissionRefs: [],
  clientInstanceId,
  authSource: "test"
};
const reviewer: AuthenticatedUser = {
  ...requester,
  id: "reviewer",
  displayLabel: "Reviewer",
  permissions: ["agent_skills.approve"]
};
const context = { correlationId: "skill-test" };
const skill: SkillConfig = {
  name: "review",
  title: "Review",
  description: "Review guidance",
  content: "Check facts.\n\nKeep evidence."
};
const operations: SkillChangeOperation[] = [
  { type: "replace_text", target: "root", oldText: "Check", newText: "Verify" }
];
const creation: SkillChangeOperation[] = [
  {
    type: "create_skill",
    name: "new_skill",
    title: "New skill",
    description: "New guidance",
    content: "Ask for evidence."
  }
];
function json(input: unknown): JsonObject {
  const value = unknownToJsonValue(input);
  if (!isJsonObject(value)) throw new Error("Expected object");
  return value;
}
async function fixture() {
  const config = createTestConfig({
    tools: [{ name: "read_skill" }, { name: "propose_skill_change" }]
  });
  config.administration.agentConfiguration.agentSkillChanges = {
    enabled: true,
    allowSkillCreation: true
  };
  const store = (await createTestInstance()).stores;
  const agent = agentConfigSchema.parse({
    name: "assistant",
    displayName: "Assistant",
    instructions: "Help users",
    toolNames: ["read_skill", "propose_skill_change"],
    skillNames: [skill.name]
  });
  await store.configAssets.applyConfigAssetMutations({
    clientInstanceId,
    mutations: [
      { type: "upsert", kind: "agent", name: agent.name, config: json(agent) },
      { type: "upsert", kind: "skill", name: skill.name, config: json(skill) },
      { type: "setDefaultAgent", agentName: agent.name }
    ]
  });
  const source = createConfigAssetSource({ store: store.configAssets, clientInstanceId });
  const handler = createSkillChangeApprovalHandler({
    config,
    clientInstanceId,
    configAssets: {
      store: store.configAssets,
      source,
      validationRefs: {
        modelProviderIds: getModelProviderConfigs(config).map((provider) => provider.id),
        modelBindingIds: [],
        modelBindings: [],
        fastModeModelBindingIds: [],
        reasoningEfforts: [],
        enabledToolNames: ["read_skill", "propose_skill_change"]
      }
    }
  });
  const onDecided = vi.fn();
  const workflow = new ApprovalRequestWorkflow({
    clientInstanceId,
    store: store.approvals,
    handlers: new Map([[handler.kind, handler]]),
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: store.audit }),
    onDecided
  });
  const propose = (ops = operations, name = skill.name) =>
    workflow.createRequest(requester, context, {
      kind: "skill_change",
      summary: "Verify facts carefully.",
      payload: json({
        agentName: agent.name,
        skillName: name,
        operations: ops,
        baseSourceVersion: ops[0]?.type === "create_skill" ? null : createSkillSourceVersion(skill),
        preview: createSkillChangePreview(ops[0]?.type === "create_skill" ? undefined : skill, ops)
      })
    });
  const approve = (requestId: string) =>
    workflow.decideRequest(reviewer, context, { requestId, decision: "approve" });
  const revisions = (name = skill.name, kind: "agent" | "skill" = "skill") =>
    store.configAssets.listConfigAssetRevisions({ clientInstanceId, kind, name });
  const tool = createProposeSkillChangeTool({
    assetSource: source,
    policy: config.administration.agentConfiguration.agentSkillChanges,
    creator: workflow
  });
  const toolContext = {
    ...context,
    user: requester,
    clientInstanceId,
    toolRequest: {
      agentName: agent.name,
      agentRunId: asAgentRunId("run"),
      conversationId: asConversationId("conversation"),
      toolCallId: asToolCallId("call"),
      toolName: tool.name,
      input: {}
    }
  };
  return {
    config,
    store,
    source,
    handler,
    workflow,
    propose,
    approve,
    revisions,
    agent,
    onDecided,
    tool,
    toolContext
  };
}

describe("skill change approval workflow", () => {
  it("applies as the approver with provenance despite disabled interactive administration, then reverts", async () => {
    const f = await fixture();
    expect(f.config.administration.agentConfiguration.allowSkillEditing).toBe(false);
    const request = await f.propose();
    const approved = await f.approve(request.id);
    expect(approved).toMatchObject({
      status: "approved",
      applyResult: { skillName: skill.name, revision: 2, version: 2 }
    });
    expect((await f.revisions()).at(-1)).toMatchObject({
      actor: { userId: reviewer.id },
      origin: { kind: "approval_request", requestId: request.id, summary: request.summary },
      config: { content: "Verify facts.\n\nKeep evidence." }
    });
    expect(await f.workflow.getRequest(reviewer, context, request.id)).toMatchObject({
      canRevert: true,
      preview: request.payload.preview
    });
    expect(await f.workflow.getRequest(requester, context, request.id)).toMatchObject({
      canRevert: false
    });
    await expect(f.workflow.revertRequest(requester, context, request.id)).rejects.toMatchObject({
      code: "FORBIDDEN"
    });
    const reverted = await f.workflow.revertRequest(reviewer, context, request.id);
    expect(reverted).toMatchObject({
      status: "reverted",
      reversion: { revertedBy: reviewer.id, revertedByLabel: reviewer.displayLabel },
      applyResult: approved.applyResult
    });
    expect((await f.revisions()).at(-1)).toMatchObject({
      operation: "revert",
      config: { content: skill.content },
      actor: { userId: reviewer.id },
      origin: { requestId: request.id }
    });
    expect(f.onDecided).toHaveBeenLastCalledWith(reverted);
    expect(
      (await f.store.audit.listAuditEvents({ clientInstanceId })).find(
        (event) => event.type === "approval_request.reverted"
      )
    ).toMatchObject({
      type: "approval_request.reverted",
      metadata: { requestId: request.id, kind: "skill_change", status: "reverted" }
    });
    await expect(f.workflow.revertRequest(reviewer, context, request.id)).rejects.toMatchObject({
      code: "CONFLICT"
    });
  });
  it("approves independent pending changes to different paragraphs in sequence", async () => {
    const f = await fixture();
    const first = await f.propose();
    const second = await f.propose([
      { type: "replace_text", target: "root", oldText: "Keep", newText: "Retain" }
    ]);
    expect(await f.approve(first.id)).toMatchObject({ status: "approved" });
    expect(await f.approve(second.id)).toMatchObject({ status: "approved" });
    expect((await f.revisions()).at(-1)?.config?.content).toBe("Verify facts.\n\nRetain evidence.");
    expect(await f.revisions()).toHaveLength(3);
  });

  it("refreshes a pending preview with the current paragraph while the operation still applies", async () => {
    const f = await fixture();
    const first = await f.propose([
      { type: "replace_text", target: "root", oldText: "facts", newText: "sources" }
    ]);
    const second = await f.propose();
    await f.approve(first.id);
    expect(await f.workflow.getRequest(reviewer, context, second.id)).toMatchObject({
      preview: { changes: [{ before: "Check sources.", after: "Verify sources." }] }
    });
    expect(await f.approve(second.id)).toMatchObject({ status: "approved" });
    expect((await f.revisions()).at(-1)?.config?.content).toBe("Verify sources.\n\nKeep evidence.");
  });

  it("supersedes a pending replacement when another approved request changed its oldText", async () => {
    const f = await fixture();
    const first = await f.propose();
    const second = await f.propose([
      { type: "replace_text", target: "root", oldText: "Check", newText: "Examine" }
    ]);
    await f.approve(first.id);
    expect(await f.workflow.getRequest(reviewer, context, second.id)).toMatchObject({
      preview: second.payload.preview
    });
    expect(await f.approve(second.id)).toMatchObject({ status: "superseded" });
    expect(await f.revisions()).toHaveLength(2);
  });

  it("supersedes a pending skill creation when another request created the same name", async () => {
    const f = await fixture();
    const first = await f.propose(creation, "new_skill");
    const second = await f.propose(creation, "new_skill");
    await f.approve(first.id);
    expect(await f.approve(second.id)).toMatchObject({ status: "superseded" });
    expect(await f.revisions("new_skill")).toHaveLength(1);
  });

  it("supersedes a stale proposal and keeps its original preview readable", async () => {
    const f = await fixture();
    const request = await f.propose();
    await f.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: skill.name,
          config: json({ ...skill, content: "Other content" })
        }
      ]
    });
    expect(await f.workflow.getRequest(reviewer, context, request.id)).toMatchObject({
      preview: request.payload.preview
    });
    expect(await f.approve(request.id)).toMatchObject({ status: "superseded" });
    expect(await f.revisions()).toHaveLength(2);
  });
  it("refuses approval while the policy or skill creation is disabled", async () => {
    const f = await fixture();
    const request = await f.propose();
    f.config.administration.agentConfiguration.agentSkillChanges.enabled = false;
    await expect(f.approve(request.id)).rejects.toThrow("disabled");
    f.config.administration.agentConfiguration.agentSkillChanges.enabled = true;
    const newRequest = await f.propose(creation, "new_skill");
    f.config.administration.agentConfiguration.agentSkillChanges.allowSkillCreation = false;
    await expect(f.approve(newRequest.id)).rejects.toThrow("creation is disabled");
    expect(await f.revisions()).toHaveLength(1);
  });
  it("supersedes a request whose skill was detached or whose agent was deleted", async () => {
    const f = await fixture();
    const detached = await f.propose();
    const orphaned = await f.propose();
    const orphanedCreation = await f.propose(creation, "new_skill");
    await f.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: f.agent.name,
          config: json({ ...f.agent, skillNames: [] })
        }
      ]
    });
    expect(await f.approve(detached.id)).toMatchObject({ status: "superseded" });
    await f.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      mutations: [
        { type: "delete", kind: "agent", name: f.agent.name },
        { type: "setDefaultAgent", agentName: undefined }
      ]
    });
    expect(await f.approve(orphaned.id)).toMatchObject({ status: "superseded" });
    expect(await f.approve(orphanedCreation.id)).toMatchObject({ status: "superseded" });
    expect(await f.revisions()).toHaveLength(1);
  });
  it("recovers an interrupted approval after the skill was detached and refuses to reject or withdraw it", async () => {
    const f = await fixture();
    const request = await f.propose();
    const handlerContext = {
      ...context,
      clientInstanceId,
      requestId: request.id,
      summary: request.summary
    };
    const applied = await f.handler.apply(request.payload, reviewer, handlerContext);
    await f.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: f.agent.name,
          config: json({ ...f.agent, skillNames: [] })
        }
      ]
    });
    await expect(
      f.workflow.decideRequest(reviewer, context, { requestId: request.id, decision: "reject" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      f.workflow.decideRequest(reviewer, context, {
        requestId: request.id,
        decision: "request_changes",
        comment: "Please shorten"
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(f.workflow.withdrawRequest(requester, context, request.id)).rejects.toMatchObject({
      code: "CONFLICT"
    });
    expect(await f.approve(request.id)).toMatchObject({
      status: "approved",
      applyResult: applied
    });
    expect(await f.revisions()).toHaveLength(2);
  });
  it("creates and removes a skill and agent reference in one versioned batch each", async () => {
    const f = await fixture();
    const request = await f.propose(creation, "new_skill");
    await f.approve(request.id);
    const snapshot = await f.source.getSnapshot();
    expect(snapshot.agents[0]?.skillNames).toEqual([skill.name, "new_skill"]);
    const newRevision = (await f.revisions("new_skill"))[0];
    expect((await f.revisions(f.agent.name, "agent")).at(-1)).toMatchObject({
      globalVersion: newRevision?.globalVersion,
      actor: { userId: reviewer.id },
      origin: { requestId: request.id }
    });
    await f.workflow.revertRequest(reviewer, context, request.id);
    expect((await f.source.getSnapshot()).agents[0]?.skillNames).toEqual([skill.name]);
    expect((await f.source.getSnapshot()).skills.map((candidate) => candidate.name)).toEqual([
      skill.name
    ]);
    expect((await f.revisions("new_skill")).at(-1)).toMatchObject({
      operation: "delete",
      globalVersion: 3,
      origin: { requestId: request.id },
      actor: { userId: reviewer.id }
    });
    expect((await f.revisions(f.agent.name, "agent")).at(-1)?.globalVersion).toBe(3);
  });
  it("returns the original result when reapplied and recovers a pending request after an interrupted transition", async () => {
    const f = await fixture();
    const request = await f.propose();
    const handlerContext = {
      ...context,
      clientInstanceId,
      requestId: request.id,
      summary: request.summary
    };
    const first = await f.handler.apply(request.payload, reviewer, handlerContext);
    expect(await f.handler.apply(request.payload, reviewer, handlerContext)).toEqual(first);
    expect(await f.approve(request.id)).toMatchObject({ status: "approved", applyResult: first });
    expect(await f.revisions()).toHaveLength(2);
    const approved = await f.store.approvals.getApprovalRequest({
      clientInstanceId,
      requestId: request.id
    });
    if (!approved || !f.handler.revert) {
      throw new Error("Expected an approved request and revert handler");
    }
    await f.handler.revert(approved, reviewer, handlerContext);
    expect(await f.workflow.revertRequest(reviewer, context, request.id)).toMatchObject({
      status: "reverted"
    });
    expect(await f.revisions()).toHaveLength(3);
  });
  it("does not overwrite a concurrent revision while reading the mutation snapshot", async () => {
    const f = await fixture();
    const request = await f.propose();
    const snapshot = await f.source.getSnapshot();
    vi.spyOn(f.source, "getSnapshot").mockImplementationOnce(async () => {
      const updated = await f.store.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          {
            type: "upsert",
            kind: "skill",
            name: skill.name,
            config: json({ ...skill, content: "Concurrent work" })
          }
        ]
      });
      return { ...snapshot, version: updated.version };
    });
    await expect(
      f.handler.apply(request.payload, reviewer, {
        ...context,
        clientInstanceId,
        requestId: request.id,
        summary: request.summary
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await f.revisions()).at(-1)?.config?.content).toBe("Concurrent work");
    expect(await f.revisions()).toHaveLength(2);
  });

  it("blocks revert when newer skill revisions exist", async () => {
    const f = await fixture();
    const request = await f.propose();
    await f.approve(request.id);
    await f.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: skill.name,
          config: json({ ...skill, content: "Newer work" })
        }
      ]
    });
    await expect(f.workflow.revertRequest(reviewer, context, request.id)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("newer changes")
    });
    expect((await f.workflow.getRequest(reviewer, context, request.id)).status).toBe("approved");
  });
  it("does not partially remove a created skill referenced by another agent", async () => {
    const f = await fixture();
    const request = await f.propose(creation, "new_skill");
    await f.approve(request.id);
    await f.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "other",
          config: json({ ...f.agent, name: "other", skillNames: ["new_skill"] })
        }
      ]
    });
    await expect(f.workflow.revertRequest(reviewer, context, request.id)).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });
    expect(
      (await f.source.getSnapshot()).agents.find((candidate) => candidate.name === f.agent.name)
        ?.skillNames
    ).toContain("new_skill");
    expect(await f.revisions("new_skill")).toHaveLength(1);
  });
  it("allows only one concurrent revert", async () => {
    const f = await fixture();
    const request = await f.propose();
    await f.approve(request.id);
    const outcomes = await Promise.allSettled([
      f.workflow.revertRequest(reviewer, context, request.id),
      f.workflow.revertRequest(reviewer, context, request.id)
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await f.revisions()).toHaveLength(3);
  });
});

describe("skill change tool and wiring policy", () => {
  it("creates a pending request with an inline display and minimized audit summary", async () => {
    const f = await fixture();
    const result = await f.tool.execute(
      { skillName: skill.name, summary: "Verify facts.", operations },
      f.toolContext
    );
    expect(result).toMatchObject({
      status: "success",
      output: { status: "pending", message: expect.stringContaining("NOT active") },
      display: {
        kind: "catalyst.approval_request",
        version: 1,
        mode: "inline",
        data: { kind: "skill_change" }
      }
    });
    if (result.status !== "success") throw new Error("Expected success");
    const requestId = (result.output as { requestId: string }).requestId;
    expect(result.auditSummary?.metadata).toEqual({ skillName: skill.name, requestId });
    expect(await f.workflow.getRequest(requester, context, requestId)).toMatchObject({
      status: "pending",
      origin: {
        agentName: f.agent.name,
        toolCallId: "call",
        agentRunId: "run",
        conversationId: "conversation"
      },
      requestedBy: { id: requester.id },
      preview: { changes: [{ before: "Check facts.", after: "Verify facts." }] }
    });
    expect(await f.revisions()).toHaveLength(1);
  });
  it("returns precise nonunique-match errors and rejects disabled policy before creating requests", async () => {
    const f = await fixture();
    expect(
      await f.tool.execute(
        {
          skillName: skill.name,
          summary: "Update.",
          operations: [{ type: "replace_text", target: "root", oldText: "e", newText: "E" }]
        },
        f.toolContext
      )
    ).toMatchObject({
      status: "failed",
      error: { code: "validation_failed", message: expect.stringContaining("exactly once") }
    });
    f.config.administration.agentConfiguration.agentSkillChanges.enabled = false;
    expect(
      await f.tool.execute({ skillName: skill.name, summary: "Update.", operations }, f.toolContext)
    ).toMatchObject({
      status: "failed",
      error: { code: "not_allowed", message: expect.stringContaining("disabled") }
    });
    expect((await f.workflow.pendingCount(reviewer)).count).toBe(0);
  });
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false]
  ])("includes instructions only with policy %s and tool %s", (enabled, toolPresent) => {
    const content = createSystemInstructions("Help", "en", {
      agentSkillChangesEnabled: enabled,
      agentToolNames: toolPresent ? ["propose_skill_change"] : []
    });
    expect(content.includes("Skill change proposals:")).toBe(enabled && toolPresent);
  });
  it("registers the built-in handler and tool in the execution assembly", async () => {
    const config = createTestConfig({
      tools: [{ name: "read_skill" }, { name: "propose_skill_change" }]
    });
    config.administration.agentConfiguration.agentSkillChanges.enabled = true;
    const assembly = await createTestInstance({
      execution: {
        config,
        tools: [],
        env: {}
      }
    }).then(getTestExecution);
    try {
      expect(assembly.approvalRequestHandlers.get("skill_change")?.requiredPermission).toBe(
        "agent_skills.approve"
      );
      expect(
        assembly.localAgentRuntimeOptions.toolRegistry.listDescriptorsForAgent([
          "propose_skill_change"
        ])
      ).toMatchObject([{ name: "propose_skill_change", permission: { mode: "allow" } }]);
      expect(assembly.localAgentRuntimeOptions.agentSkillChangesEnabled).toBe(true);
    } finally {
      await assembly.close();
    }
  });

  it("rejects an agent tool reference with disabled policy", async () => {
    const f = await fixture();
    const capabilities = builtInModelCapabilities(f.config);
    expect(findConfigAssetAgentValidationIssues(f.config, [f.agent], capabilities)).toEqual([]);
    f.config.administration.agentConfiguration.agentSkillChanges.enabled = false;
    expect(findConfigAssetAgentValidationIssues(f.config, [f.agent], capabilities)).toEqual([
      expect.stringContaining("skill changes are disabled")
    ]);
  });
});
