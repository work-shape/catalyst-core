import { and, eq, inArray } from "drizzle-orm";
import { AppError, assetScopesEqual, type ConfigAssetStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { mapAssetScope } from "./rows";
import { configAssets, configAssetState } from "./schema";

/**
 * Gives a set of assets a new owner in one transaction (SHARE-1). The state row is locked as
 * every write of the set locks it, so no write lands between the check of the planned
 * revisions and the move. Only the owner columns change: everything keyed by the asset follows.
 */
export async function moveConfigAssets(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["moveConfigAssets"]>[0]
): ReturnType<ConfigAssetStore["moveConfigAssets"]> {
  if (input.assets.length === 0) {
    throw new AppError("VALIDATION_FAILED", "A move names at least one asset");
  }
  return db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .insert(configAssetState)
      .values({ clientInstanceId: input.clientInstanceId, version: 0, updatedAt: now })
      .onConflictDoNothing();
    const [state] = await tx
      .select()
      .from(configAssetState)
      .where(eq(configAssetState.clientInstanceId, input.clientInstanceId))
      .for("update")
      .limit(1);
    if (!state) throw new AppError("INTERNAL", "Failed to lock config asset state");
    const ids = input.assets.map((asset) => asset.id);
    const rows = await tx
      .select()
      .from(configAssets)
      .where(
        and(
          eq(configAssets.clientInstanceId, input.clientInstanceId),
          inArray(configAssets.id, ids)
        )
      )
      .for("update");
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const planned of input.assets) {
      const row = byId.get(planned.id);
      if (
        !row ||
        row.status !== "active" ||
        !assetScopesEqual(mapAssetScope(row), planned.from) ||
        row.activeRevisionId !== planned.activeRevisionId ||
        (row.publishedRevisionId ?? undefined) !== planned.publishedRevisionId
      ) {
        throw new AppError(
          "CONFLICT",
          "An asset of the move changed since the move was planned. Nothing was moved; check the move again.",
          { reason: "asset_moved_meanwhile", assetId: planned.id }
        );
      }
    }
    await tx
      .update(configAssets)
      .set({
        scopeKind: input.to.kind,
        scopeId: input.to.kind === "workspace" ? input.to.workspaceId : null,
        updatedAt: now
      })
      .where(
        and(
          eq(configAssets.clientInstanceId, input.clientInstanceId),
          inArray(configAssets.id, ids)
        )
      );
    // The set changed for every reader that keys on its version, such as a workspace's agents.
    const version = state.version + 1;
    await tx
      .update(configAssetState)
      .set({ version, updatedAt: now })
      .where(eq(configAssetState.clientInstanceId, input.clientInstanceId));
    return { version };
  });
}
