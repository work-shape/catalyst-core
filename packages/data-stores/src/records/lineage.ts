import {
  KNOWLEDGE_BASE_ACTIONS,
  type ActorAccess,
  type ConfigAssetRecord
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { assetResource } from "../store-audience";

/** The same published Knowledge Base that the Workflow reads, never a reverse link or draft. */
export function recordKnowledgeSources(
  workflows: readonly { id: string; knowledge: readonly string[] }[],
  knowledgeBases: readonly ConfigAssetRecord[],
  access: ActorAccess
) {
  const byName = new Map(knowledgeBases.map((asset) => [asset.name, asset]));
  const result = new Map<string, { knowledgeBase: string; title: string }[]>();
  for (const workflow of workflows) {
    const sources: { knowledgeBase: string; title: string }[] = [];
    for (const name of workflow.knowledge) {
      const asset = byName.get(name);
      if (
        !asset ||
        asset.status !== "active" ||
        ![KNOWLEDGE_BASE_ACTIONS.read, KNOWLEDGE_BASE_ACTIONS.use].some(
          (right) => access.authorize(right, assetResource(asset)).allowed
        )
      )
        continue;
      const config = z.object({ title: z.string().optional() }).safeParse(asset.publishedConfig);
      if (config.success) sources.push({ knowledgeBase: name, title: config.data.title ?? name });
    }
    result.set(workflow.id, sources);
  }
  return result;
}
