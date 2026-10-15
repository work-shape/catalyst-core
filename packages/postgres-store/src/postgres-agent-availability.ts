import { and, asc, eq, inArray } from "drizzle-orm";
import { AppError, type AgentAvailability, type ConfigAssetStore } from "@work-shape/catalyst-core";
import { findConfigAssetRow } from "./postgres-config-asset-operations";
import type { PostgresConnection } from "./postgres-database";
import {
  configAssetAvailability,
  configAssets,
  configAssetState,
  configAssetWorkspaceAvailability
} from "./schema";

// Which workspaces an agent is offered in: the read and the write of that setting.

export async function listAgentAvailability(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["listAgentAvailability"]>[0]
): Promise<Map<string, AgentAvailability>> {
  const rows = await db
    .select({
      assetId: configAssets.id,
      name: configAssets.name,
      mode: configAssetAvailability.mode,
      personalWorkspaces: configAssetAvailability.personalWorkspaces
    })
    .from(configAssetAvailability)
    .innerJoin(configAssets, eq(configAssets.id, configAssetAvailability.assetId))
    .where(
      and(
        eq(configAssets.clientInstanceId, input.clientInstanceId),
        eq(configAssets.kind, "agent"),
        eq(configAssets.status, "active"),
        input.agentName === undefined ? undefined : eq(configAssets.name, input.agentName)
      )
    );
  if (rows.length === 0) {
    return new Map();
  }
  const workspaceRows = await db
    .select({
      assetId: configAssetWorkspaceAvailability.assetId,
      collaborationWorkspaceId: configAssetWorkspaceAvailability.collaborationWorkspaceId
    })
    .from(configAssetWorkspaceAvailability)
    .innerJoin(
      configAssetAvailability,
      eq(configAssetAvailability.assetId, configAssetWorkspaceAvailability.assetId)
    )
    .where(
      and(
        eq(configAssetAvailability.clientInstanceId, input.clientInstanceId),
        input.agentName === undefined
          ? undefined
          : inArray(
              configAssetWorkspaceAvailability.assetId,
              rows.map((row) => row.assetId)
            )
      )
    )
    .orderBy(asc(configAssetWorkspaceAvailability.collaborationWorkspaceId));
  return new Map(
    rows.map((row) => [
      row.name,
      {
        mode: row.mode,
        personalWorkspaces: row.personalWorkspaces,
        collaborationWorkspaceIds: workspaceRows
          .filter((workspaceRow) => workspaceRow.assetId === row.assetId)
          .map((workspaceRow) => workspaceRow.collaborationWorkspaceId)
      }
    ])
  );
}

export async function setAgentAvailability(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["setAgentAvailability"]>[0]
): Promise<AgentAvailability> {
  return db.transaction(async (tx) => {
    // Serializes with default-agent changes, which lock the same row. An active asset was
    // written through `applyConfigAssetMutations`, which creates the row, so it is there.
    const [state] = await tx
      .select()
      .from(configAssetState)
      .where(eq(configAssetState.clientInstanceId, input.clientInstanceId))
      .for("update")
      .limit(1);
    const asset = await findConfigAssetRow(tx, {
      clientInstanceId: input.clientInstanceId,
      kind: "agent",
      name: input.agentName
    });
    if (!asset || asset.status !== "active") {
      throw new AppError("NOT_FOUND", `Config agent '${input.agentName}' was not found`);
    }
    if (input.expectedAssetId !== undefined && input.expectedAssetId !== asset.id) {
      throw availabilityConflict(input.agentName, "asset_replaced");
    }
    if (input.expectedAvailability !== undefined) {
      // Every change of an availability holds the lock above, so what is read here stands.
      const [stored] = await tx
        .select({
          mode: configAssetAvailability.mode,
          personalWorkspaces: configAssetAvailability.personalWorkspaces
        })
        .from(configAssetAvailability)
        .where(eq(configAssetAvailability.assetId, asset.id))
        .limit(1);
      const storedWorkspaces = stored
        ? await tx
            .select({ id: configAssetWorkspaceAvailability.collaborationWorkspaceId })
            .from(configAssetWorkspaceAvailability)
            .where(eq(configAssetWorkspaceAvailability.assetId, asset.id))
        : [];
      const current = stored
        ? { ...stored, collaborationWorkspaceIds: storedWorkspaces.map(({ id }) => id) }
        : null;
      if (!availabilitiesEqual(current, input.expectedAvailability)) {
        throw availabilityConflict(input.agentName, "availability_changed");
      }
    }
    if (input.availability.mode !== "all" && state?.defaultAgentName === input.agentName) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Default agent '${input.agentName}' must be available in all workspaces`
      );
    }
    const now = new Date();
    const collaborationWorkspaceIds = [
      ...new Set(input.availability.collaborationWorkspaceIds)
    ].sort();
    await tx
      .insert(configAssetAvailability)
      .values({
        assetId: asset.id,
        clientInstanceId: input.clientInstanceId,
        mode: input.availability.mode,
        personalWorkspaces: input.availability.personalWorkspaces,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: configAssetAvailability.assetId,
        set: {
          mode: input.availability.mode,
          personalWorkspaces: input.availability.personalWorkspaces,
          updatedAt: now
        }
      });
    await tx
      .delete(configAssetWorkspaceAvailability)
      .where(eq(configAssetWorkspaceAvailability.assetId, asset.id));
    if (collaborationWorkspaceIds.length > 0) {
      await tx.insert(configAssetWorkspaceAvailability).values(
        collaborationWorkspaceIds.map((collaborationWorkspaceId) => ({
          assetId: asset.id,
          collaborationWorkspaceId
        }))
      );
    }
    // Who is offered an asset is part of the asset set as a run sees it, so the set's version
    // moves with it: whatever keeps the set by its version reads the change with the next run.
    if (state) {
      await tx
        .update(configAssetState)
        .set({ version: state.version + 1, updatedAt: now })
        .where(eq(configAssetState.clientInstanceId, input.clientInstanceId));
    }
    return { ...input.availability, collaborationWorkspaceIds };
  });
}

/** The refusal of an availability change that was decided against what is no longer stored. */
function availabilityConflict(
  agentName: string,
  reason: "asset_replaced" | "availability_changed"
): AppError {
  return new AppError(
    "CONFLICT",
    reason === "asset_replaced"
      ? `Config agent '${agentName}' is another asset than the one this change was made for`
      : `The availability of config agent '${agentName}' changed since it was read`,
    { kind: "agent", name: agentName, reason }
  );
}

/** Whether two availabilities offer the same, whatever the order of their workspaces. */
function availabilitiesEqual(
  left: { mode: string; personalWorkspaces: boolean; collaborationWorkspaceIds: string[] } | null,
  right: AgentAvailability | null
): boolean {
  if (left === null || right === null) return left === right;
  const ids = (list: readonly string[]) => [...new Set(list)].sort().join("\u0000");
  return (
    left.mode === right.mode &&
    left.personalWorkspaces === right.personalWorkspaces &&
    ids(left.collaborationWorkspaceIds) === ids(right.collaborationWorkspaceIds)
  );
}
