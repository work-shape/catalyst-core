import { agentConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  AppError,
  isAppError,
  mergeShippedAgent,
  shippedAgentFields,
  type AuditActor,
  type ClientInstanceId,
  type ConfigAssetMutation,
  type JsonObject,
  type PlatformStores,
  type ShippedAgent
} from "@work-shape/catalyst-core";
import { configValuesEqual } from "../asset-kinds/shared";
import { toJsonObject } from "../assets/asset-write-rules";

// The seed of the agents that ship with the platform, such as Workshaper. When the API process
// starts it creates a shipped agent the instance does not have yet, available in no workspace,
// and brings one it has up to what this build ships: a field the instance left as the last
// release shipped it takes the new value, one it changed stays as it is. It never changes where
// the agent is available and never deletes one: with the module off it writes nothing, and the
// agent stays as it was. It writes to the store and through no operation.

const AGENT_KIND = "agent";

/** Who a seeded revision is written by, as History shows it. */
const SYSTEM_ACTOR: AuditActor = { displayLabel: "System", roles: [] };

/** What one start changed, by agent name. */
export interface ShippedAgentSeedResult {
  /** Names held by an agent of the instance's own or a workspace's, which the seed leaves. */
  retained: string[];
  created: string[];
  updated: string[];
}

export interface SeedShippedAgentsInput {
  clientInstanceId: ClientInstanceId;
  stores: Pick<PlatformStores, "configAssets">;
  /** What this build ships, where the module that ships it is on. */
  agents: readonly ShippedAgent[];
}

function definitionOf(agent: ShippedAgent): JsonObject {
  const parsed = agentConfigSchema.safeParse({ ...agent, shipped: shippedAgentFields(agent) });
  if (!parsed.success) {
    throw new AppError(
      "INTERNAL",
      `The platform ships the agent '${agent.name}', which is no valid agent: ${parsed.error.issues[0]?.message ?? ""}`
    );
  }
  return toJsonObject(parsed.data);
}

/**
 * Brings the shipped agents of the instance up to what this build ships. Safe on every start
 * and in several processes at once: a start that finds everything as shipped writes nothing,
 * and one that lost a race to another start reads again and finds that.
 */
export async function seedShippedAgents(
  input: SeedShippedAgentsInput
): Promise<ShippedAgentSeedResult> {
  try {
    return await reconcile(input);
  } catch (error) {
    if (!isAppError(error) || (error.code !== "REVISION_CONFLICT" && error.code !== "CONFLICT")) {
      throw error;
    }
    return reconcile(input);
  }
}

async function reconcile(input: SeedShippedAgentsInput): Promise<ShippedAgentSeedResult> {
  const { clientInstanceId } = input;
  const store = input.stores.configAssets;
  const result: ShippedAgentSeedResult = { retained: [], created: [], updated: [] };
  const mutations: ConfigAssetMutation[] = [];
  const baseRevisions: Record<string, number | null> = {};
  for (const agent of input.agents) {
    const row = await store.getConfigAsset({
      clientInstanceId,
      kind: AGENT_KIND,
      name: agent.name
    });
    const active = row?.status === "active" ? row : undefined;
    if (
      (row && row.scope.kind !== "instance") ||
      (active && active.config?.shipped === undefined)
    ) {
      // An agent of the instance's own holds the name from before the platform shipped one.
      // It stays as it is; renaming it lets a later start seed the shipped agent.
      result.retained.push(agent.name);
      continue;
    }
    const config = active?.config
      ? toJsonObject(mergeShippedAgent(active.config, agent, configValuesEqual))
      : definitionOf(agent);
    if (active?.config && configValuesEqual(active.config, config)) continue;
    mutations.push({ type: "upsert", kind: AGENT_KIND, name: agent.name, config });
    // A deleted row continues its revisions.
    baseRevisions[`${AGENT_KIND}:${agent.name}`] = row?.revision ?? null;
    (active ? result.updated : result.created).push(agent.name);
  }
  if (mutations.length > 0) {
    await store.applyConfigAssetMutations({
      clientInstanceId,
      actor: SYSTEM_ACTOR,
      baseRevisions,
      // Offered nowhere until an admin offers it, in "Available in" (Felix, 2026-10-21). An
      // agent the instance has keeps where it is available.
      initialAgentAvailability: "hidden",
      mutations
    });
  }
  return result;
}
