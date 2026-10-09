import { keysetFilter } from "./paging";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  AppError,
  assertConfigAssetBases,
  createPlatformId,
  resolveInitialAgentAvailabilityMode,
  type AgentAvailability,
  type ConfigAssetRecord,
  type ConfigAssetRevisionRecord,
  type ConfigAssetState,
  type ConfigAssetStore
} from "@vivd-catalyst/core";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import {
  mapConfigAsset,
  mapConfigAssetRevision,
  mapConfigAssetState,
  type ConfigAssetRow
} from "./rows";
import {
  configAssetAvailability,
  configAssetRevisions,
  configAssets,
  configAssetState,
  configAssetWorkspaceAvailability,
  permissionGrants
} from "./schema";

export async function getConfigAssetState(
  db: PostgresConnection,
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
  db: PostgresConnection,
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
    .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
    .where(and(...conditions))
    .orderBy(asc(configAssets.kind), asc(configAssets.name));
  return rows.map((row) => mapConfigAsset(row.asset, row.revision));
}

export async function getConfigAsset(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["getConfigAsset"]>[0]
): Promise<ConfigAssetRecord | undefined> {
  const [row] = await db
    .select({ asset: configAssets, revision: configAssetRevisions })
    .from(configAssets)
    .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
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
  db: PostgresConnection,
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
        eq(configAssetRevisions.assetId, asset.id),
        keysetFilter(input.page, [configAssetRevisions.revision], false)
      )
    )
    .orderBy(asc(configAssetRevisions.revision))
    .limit(input.page?.limit ?? 2147483647);
  return rows.map(mapConfigAssetRevision);
}

export async function applyConfigAssetMutations(
  db: PostgresConnection,
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
    const current = new Map<
      string,
      { status: "active" | "deleted"; revision: ConfigAssetRevisionRecord }
    >();
    if (input.baseRevisions !== undefined) {
      for (const mutation of input.mutations) {
        if (mutation.type === "setDefaultAgent") {
          continue;
        }
        const [row] = await tx
          .select({ asset: configAssets, revision: configAssetRevisions })
          .from(configAssets)
          .innerJoin(
            configAssetRevisions,
            eq(configAssetRevisions.id, configAssets.activeRevisionId)
          )
          .where(
            and(
              eq(configAssets.clientInstanceId, input.clientInstanceId),
              eq(configAssets.kind, mutation.kind),
              eq(configAssets.name, mutation.name)
            )
          )
          .limit(1);
        if (row) {
          current.set(`${mutation.kind}:${mutation.name}`, {
            status: row.asset.status,
            revision: mapConfigAssetRevision(row.revision)
          });
        }
      }
    }
    assertConfigAssetBases(input, mapConfigAssetState(state), current);

    const deletedAgentNames = input.mutations.flatMap((mutation) =>
      mutation.type === "delete" && mutation.kind === "agent" ? [mutation.name] : []
    );
    const [deletedSelectedAgent] =
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
                inArray(configAssets.name, deletedAgentNames),
                eq(configAssetAvailability.mode, "selected")
              )
            )
            .limit(1)
        : [];
    const initialAgentMode = resolveInitialAgentAvailabilityMode(
      input.initialAgentAvailability,
      deletedSelectedAgent !== undefined
    );
    const insertInitialAvailability = (assetId: string) =>
      tx.insert(configAssetAvailability).values({
        assetId,
        clientInstanceId: input.clientInstanceId,
        mode: initialAgentMode,
        personalWorkspaces: false,
        updatedAt: now
      });

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
          origin: input.origin,
          globalVersion: version,
          now,
          status: "deleted"
        });
        await tx
          .delete(configAssetAvailability)
          .where(eq(configAssetAvailability.assetId, asset.id));
        // The row is reused when the name is created again, so a grant on this asset must not
        // come back with the next one.
        await tx
          .delete(permissionGrants)
          .where(
            and(
              eq(permissionGrants.clientInstanceId, input.clientInstanceId),
              eq(permissionGrants.scopeKind, "asset"),
              eq(permissionGrants.scopeId, asset.id)
            )
          );
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
          origin: input.origin ?? null,
          globalVersion: version,
          createdAt: now
        });
        if (mutation.kind === "agent") {
          await insertInitialAvailability(assetId);
        }
        continue;
      }

      await appendAndActivateRevision(tx, {
        asset,
        operation: mutation.operation ?? (asset.status === "deleted" ? "create" : "update"),
        config: mutation.config,
        actor: input.actor,
        origin: input.origin,
        globalVersion: version,
        now,
        status: "active"
      });
      if (asset.kind === "agent" && asset.status === "deleted") {
        await insertInitialAvailability(asset.id);
      }
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
      const [availability] = await tx
        .select({ mode: configAssetAvailability.mode })
        .from(configAssetAvailability)
        .where(eq(configAssetAvailability.assetId, defaultAgent.id))
        .limit(1);
      if (availability?.mode !== "all") {
        throw new AppError(
          "VALIDATION_FAILED",
          `Default agent '${defaultAgentName}' must be available in all workspaces`
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
        eq(configAssets.status, "active")
      )
    );
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
    .where(eq(configAssetAvailability.clientInstanceId, input.clientInstanceId))
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
    // Serializes with default-agent changes, which lock the same row.
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
    return { ...input.availability, collaborationWorkspaceIds };
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
    origin: ConfigAssetRevisionRecord["origin"];
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
    origin: input.origin ?? null,
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
