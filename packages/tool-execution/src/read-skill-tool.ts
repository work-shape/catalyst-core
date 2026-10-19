import { z } from "zod";
import type {
  ConfigAssetSource,
  ConversationOfferSource,
  ToolExecutionContext
} from "@work-shape/catalyst-core";
import { createSkillSourceVersion } from "./skill-source-version";
import {
  defineTool,
  toolFailed,
  toolSuccess,
  type AnyToolDefinition
} from "@work-shape/catalyst-tool-sdk";

const skillNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u);

const skillResourcePathSchema = z
  .string()
  .min(1)
  .superRefine((path, context) => {
    const segments = path.split("/");
    if (
      path.startsWith("/") ||
      /^[A-Za-z]:/u.test(path) ||
      path.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "Skill resource path must be a normalized relative path"
      });
    }
  });

const readSkillInputSchema = z.object({
  name: skillNameSchema.describe("The skill name from the available client skills list."),
  resourcePath: skillResourcePathSchema
    .optional()
    .describe("An exact resource path from the root skill read's resource manifest.")
});

const readSkillOutputSchema = z.object({
  name: skillNameSchema,
  title: z.string().optional(),
  description: z.string().optional(),
  content: z.string(),
  resourcePath: skillResourcePathSchema.optional(),
  mediaType: z.string().optional(),
  resources: z
    .array(
      z.object({
        path: skillResourcePathSchema,
        mediaType: z.string()
      })
    )
    .optional(),
  sourceVersion: z.string(),
  saveApproval: z.object({ approverNames: z.array(z.string()) }).optional()
});

export interface ReadSkillToolOptions {
  assetSource: ConfigAssetSource;
  /** Which skills the platform ships to a conversation, beside those its agent lists. */
  conversationOffer?: ConversationOfferSource;
  /**
   * Whether a save of the skill by the person the agent acts for files a request, and who may
   * decide it, as a read of the asset answers it. Without it a read says nothing of a save.
   */
  saveApproval?(
    context: ToolExecutionContext,
    name: string
  ): Promise<{ approverNames: string[] } | undefined>;
}

export function createReadSkillTool(options: ReadSkillToolOptions): AnyToolDefinition {
  return defineTool({
    name: "read_skill",
    title: { en: "Read assigned skill", de: "Zugewiesenen Skill lesen" },
    summary: {
      en: "Reads the instructions of the skills assigned to the agent.",
      de: "Liest die Anleitungen der Skills, die dem Agenten zugewiesen sind."
    },
    group: "skills",
    icon: "skill",
    effect: "reading",
    description:
      "Read the root instructions or one listed text resource for an available client skill. Read the root first, then load only relevant resources from its manifest. It reads only the skills of this agent and of this conversation. When the root read has saveApproval, a save of the skill by this person files a request and changes nothing until one of saveApproval.approverNames approves it; without it, a save this person may make applies immediately.",
    inputSchema: readSkillInputSchema,
    outputSchema: readSkillOutputSchema,
    async execute(input, context) {
      const agentName = context.toolRequest?.agentName;
      if (!agentName) {
        return toolFailed("handler_failed", "read_skill requires an active agent run");
      }

      // The skills the platform ships are offered to a conversation of an agent that holds the
      // platform's tools, and no agent's definition needs to list them. They are stored skills,
      // read like any other. A Try turn reads the skills of its frozen draft, with no offer.
      const conversationId = context.toolRequest?.conversationId;
      const assets = await options.assetSource.getSnapshot();
      const draft = context.agentPreview?.config;
      const preview = draft?.name === agentName ? draft : undefined;
      const agent = preview ?? assets.agents.find((candidate) => candidate.name === agentName);
      const offer =
        conversationId && !preview
          ? await options.conversationOffer?.offerOf({
              clientInstanceId: context.clientInstanceId,
              conversationId,
              agentToolNames: agent?.toolNames ?? []
            })
          : undefined;
      const allowedSkillNames = new Set([
        ...(agent?.skillNames ?? []),
        ...(offer?.skillNames ?? [])
      ]);
      if (!allowedSkillNames.has(input.name)) {
        return toolFailed(
          "not_allowed",
          context.locale === "de"
            ? "Dieser Agent hat diesen Skill nicht und kann ihn hier nicht lesen. Eine Person, die den Agenten bearbeiten darf, kann ihm den Skill geben. Wer den Skill bearbeiten darf, ändert ihn in Studio auf der Seite des Skills. Es wurde nichts geändert."
            : "This agent does not have this skill and cannot read it here. Someone who may edit the agent can give it the skill. Whoever may edit the skill changes it in Studio on the skill's page. Nothing was changed."
        );
      }

      // The snapshot carries no skill's resources: the skill read is read whole.
      const skill = assets.skills.some((candidate) => candidate.name === input.name)
        ? await options.assetSource.getSkill(input.name)
        : undefined;
      if (!skill) {
        return toolFailed("validation_failed", `Skill '${input.name}' is not defined`);
      }

      const sourceVersion = createSkillSourceVersion(skill);
      if (input.resourcePath) {
        const resource = (skill.resources ?? []).find(
          (candidate) => candidate.path === input.resourcePath
        );
        if (!resource) {
          return toolFailed(
            "validation_failed",
            `Skill '${input.name}' does not define resource '${input.resourcePath}'`
          );
        }
        return toolSuccess(
          {
            name: skill.name,
            resourcePath: resource.path,
            mediaType: resource.mediaType,
            content: resource.content,
            sourceVersion
          },
          {
            auditSummary: {
              action: "read_skill",
              subject: skill.name,
              metadata: {
                agentName,
                sourceVersion,
                resourcePath: resource.path
              }
            }
          }
        );
      }
      const saveApproval = await options.saveApproval?.(context, skill.name);
      const resources = [...(skill.resources ?? [])]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((resource) => ({ path: resource.path, mediaType: resource.mediaType }));
      return toolSuccess(
        {
          name: skill.name,
          title: skill.title,
          description: skill.description,
          content: skill.content,
          ...(resources.length ? { resources } : {}),
          sourceVersion,
          ...(saveApproval ? { saveApproval } : {})
        },
        {
          auditSummary: {
            action: "read_skill",
            subject: skill.name,
            metadata: {
              agentName,
              sourceVersion
            }
          }
        }
      );
    }
  });
}
