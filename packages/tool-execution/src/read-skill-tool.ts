import { z } from "zod";
import type { ConfigAssetSource, ConversationOfferSource } from "@work-shape/catalyst-core";
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
  sourceVersion: z.string()
});

export interface ReadSkillToolOptions {
  assetSource: ConfigAssetSource;
  /** Which skills the platform ships to a conversation, beside those its agent lists. */
  conversationOffer?: ConversationOfferSource;
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
      "Read the root instructions or one listed text resource for an available client skill. Read the root first, then load only relevant resources from its manifest.",
    inputSchema: readSkillInputSchema,
    outputSchema: readSkillOutputSchema,
    async execute(input, context) {
      const agentName = context.toolRequest?.agentName;
      if (!agentName) {
        return toolFailed("handler_failed", "read_skill requires an active agent run");
      }

      // The skills the platform ships are offered to a conversation of an agent that holds the
      // platform's tools, and no agent's definition needs to list them. They are stored skills,
      // read like any other.
      const conversationId = context.toolRequest?.conversationId;
      const assets = await options.assetSource.getSnapshot();
      const agent = assets.agents.find((candidate) => candidate.name === agentName);
      const offer = conversationId
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
          `Agent '${agentName}' is not allowed to read skill '${input.name}'`
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
          sourceVersion
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
