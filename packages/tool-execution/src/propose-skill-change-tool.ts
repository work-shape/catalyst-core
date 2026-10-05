import { z } from "zod";
import {
  AppError,
  createSkillSourceVersion,
  isJsonObject,
  unknownToJsonValue,
  type AgentSkillChangesPolicy,
  type ApprovalRequestCreator,
  type ConfigAssetSource
} from "@vivd-catalyst/core";
import {
  assertSkillChangeScope,
  createSkillChangePreview,
  skillChangeOperationsSchema,
  skillNameSchema
} from "@vivd-catalyst/config-schema";
import {
  defineTool,
  toolFailed,
  toolSuccess,
  type AnyToolDefinition
} from "@vivd-catalyst/tool-sdk";

export const proposeSkillChangeInputSchema = z
  .object({
    skillName: skillNameSchema,
    summary: z
      .string()
      .trim()
      .min(1)
      .describe("One sentence in the user's language explaining the proposed change."),
    operations: skillChangeOperationsSchema
  })
  .strict();

export function createProposeSkillChangeTool(options: {
  assetSource: ConfigAssetSource;
  policy: AgentSkillChangesPolicy;
  creator: ApprovalRequestCreator;
}): AnyToolDefinition {
  return defineTool({
    name: "propose_skill_change",
    description:
      "Propose one small, exact skill change per call. Read the skill with read_skill first. Never include personal or customer-specific data: skills are shared by all users. Tell the user in your reply what would change and that it needs a person's approval; it is not active until approved.",
    permission: { mode: "allow" },
    inputSchema: proposeSkillChangeInputSchema,
    async execute(input, context) {
      const run = context.toolRequest;
      if (!run) {
        return toolFailed("handler_failed", "propose_skill_change requires an active agent run");
      }
      try {
        const parsed = proposeSkillChangeInputSchema.parse(input);
        const snapshot = await options.assetSource.getSnapshot();
        const agent = snapshot.agents.find((candidate) => candidate.name === run.agentName);
        assertSkillChangeScope({
          policy: options.policy,
          agent,
          skillName: parsed.skillName,
          operations: parsed.operations
        });
        const skill = snapshot.skills.find((candidate) => candidate.name === parsed.skillName);
        const preview = createSkillChangePreview(skill, parsed.operations);
        const payload = unknownToJsonValue({
          agentName: run.agentName,
          skillName: parsed.skillName,
          operations: parsed.operations,
          baseSourceVersion: skill ? createSkillSourceVersion(skill) : null,
          preview
        });
        if (!isJsonObject(payload)) {
          throw new AppError("VALIDATION_FAILED", "Invalid skill change payload");
        }
        const request = await options.creator.createRequest(context.user, context, {
          kind: "skill_change",
          summary: parsed.summary,
          payload,
          origin: {
            agentName: run.agentName,
            conversationId: run.conversationId,
            agentRunId: run.agentRunId,
            toolCallId: run.toolCallId
          }
        });
        return toolSuccess(
          {
            requestId: request.id,
            status: "pending",
            message: "The skill change is NOT active until a person approves it."
          },
          {
            display: {
              kind: "catalyst.approval_request",
              version: 1,
              mode: "inline",
              data: { requestId: request.id, kind: "skill_change" }
            },
            auditSummary: {
              action: "propose_skill_change",
              subject: parsed.skillName,
              metadata: { skillName: parsed.skillName, requestId: request.id }
            }
          }
        );
      } catch (error) {
        if (error instanceof AppError) {
          return toolFailed(
            error.code === "FORBIDDEN" ? "not_allowed" : "validation_failed",
            error.message
          );
        }
        if (error instanceof z.ZodError) {
          return toolFailed(
            "validation_failed",
            error.issues.map((issue) => issue.message).join("; ")
          );
        }
        throw error;
      }
    }
  });
}
