import { and, eq } from "drizzle-orm";
import { AppError, type AgentUse, type ConfigAssetStore } from "@work-shape/catalyst-core";
import { findConfigAssetRow } from "./postgres-config-asset-operations";
import type { PostgresConnection } from "./postgres-database";
import { agentUseLimits, configAssets } from "./schema";

// Who uses an agent where it is available (AGENT-USE-1): the read and the write of that setting.

export async function listAgentUseLimits(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["listAgentUseLimits"]>[0]
): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ name: configAssets.name })
    .from(agentUseLimits)
    .innerJoin(configAssets, eq(configAssets.id, agentUseLimits.assetId))
    .where(
      and(
        eq(agentUseLimits.clientInstanceId, input.clientInstanceId),
        eq(configAssets.kind, "agent"),
        eq(configAssets.status, "active"),
        input.agentName === undefined ? undefined : eq(configAssets.name, input.agentName)
      )
    );
  return new Set(rows.map((row) => row.name));
}

export async function setAgentUse(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["setAgentUse"]>[0]
): Promise<AgentUse> {
  return db.transaction(async (tx) => {
    const asset = await findConfigAssetRow(tx, {
      clientInstanceId: input.clientInstanceId,
      kind: "agent",
      name: input.agentName
    });
    if (!asset || asset.status !== "active") {
      throw new AppError("NOT_FOUND", `Config agent '${input.agentName}' was not found`);
    }
    if (input.expectedAssetId !== undefined && input.expectedAssetId !== asset.id) {
      throw new AppError("CONFLICT", `Agent '${input.agentName}' was replaced since it was read`, {
        kind: "agent",
        name: input.agentName,
        reason: "asset_replaced"
      });
    }
    if (input.use === "granted") {
      await tx
        .insert(agentUseLimits)
        .values({
          assetId: asset.id,
          clientInstanceId: input.clientInstanceId,
          updatedAt: new Date()
        })
        .onConflictDoNothing();
    } else {
      await tx.delete(agentUseLimits).where(eq(agentUseLimits.assetId, asset.id));
    }
    return input.use;
  });
}
