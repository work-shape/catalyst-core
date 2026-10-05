import { z } from "zod";
import type { ConfigAssetSource } from "@vivd-catalyst/core";
import { createSkillSourceVersion } from "./skill-source-version";
import {
  defineTool,
  toolFailed,
  toolSuccess,
  type AnyToolDefinition
} from "@vivd-catalyst/tool-sdk";

const skillNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u);

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
}

export function createReadSkillTool(options: ReadSkillToolOptions): AnyToolDefinition {
  return defineTool({
    name: "read_skill",
    description:
      "Read the root instructions or one listed text resource for an available client skill. Read the root first, then load only relevant resources from its manifest.",
    inputSchema: readSkillInputSchema,
    outputSchema: readSkillOutputSchema,
    async execute(input, context) {
      const agentName = context.toolRequest?.agentName;
      if (!agentName) {
        return toolFailed("handler_failed", "read_skill requires an active agent run");
      }

      const assets = await options.assetSource.getSnapshot();
      const agent = assets.agents.find((candidate) => candidate.name === agentName);
      const allowedSkillNames = new Set(agent?.skillNames ?? []);
      if (!allowedSkillNames.has(input.name)) {
        return toolFailed(
          "not_allowed",
          `Agent '${agentName}' is not allowed to read skill '${input.name}'`
        );
      }

      const skill = assets.skills.find((candidate) => candidate.name === input.name);
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
