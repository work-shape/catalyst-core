import { isJsonObject, type JsonObject } from "./json";
import { agentConfigSchema, AGENT_PREVIEW_SOURCES } from "@work-shape/catalyst-asset-schemas";
import { z } from "zod";

/** Frozen at turn admission, including the config, so a queued turn cannot run a later draft. */
export const agentPreviewSchema = z.object({
  agentId: z.string().min(1),
  revision: z.number().int().positive(),
  source: z.enum(AGENT_PREVIEW_SOURCES),
  config: agentConfigSchema
});

export type AgentPreview = z.infer<typeof agentPreviewSchema>;

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
  return { ...metadata, agentRuntime: { ...runtime, preview } };
}
