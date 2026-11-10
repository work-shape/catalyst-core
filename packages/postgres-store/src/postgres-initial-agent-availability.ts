import { and, eq, inArray } from "drizzle-orm";
import {
  AVAILABLE_EVERYWHERE,
  availabilityCovers,
  resolveInitialAgentAvailability,
  type AgentAvailability,
  type ClientInstanceId,
  type ConfigAssetStore
} from "@work-shape/catalyst-core";
import type { PostgresTransaction } from "./postgres-database";
import { storedAvailability } from "./postgres-default-agents";
import { configAssetAvailability, configAssets, configAssetWorkspaceAvailability } from "./schema";

// Where the agents a mutation batch creates or revives start, decided and written inside the
// batch's transaction.

type InitialAvailability = Pick<AgentAvailability, "mode" | "collaborationWorkspaceIds"> & {
  awaitingFirstPublish?: true;
};

/**
 * The availability the batch's new agents start with. The release rule asks whether the batch
 * deletes an agent that was available in chosen workspaces only.
 */
export async function resolveBatchInitialAvailability(
  tx: PostgresTransaction,
  input: Pick<
    Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0],
    "clientInstanceId" | "initialAgentAvailability" | "mutations"
  >
): Promise<InitialAvailability> {
  const deletedAgentNames = input.mutations.flatMap((mutation) =>
    mutation.type === "delete" && mutation.kind === "agent" ? [mutation.name] : []
  );
  // An agent offered only somewhere, in selected workspaces or in all but some.
  const deletedAgents =
    input.initialAgentAvailability === "selected_when_replacing_selected" &&
    deletedAgentNames.length > 0
      ? await tx
          .select({ assetId: configAssetAvailability.assetId })
          .from(configAssetAvailability)
          .innerJoin(configAssets, eq(configAssets.id, configAssetAvailability.assetId))
          .where(
            and(
              eq(configAssets.clientInstanceId, input.clientInstanceId),
              eq(configAssets.kind, "agent"),
              inArray(configAssets.name, deletedAgentNames)
            )
          )
      : [];
  let deletedSelectedAgent = false;
  for (const { assetId } of deletedAgents) {
    if (!availabilityCovers(await storedAvailability(tx, assetId), AVAILABLE_EVERYWHERE)) {
      deletedSelectedAgent = true;
      break;
    }
  }
  return resolveInitialAgentAvailability(input.initialAgentAvailability, deletedSelectedAgent);
}

/** Writes the availability of agents the batch created, with the workspaces it names. */
export async function insertInitialAgentAvailability(
  tx: PostgresTransaction,
  input: {
    clientInstanceId: ClientInstanceId;
    assetIds: readonly string[];
    availability: InitialAvailability;
    now: Date;
  }
): Promise<void> {
  const { assetIds, availability } = input;
  await tx.insert(configAssetAvailability).values(
    assetIds.map((assetId) => ({
      assetId,
      clientInstanceId: input.clientInstanceId,
      mode: availability.mode,
      personalWorkspaces: false,
      awaitingFirstPublish: availability.awaitingFirstPublish === true,
      updatedAt: input.now
    }))
  );
  const workspaceRows = assetIds.flatMap((assetId) =>
    availability.collaborationWorkspaceIds.map((collaborationWorkspaceId) => ({
      assetId,
      collaborationWorkspaceId
    }))
  );
  if (workspaceRows.length > 0) {
    await tx.insert(configAssetWorkspaceAvailability).values(workspaceRows);
  }
}
