import { createHash } from "node:crypto";
import { z } from "zod";
import type { ConfigAssetSource, SkillConfig } from "@vivd-catalyst/core";
import { defineTool, toolFailed, toolSuccess, type AnyToolDefinition } from "@vivd-catalyst/tool-sdk";

const skillNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u);

const readSkillInputSchema = z.object({
  name: skillNameSchema.describe("The skill name from the available client skills list.")
});

const readSkillOutputSchema = z.object({
  name: skillNameSchema,
  title: z.string(),
  description: z.string(),
  content: z.string(),
  sourceVersion: z.string()
});

export interface ReadSkillToolOptions {
  assetSource: ConfigAssetSource;
}

export function createReadSkillTool(options: ReadSkillToolOptions): AnyToolDefinition {
  return defineTool({
    name: "read_skill",
    description:
      "Read the full Markdown instructions for one available client skill. Use this before applying a listed skill whose title and description match the user's task.",
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
      return toolSuccess(
        {
          name: skill.name,
          title: skill.title,
          description: skill.description,
          content: skill.content,
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

function createSkillSourceVersion(skill: SkillConfig): string {
  const hash = createHash("sha256")
    .update(skill.name)
    .update("\0")
    .update(skill.title)
    .update("\0")
    .update(skill.description)
    .update("\0")
    .update(skill.content)
    .digest("hex");
  return `sha256:${hash}`;
}
