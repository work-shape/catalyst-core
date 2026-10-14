import { z } from "zod";
import {
  AppError,
  isJsonObject,
  unknownToJsonValue,
  type AgentSkillChangesPolicy,
  type ApprovalRequestCreator,
  type ConfigAssetSource,
  type SkillConfig
} from "@vivd-catalyst/core";
import {
  applySkillChange,
  assertSkillChangeScope,
  createSkillChangePreview,
  guardrailFieldOf,
  guardrailStringsOf,
  skillChangeOperationsSchema,
  skillNameSchema
} from "@vivd-catalyst/config-schema";
import {
  defineTool,
  toolFailed,
  toolSuccess,
  type AnyToolDefinition
} from "@vivd-catalyst/tool-sdk";
import { createSkillSourceVersion } from "./skill-source-version";

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
    title: { en: "Propose skill change", de: "Änderung an einem Skill vorschlagen" },
    summary: {
      en: "Suggests a change to a skill, which applies once a person approves it.",
      de: "Schlägt eine Änderung an einem Skill vor, die erst gilt, wenn eine Person sie freigibt."
    },
    group: "skills",
    icon: "skill",
    effect: "changing",
    description:
      "Propose one small, exact skill change per call. Read the skill with read_skill first. A new skill is one create_skill operation, optionally followed by create_resource operations for its supporting files, for example references/checklist.md. Never include personal or customer-specific data: skills are shared by all users. Tell the user in your reply what would change and that it needs a person's approval; it is not active until approved.",
    permission: { mode: "allow" },
    inputSchema: proposeSkillChangeInputSchema,
    // The guardrails on asset writes answer the skill as the change would write it, as they
    // answer a person's push: an approval later applies what they read here.
    beforeEvents: (input) => [
      {
        name: "asset.before_write",
        subject: { kind: "skill", name: input.skillName },
        checkable: async () => {
          // The skill whole: the snapshot leaves its resources out, and the guardrails read them.
          const current = await options.assetSource.getSkill(input.skillName);
          let skill: SkillConfig;
          try {
            skill = applySkillChange(current, input.operations);
          } catch {
            // The call refuses a change that does not apply; there is nothing to check.
            return { name: input.skillName };
          }
          return { name: skill.name, content: guardrailFieldOf(guardrailStringsOf(skill)) };
        }
      }
    ],
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
        // Whole, with its resources: the change and its base version are made from them.
        const skill = await options.assetSource.getSkill(parsed.skillName);
        if (skill?.origin === "release") {
          // A release writes it and nothing else: an approval could never apply the change.
          throw new AppError(
            "FORBIDDEN",
            `The skill '${parsed.skillName}' ships with the release and cannot be changed on this instance. A person can copy it to a skill of the instance's own in Studio and change the copy`
          );
        }
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
