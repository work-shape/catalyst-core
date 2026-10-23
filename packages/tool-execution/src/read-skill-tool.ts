import { z } from "zod";
import {
  SKILL_MOUNT_ROOT,
  type ConfigAssetSource,
  type ConversationOfferSource,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { runSkillNames } from "./run-skills";
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
  files: z
    .array(
      z.object({
        path: skillResourcePathSchema,
        mediaType: z.string(),
        bytes: z.number(),
        opensIn: z.literal("workspace")
      })
    )
    .optional(),
  folder: z.string().optional(),
  workspaceNotice: z.string().optional(),
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
      "Read the root instructions or one listed text resource for an available client skill. Read the root first, then load only relevant resources from its manifest. Where the root read names a folder, every workspace command finds the skill's whole folder there, read-only. It reads only the skills of this agent and of this conversation. When the root read has saveApproval, a save of the skill by this person files a request and changes nothing until one of saveApproval.approverNames approves it; without it, a save this person may make applies immediately.",
    inputSchema: readSkillInputSchema,
    outputSchema: readSkillOutputSchema,
    async execute(input, context) {
      const agentName = context.toolRequest?.agentName;
      if (!agentName) {
        return toolFailed("handler_failed", "read_skill requires an active agent run");
      }

      const assets = await options.assetSource.getSnapshot();
      const allowedSkillNames = await runSkillNames({
        context,
        assets,
        conversationOffer: options.conversationOffer
      });
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
        if (skill.files?.some((file) => file.path === input.resourcePath)) {
          return {
            status: "failed",
            error: {
              code: "validation_failed",
              message: `The skill file '${input.resourcePath}' is used in the workspace.`,
              details: { reason: "skill_file_in_workspace", path: input.resourcePath }
            }
          };
        }
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
      const files = [...(skill.files ?? [])]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(({ path, mediaType, bytes }) => ({
          path,
          mediaType,
          bytes,
          opensIn: "workspace" as const
        }));
      const draft = context.agentPreview?.config;
      const agent =
        draft?.name === agentName
          ? draft
          : assets.agents.find((candidate) => candidate.name === agentName);
      // Every command of this run mounts the whole folder of the skill read-only there.
      const runsCommands = agent?.toolNames.includes("workspace.exec") === true;
      const folder = runsCommands ? `${SKILL_MOUNT_ROOT}/${skill.name}/` : undefined;
      const workspaceNotice =
        files.length && !runsCommands
          ? "These files need a workspace that this agent does not have."
          : undefined;
      return toolSuccess(
        {
          name: skill.name,
          title: skill.title,
          description: skill.description,
          content: skill.content,
          ...(resources.length ? { resources } : {}),
          ...(files.length ? { files } : {}),
          ...(folder ? { folder } : {}),
          ...(workspaceNotice ? { workspaceNotice } : {}),
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
