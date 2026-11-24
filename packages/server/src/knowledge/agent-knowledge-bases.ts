import type { SafeConfigKnowledgeBase } from "@work-shape/catalyst-config-schema";
import {
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  type AccessResource,
  type ClientInstanceId,
  type ConfigAssetStore,
  type ModuleSnapshot
} from "@work-shape/catalyst-core";

/** What the read needs of the instance: its published assets and whether the module is on. */
export interface AgentKnowledgeBaseSources {
  clientInstanceId: ClientInstanceId;
  modules: Pick<ModuleSnapshot, "isEnabled">;
  configAssets: { store: Pick<ConfigAssetStore, "listPublishedConfigAssets"> };
}

/** The person's rights, as far as the read asks them. */
export interface AgentKnowledgeBaseReader {
  authorize(action: string, resource?: AccessResource): { allowed: boolean };
}

/** The most Knowledge Bases one agent list reads the names of. */
const KNOWLEDGE_BASES_READ = 200;

/**
 * The published Knowledge Bases the person may read or search, for the agents they are
 * offered: the id, the name people read and the description. An agent list names one only for
 * an agent that answers from it, so the empty chat says what the agent knows. One the person
 * holds neither right on is left out, as is everything where the module `knowledge` is off.
 */
export async function agentKnowledgeBases(
  options: AgentKnowledgeBaseSources,
  access: AgentKnowledgeBaseReader
): Promise<SafeConfigKnowledgeBase[]> {
  if (!options.modules.isEnabled("knowledge")) {
    return [];
  }
  const records = await options.configAssets.store.listPublishedConfigAssets({
    clientInstanceId: options.clientInstanceId,
    kind: KNOWLEDGE_BASE_ASSET_KIND,
    limit: KNOWLEDGE_BASES_READ
  });
  return records.flatMap((record) => {
    const resource: AccessResource = {
      kind: record.kind,
      name: record.name,
      assetId: record.id,
      ...(record.scope.kind === "workspace" ? { workspaceId: record.scope.workspaceId } : {})
    };
    const allowed =
      record.status === "active" &&
      [KNOWLEDGE_BASE_ACTIONS.read, KNOWLEDGE_BASE_ACTIONS.use].some(
        (right) => access.authorize(right, resource).allowed
      );
    if (!allowed) return [];
    const config = record.publishedConfig ?? {};
    const title = text(record.personTitle) ?? text(config.title) ?? record.name;
    const description = text(config.description);
    return [{ name: record.name, title, ...(description === undefined ? {} : { description }) }];
  });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
