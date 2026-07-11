import { and, asc, eq } from "drizzle-orm";
import {
  AppError,
  createPlatformId,
  type ConfigAssetRecord,
  type ConfigAssetRevisionRecord,
  type ConfigAssetState,
  type ConfigAssetStore
} from "@vivd-catalyst/core";
import type { PostgresDatabase, PostgresTransaction } from "./postgres-database";
import {
  mapConfigAsset,
  mapConfigAssetRevision,
  mapConfigAssetState,
  type ConfigAssetRow
} from "./rows";
import { configAssetRevisions, configAssets, configAssetState } from "./schema";

export async function getConfigAssetState(
  db: PostgresDatabase,
  input: Parameters<ConfigAssetStore["getConfigAssetState"]>[0]
): Promise<ConfigAssetState> {
  const [row] = await db
    .select()
    .from(configAssetState)
    .where(eq(configAssetState.clientInstanceId, input.clientInstanceId))
    .limit(1);
  return mapConfigAssetState(row);
}

export async function listActiveConfigAssets(
  db: PostgresDatabase,
  input: Parameters<ConfigAssetStore["listActiveConfigAssets"]>[0]
): Promise<ConfigAssetRecord[]> {
  const conditions = [
    eq(configAssets.clientInstanceId, input.clientInstanceId),
    eq(configAssets.status, "active")
  ];
  if (input.kind !== undefined) {
    conditions.push(eq(configAssets.kind, input.kind));
  }
  const rows = await db
    .select({ asset: configAssets, revision: configAssetRevisions })
    .from(configAssets)
    .innerJoin(
      configAssetRevisions,
      eq(configAssetRevisions.id, configAssets.activeRevisionId)
    )
    .where(and(...conditions))
    .orderBy(asc(configAssets.kind), asc(configAssets.name));
  return rows.map((row) => mapConfigAsset(row.asset, row.revision));
}

export async function getConfigAsset(
  db: PostgresDatabase,
  input: Parameters<ConfigAssetStore["getConfigAsset"]>[0]
): Promise<ConfigAssetRecord | undefined> {
  const [row] = await db
    .select({ asset: configAssets, revision: configAssetRevisions })
    .from(configAssets)
    .innerJoin(
      configAssetRevisions,
      eq(configAssetRevisions.id, configAssets.activeRevisionId)
    )
    .where(
      and(
        eq(configAssets.clientInstanceId, input.clientInstanceId),
        eq(configAssets.kind, input.kind),
        eq(configAssets.name, input.name)
      )
    )
    .limit(1);
  return row ? mapConfigAsset(row.asset, row.revision) : undefined;
}

export async function listConfigAssetRevisions(
  db: PostgresDatabase,
  input: Parameters<ConfigAssetStore["listConfigAssetRevisions"]>[0]
): Promise<ConfigAssetRevisionRecord[]> {
  const [asset] = await db
    .select({ id: configAssets.id })
    .from(configAssets)
    .where(
      and(
        eq(configAssets.clientInstanceId, input.clientInstanceId),
        eq(configAssets.kind, input.kind),
        eq(configAssets.name, input.name)
      )
    )
    .limit(1);
  if (!asset) {
    return [];
  }
  const rows = await db
    .select()
    .from(configAssetRevisions)
    .where(
      and(
        eq(configAssetRevisions.clientInstanceId, input.clientInstanceId),
        eq(configAssetRevisions.assetId, asset.id)
      )
    )
    .orderBy(asc(configAssetRevisions.revision));
  return rows.map(mapConfigAssetRevision);
}

