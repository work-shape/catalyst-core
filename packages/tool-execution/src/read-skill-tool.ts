import { z } from "zod";
import { defineTool, toolFailed, toolSuccess, type AnyToolDefinition } from "@vivd-catalyst/tool-sdk";
import type { SkillCatalog } from "./skill-catalog";

const skillNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u);

const readSkillInputSchema = z.object({
  name: skillNameSchema
});

const readSkillOutputSchema = z.object({
  name: skillNameSchema,
  title: z.string(),
  description: z.string(),
  content: z.string(),
  sourceVersion: z.string()
});

export interface ReadSkillToolOptions {
  catalog: SkillCatalog;
  getAgentSkillNames(agentName: string): readonly string[];
}

export function createReadSkillTool(options: ReadSkillToolOptions): AnyToolDefinition {
  return defineTool({
    name: "read_skill",
    description:
      "Read the full Markdown instructions for one available client skill. Use this before applying a listed skill whose title and description match the user's task.",
    inputSchema: readSkillInputSchema,
    outputSchema: readSkillOutputSchema,
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "The skill name from the available client skills list."
        }
      }
    },
    execute(input, context) {
      const agentName = context.toolRequest?.agentName;
      if (!agentName) {
        return toolFailed("handler_failed", "read_skill requires an active agent run");
      }

      const allowedSkillNames = new Set(options.getAgentSkillNames(agentName));
      if (!allowedSkillNames.has(input.name)) {
        return toolFailed(
          "not_allowed",
          `Agent '${agentName}' is not allowed to read skill '${input.name}'`
        );
      }

      const skill = options.catalog.get(input.name);
      if (!skill) {
        return toolFailed("validation_failed", `Skill '${input.name}' is not defined`);
      }

      return toolSuccess(
        {
          name: skill.name,
          title: skill.title,
          description: skill.description,
          content: skill.content,
          sourceVersion: skill.sourceVersion
        },
        {
          auditSummary: {
            action: "read_skill",
            subject: skill.name,
            metadata: {
              agentName,
              sourceVersion: skill.sourceVersion
            }
          }
        }
      );
    }
  });
}
