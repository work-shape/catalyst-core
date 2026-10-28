import { isJsonObject, type JsonObject } from "./json";
import {
  agentConfigSchema,
  AGENT_PREVIEW_SOURCES,
  skillConfigSchema,
  type SkillConfig
} from "@work-shape/catalyst-asset-schemas";
import { z } from "zod";

/** Frozen at turn admission, including the config, so a queued turn cannot run a later draft. */
export const agentPreviewSchema = z.object({
  agentId: z.string().min(1),
  revision: z.number().int().positive(),
  source: z.enum(AGENT_PREVIEW_SOURCES),
  config: agentConfigSchema,
  /**
   * The shared drafts of the skills the agent lists that the person trying it may write
   * (SKILL-DRAFT-1), frozen with it: Try reads each in place of its live revision. A skill
   * without a draft, or one the person may not write, is read live.
   */
  skills: z
    .array(z.object({ revision: z.number().int().positive(), config: skillConfigSchema }))
    .optional()
});

export type AgentPreview = z.infer<typeof agentPreviewSchema>;

/** The draft of a skill a Try turn reads in place of its live revision, where it froze one. */
export function previewSkill(
  preview: AgentPreview | undefined,
  name: string
): SkillConfig | undefined {
  return preview?.skills?.find((skill) => skill.config.name === name)?.config;
}

/** The snapshot as a Try turn reads it: the skills it froze drafts of, as those drafts. */
export function withPreviewSkills<Snapshot extends { skills: readonly SkillConfig[] }>(
  assets: Snapshot,
  preview: AgentPreview | undefined
): Snapshot {
  if (!preview?.skills?.length) return assets;
  return {
    ...assets,
    skills: assets.skills.map((skill) => previewSkill(preview, skill.name) ?? skill)
  };
}

/** Preview never builds assets or proposes skill changes, even if a model invents the call. */
export function forbiddenPreviewTool(name: string): boolean {
  return (
    name.startsWith("platform.") ||
    name === "skill.propose_change" ||
    name === "propose_skill_change"
  );
}

/** The worker needs the frozen definition; public transcripts expose only its provenance. */
export function withoutAgentPreviewConfig(
  metadata: JsonObject | undefined
): JsonObject | undefined {
  const runtime = metadata?.agentRuntime;
  if (!isJsonObject(runtime) || !isJsonObject(runtime.preview)) return metadata;
  const preview = { ...runtime.preview };
  delete preview.config;
  delete preview.skills;
  return { ...metadata, agentRuntime: { ...runtime, preview } };
}