export async function applyConfigAssetMutations(
  db: PostgresDatabase,
  input: Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0]
): Promise<{ version: number }> {
  return db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .insert(configAssetState)
      .values({
        clientInstanceId: input.clientInstanceId,
        version: 0,
        defaultAgentName: null,
        updatedAt: now
      })
      .onConflictDoNothing();
    const [state] = await tx
      .select()
      .from(configAssetState)
      .where(eq(configAssetState.clientInstanceId, input.clientInstanceId))
      .for("update")
      .limit(1);
    if (!state) {
      throw new AppError("INTERNAL", "Failed to lock config asset state");
    }
    if (input.baseVersion !== undefined && input.baseVersion !== state.version) {
      throw new AppError("CONFLICT", "Config version mismatch", {
        currentVersion: state.version,
        baseVersion: input.baseVersion
      });
    }

    const version = state.version + 1;
    let defaultAgentName = state.defaultAgentName ?? undefined;
    for (const mutation of input.mutations) {
      if (mutation.type === "setDefaultAgent") {
        defaultAgentName = mutation.agentName;
        continue;
      }
      const asset = await findConfigAssetRow(tx, {
        clientInstanceId: input.clientInstanceId,
        kind: mutation.kind,
        name: mutation.name
      });
      if (mutation.type === "delete") {
        if (!asset || asset.status === "deleted") {
          continue;
        }
        await appendAndActivateRevision(tx, {
          asset,
          operation: "delete",
          config: null,
          actor: input.actor,
          globalVersion: version,
          now,
          status: "deleted"
        });
        continue;
      }

      if (!asset) {
        const assetId = createPlatformId("cfga");
        const revisionId = createPlatformId("cfgr");
        await tx.insert(configAssets).values({
          id: assetId,
          clientInstanceId: input.clientInstanceId,
          kind: mutation.kind,
          name: mutation.name,
          status: "active",
          activeRevisionId: revisionId,
          createdAt: now,
          updatedAt: now
        });
        await tx.insert(configAssetRevisions).values({
          id: revisionId,
          clientInstanceId: input.clientInstanceId,
          assetId,
          revision: 1,
          operation: mutation.operation ?? "create",
          config: mutation.config,
          actor: input.actor ?? null,
          globalVersion: version,
          createdAt: now
        });
        continue;
      }

      await appendAndActivateRevision(tx, {
        asset,
        operation: mutation.operation ?? (asset.status === "deleted" ? "create" : "update"),
        config: mutation.config,
        actor: input.actor,
        globalVersion: version,
        now,
        status: "active"
      });
    }

    if (defaultAgentName !== undefined) {
      const defaultAgent = await findConfigAssetRow(tx, {
        clientInstanceId: input.clientInstanceId,
        kind: "agent",
        name: defaultAgentName
      });
      if (!defaultAgent || defaultAgent.status !== "active") {
        throw new AppError(
          "VALIDATION_FAILED",
          `Default agent '${defaultAgentName}' is not an active config asset`
        );
      }
    }

    await tx
      .update(configAssetState)
      .set({
        version,
        defaultAgentName: defaultAgentName ?? null,
        updatedAt: now
      })
      .where(eq(configAssetState.clientInstanceId, input.clientInstanceId));
    return { version };
  });
}

async function findConfigAssetRow(
  tx: PostgresTransaction,
  input: Parameters<ConfigAssetStore["getConfigAsset"]>[0]
): Promise<ConfigAssetRow | undefined> {
  const [row] = await tx
    .select()
    .from(configAssets)
    .where(
      and(
        eq(configAssets.clientInstanceId, input.clientInstanceId),
        eq(configAssets.kind, input.kind),
        eq(configAssets.name, input.name)
      )
    )
    .limit(1);
  return row;
}

async function appendAndActivateRevision(
  tx: PostgresTransaction,
  input: {
    asset: ConfigAssetRow;
    operation: ConfigAssetRevisionRecord["operation"];
    config: ConfigAssetRevisionRecord["config"];
    actor: Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0]["actor"];
    globalVersion: number;
    now: Date;
    status: ConfigAssetRecord["status"];
  }
): Promise<void> {
  const [activeRevision] = await tx
    .select({ revision: configAssetRevisions.revision })
    .from(configAssetRevisions)
    .where(eq(configAssetRevisions.id, input.asset.activeRevisionId))
    .limit(1);
  if (!activeRevision) {
    throw new AppError("INTERNAL", "Config asset active revision is missing");
  }
  const revisionId = createPlatformId("cfgr");
  await tx.insert(configAssetRevisions).values({
    id: revisionId,
    clientInstanceId: input.asset.clientInstanceId,
    assetId: input.asset.id,
    revision: activeRevision.revision + 1,
    operation: input.operation,
    config: input.config,
    actor: input.actor ?? null,
    globalVersion: input.globalVersion,
    createdAt: input.now
  });
  await tx
    .update(configAssets)
    .set({
      status: input.status,
      activeRevisionId: revisionId,
      updatedAt: input.now
    })
    .where(eq(configAssets.id, input.asset.id));
}
