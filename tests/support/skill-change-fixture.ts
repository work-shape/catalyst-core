import { createScriptedInstanceModelGateway } from "./model-gateway";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { accessOf } from "./access";
import { createTestAssetKinds, createTestInstance } from "./test-instance";
import { vi, type Mock } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  isJsonObject,
  StoreBackedAuditRecorder,
  unknownToJsonValue,
  type ApprovalRequest,
  type AuthenticatedUser,
  type JsonObject,
  type SkillConfig
} from "@vivd-catalyst/core";
import {
  agentConfigSchema,
  createSkillChangePreview,
  getModelProviderConfigs,
  parseClientInstanceConfig,
  type SkillChangeOperation
} from "@vivd-catalyst/config-schema";
import {
  ApprovalRequestWorkflow,
  GuardrailRunner,
  createSkillChangeApprovalHandler
} from "@vivd-catalyst/chat-server";
import {
  createProposeSkillChangeTool,
  createSkillSourceVersion
} from "@vivd-catalyst/tool-execution";
import { createConfigAssetSource } from "../../packages/client-assembly/src/config-asset-source";
import { createTestConfig } from "./fixtures";
import { applyAtCurrentRevisions } from "./asset-revisions";

// The skill-change approval of one instance: an agent, its skill, the workflow and the tool that
// files a change, with the guardrails of release config where a test names them.

export const clientInstanceId = asClientInstanceId("test-client");
export const requester: AuthenticatedUser = {
  id: "requester",
  externalUserId: "requester",
  displayLabel: "Requester",
  roles: ["user"],
  permissionRefs: [],
  clientInstanceId,
  authSource: "test"
};
export const reviewer: AuthenticatedUser = {
  ...requester,
  id: "reviewer",
  displayLabel: "Reviewer",
  permissions: ["agent_skills.approve"]
};
export const context = { correlationId: "skill-test" };
export const skill: SkillConfig = {
  name: "review",
  title: "Review",
  description: "Review guidance",
  content: "Check facts.\n\nKeep evidence."
};
export const operations: SkillChangeOperation[] = [
  { type: "replace_text", target: "root", oldText: "Check", newText: "Verify" }
];
export const creation: SkillChangeOperation[] = [
  {
    type: "create_skill",
    name: "new_skill",
    title: "New skill",
    description: "New guidance",
    content: "Ask for evidence."
  }
];
export function json(input: unknown): JsonObject {
  const value = unknownToJsonValue(input);
  if (!isJsonObject(value)) throw new Error("Expected object");
  return value;
}
export async function fixture(guardrails?: Record<string, unknown>) {
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
  await applyAtCurrentRevisions(store.configAssets, {
    clientInstanceId,
    mutations: [
      { type: "upsert", kind: "agent", name: agent.name, config: json(agent) },
      { type: "upsert", kind: "skill", name: skill.name, config: json(skill) },
      { type: "setDefaultAgent", agentName: agent.name }
    ]
  });
  const source = createConfigAssetSource({ store: store.configAssets, clientInstanceId });
  const validationRefs = {
    modelProviderIds: getModelProviderConfigs(config).map((provider) => provider.id),
    modelBindingIds: [],
    modelBindings: [],
    fastModeModelBindingIds: [],
    reasoningEfforts: [],
    enabledToolNames: ["read_skill", "propose_skill_change"]
  };
  const handler = createSkillChangeApprovalHandler({
    config,
    clientInstanceId,
    configAssets: {
      store: store.configAssets,
      source,
      kinds: createTestAssetKinds({ config, validationRefs }),
      validationRefs
    }
  });
  const onDecided: Mock<(request: ApprovalRequest) => void> = vi.fn();
  const guarded = guardrails && parseClientInstanceConfig({ ...createTestConfig(), guardrails });
  const workflow = new ApprovalRequestWorkflow({
    clientInstanceId,
    store: store.approvals,
    handlers: new Map([[handler.kind, handler]]),
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: store.audit }),
    onDecided,
    ...(guarded
      ? {
          guardrails: new GuardrailRunner({
            clientInstanceId,
            config: guarded,
            hits: store.guardrails,
            // Patterns only: no judge is asked.
            modelGateway: createScriptedInstanceModelGateway({
              config: guarded,
              modelProvider: { complete: vi.fn() },
              usageGovernance: new ModelUsageGovernance({
                store: store.usage,
                budget: {},
                safeguards: {}
              })
            })
          })
        }
      : {})
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
    workflow.decideRequest(reviewer, accessOf(reviewer), context, {
      requestId,
      decision: "approve"
    });
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
