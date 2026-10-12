import { containsPattern } from "./like-pattern";
import { keysetFilter } from "./paging";
import { and, asc, desc, eq, ilike, inArray, like, max, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  AppError,
  INSTANCE_ASSET_SCOPE,
  asClientInstanceId,
  assertConfigAssetBases,
  assetScopesEqual,
  createPlatformId,
  resolveInitialAgentAvailabilityMode,
  type ConfigAssetRecord,
  type ConfigAssetRevisionRecord,
  type ConfigAssetState,
  type ConfigAssetStore
} from "@vivd-catalyst/core";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import {
  mapAssetScope,
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
  fileSets,
  permissionGrants
} from "./schema";

/** The revision the published pointer of an asset names, joined beside the active one. */
const publishedRevisions = alias(configAssetRevisions, "published_revisions");
const publishedColumns = {
  id: publishedRevisions.id,
  revision: publishedRevisions.revision,
  fileSetId: publishedRevisions.fileSetId,
  config: publishedRevisions.config
};

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
  if (input.namePrefix !== undefined) {
    // A constant pattern, so the planner reads it as a range of the prefix index.
    conditions.push(like(configAssets.name, `${escapeLikePattern(input.namePrefix)}%`));
  }
  const rows = await db
    .select({ asset: configAssets, revision: configAssetRevisions })
    .from(configAssets)
    .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
    .where(and(...conditions))
    .orderBy(asc(configAssets.kind), asc(configAssets.name));
  return rows.map((row) => mapConfigAsset(row.asset, row.revision));
}

/**
 * How many asset keys one read of a list takes while it looks for the rows its caller may
 * read. A caller who may read everything needs one read per page. A caller who may read
 * little needs one per this many assets that match the filter, until the page is full.
 */
const ASSET_LIST_SCAN_BATCH = 1000;

export async function listConfigAssetPage(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["listConfigAssetPage"]>[0]
): Promise<ConfigAssetRecord[]> {
  const conditions = [
    eq(configAssets.clientInstanceId, input.clientInstanceId),
    eq(configAssets.kind, input.kind),
    eq(configAssets.status, "active"),
    input.scope.kind === "workspace"
      ? and(
          eq(configAssets.scopeKind, "workspace"),
          eq(configAssets.scopeId, input.scope.workspaceId)
        )
      : eq(configAssets.scopeKind, "instance")
  ];
  if (input.namePrefix !== undefined) {
    // A constant pattern, so the planner reads it as a range of the prefix index.
    conditions.push(like(configAssets.name, `${escapeLikePattern(input.namePrefix)}%`));
  }
  if (input.nameContains !== undefined) {
    conditions.push(ilike(configAssets.name, containsPattern(input.nameContains)));
  }
  // Byte order through the operators of the prefix index: one index range answers the
  // filter, the cursor and the order, under any collation of the database.
  const ids: string[] = [];
  let afterName = input.afterName;
  while (ids.length < input.limit) {
    const keys = await db
      .select({
        id: configAssets.id,
        kind: configAssets.kind,
        name: configAssets.name,
        scopeKind: configAssets.scopeKind,
        scopeId: configAssets.scopeId,
        publishedRevisionId: configAssets.publishedRevisionId
      })
      .from(configAssets)
      .where(
        and(
          ...conditions,
          afterName === undefined ? undefined : sql`${configAssets.name} ~>~ ${afterName}`
        )
      )
      .orderBy(sql`${configAssets.name} using ~<~`)
      .limit(ASSET_LIST_SCAN_BATCH);
    for (const key of keys) {
      if (
        ids.length < input.limit &&
        input.readable({
          id: key.id,
          kind: key.kind,
          name: key.name,
          scope: mapAssetScope(key),
          published: key.publishedRevisionId !== null
        })
      ) {
        ids.push(key.id);
      }
    }
    const last = keys.at(-1);
    if (keys.length < ASSET_LIST_SCAN_BATCH || !last) {
      break;
    }
    afterName = last.name;
  }
  if (ids.length === 0) {
    return [];
  }
  const rows = await db
    .select({ asset: configAssets, revision: configAssetRevisions, published: publishedColumns })
    .from(configAssets)
    .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
    .leftJoin(publishedRevisions, eq(publishedRevisions.id, configAssets.publishedRevisionId))
    .where(and(inArray(configAssets.id, ids), eq(configAssets.status, "active")));
  const byId = new Map(rows.map((row) => [row.asset.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [mapConfigAsset(row.asset, row.revision, row.published)] : [];
  });
}

export async function getConfigAsset(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["getConfigAsset"]>[0]
): Promise<ConfigAssetRecord | undefined> {
  const read = db
    .select({ asset: configAssets, revision: configAssetRevisions, published: publishedColumns })
    .from(configAssets)
    .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
    .leftJoin(publishedRevisions, eq(publishedRevisions.id, configAssets.publishedRevisionId))
    .where(
      and(
        eq(configAssets.clientInstanceId, input.clientInstanceId),
        eq(configAssets.kind, input.kind),
        eq(configAssets.name, input.name)
      )
    )
    .limit(1);
  // Every write of an asset updates its row, so a shared lock on that row makes it wait.
  const [row] = await (input.lock === "share" ? read.for("share", { of: configAssets }) : read);
  return row ? mapConfigAsset(row.asset, row.revision, row.published) : undefined;
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
  const newestFirst = input.newestFirst === true;
  const rows = await db
    .select()
    .from(configAssetRevisions)
    .where(
      and(
        eq(configAssetRevisions.clientInstanceId, input.clientInstanceId),
        eq(configAssetRevisions.assetId, asset.id),
        keysetFilter(input.page, [configAssetRevisions.revision], newestFirst)
      )
    )
    .orderBy(newestFirst ? desc(configAssetRevisions.revision) : asc(configAssetRevisions.revision))
    .limit(input.page?.limit ?? 2147483647);
  return rows.map(mapConfigAssetRevision);
}

export async function getConfigAssetRevision(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["getConfigAssetRevision"]>[0]
): Promise<ConfigAssetRevisionRecord | undefined> {
  const [row] = await db
    .select({ revision: configAssetRevisions })
    .from(configAssetRevisions)
    .innerJoin(configAssets, eq(configAssets.id, configAssetRevisions.assetId))
    .where(
      and(
        eq(configAssets.clientInstanceId, input.clientInstanceId),
        eq(configAssets.kind, input.kind),
        eq(configAssets.name, input.name),
        eq(configAssetRevisions.clientInstanceId, input.clientInstanceId),
        eq(configAssetRevisions.revision, input.revision)
      )
    )
    .limit(1);
  return row ? mapConfigAssetRevision(row.revision) : undefined;
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
    for (const mutation of input.mutations) {
      if (mutation.type === "setDefaultAgent") {
        continue;
      }
      const [row] = await tx
        .select({ asset: configAssets, revision: configAssetRevisions })
        .from(configAssets)
        .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
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

    // A batch of draft writes alone leaves the set the runtime reads as it is, so its version
    // stays: a draft is no part of the runtime snapshot.
    const draftsOnly =
      input.mutations.length > 0 &&
      input.mutations.every((mutation) => mutation.type === "upsert" && mutation.draft === true);
    const version = draftsOnly ? state.version : state.version + 1;
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
      // A mutation that names no scope means the instance's own assets. It never reaches an
      // asset a workspace owns, and a write never moves an asset: the name stays with its
      // owner, also across a delete.
      const scope = mutation.scope ?? INSTANCE_ASSET_SCOPE;
      if (asset && !assetScopesEqual(scope, mapAssetScope(asset))) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Config ${mutation.kind} '${mutation.name}' belongs to another scope`,
          { reason: "invalid_scope" }
        );
      }
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
        // The row is reused when the name is created again, so an allow on this asset must not
        // come back with the next one. A deny stays: the retained revisions are still the
        // content it refuses, and whoever restores the name restores that content.
        await tx
          .delete(permissionGrants)
          .where(
            and(
              eq(permissionGrants.clientInstanceId, input.clientInstanceId),
              eq(permissionGrants.scopeKind, "asset"),
              eq(permissionGrants.scopeId, asset.id),
              eq(permissionGrants.effect, "allow")
            )
          );
        continue;
      }

      if (asset && mutation.assetId !== undefined && mutation.assetId !== asset.id) {
        throw new AppError(
          "CONFLICT",
          `Config ${mutation.kind} '${mutation.name}' exists under another id`,
          { kind: mutation.kind, name: mutation.name }
        );
      }
      if (!asset) {
        const assetId = mutation.assetId ?? createPlatformId("cfga");
        const revisionId = createPlatformId("cfgr");
        await tx.insert(configAssets).values({
          id: assetId,
          clientInstanceId: input.clientInstanceId,
          kind: mutation.kind,
          name: mutation.name,
          scopeKind: scope.kind,
          scopeId: scope.kind === "workspace" ? scope.workspaceId : null,
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
          fileSetId: mutation.fileSetId ?? null,
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
        fileSetId: mutation.fileSetId,
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

    if (!draftsOnly) {
      await tx
        .update(configAssetState)
        .set({
          version,
          defaultAgentName: defaultAgentName ?? null,
          updatedAt: now
        })
        .where(eq(configAssetState.clientInstanceId, input.clientInstanceId));
    }
    return { version };
  });
}

/**
 * Removes what a workspace owns, in the transaction that removes the workspace. An asset
 * belongs to its owner: once the workspace is gone nothing could read or write it, so its
 * rows go with it, revisions and availability through their own keys, and the grant rows that
 * name one of them here. The foreign key on `scope_id` refuses a workspace delete that skips
 * this.
 *
 * It takes the lock every asset write takes, after the caller's lock on the workspace. A
 * write that creates an asset in this workspace at the same moment holds the two the other
 * way round; the database then ends one of the two transactions, and the call is repeated.
 */
export async function deleteWorkspaceOwnedAssets(
  tx: PostgresTransaction,
  input: { clientInstanceId: string; collaborationWorkspaceId: string }
): Promise<void> {
  const owned = and(
    eq(configAssets.clientInstanceId, input.clientInstanceId),
    eq(configAssets.scopeKind, "workspace"),
    eq(configAssets.scopeId, input.collaborationWorkspaceId)
  );
  // The grant rows that name the workspace itself as their scope cover what it owns.
  await tx
    .delete(permissionGrants)
    .where(
      and(
        eq(permissionGrants.clientInstanceId, input.clientInstanceId),
        eq(permissionGrants.scopeKind, "workspace"),
        eq(permissionGrants.scopeId, input.collaborationWorkspaceId)
      )
    );
  const [any] = await tx.select({ id: configAssets.id }).from(configAssets).where(owned).limit(1);
  if (!any) {
    return;
  }
  const [state] = await tx
    .select()
    .from(configAssetState)
    .where(eq(configAssetState.clientInstanceId, input.clientInstanceId))
    .for("update")
    .limit(1);
  const removed = await tx
    .delete(configAssets)
    .where(owned)
    .returning({ id: configAssets.id, kind: configAssets.kind, name: configAssets.name });
  const removedIds = removed.map((asset) => asset.id);
  await tx
    .delete(permissionGrants)
    .where(
      and(
        eq(permissionGrants.clientInstanceId, input.clientInstanceId),
        eq(permissionGrants.scopeKind, "asset"),
        inArray(permissionGrants.scopeId, removedIds)
      )
    );
  // The rows of the file sets go with their owners. The stored objects of an asset lie below
  // its own prefix and are removed by whoever removes the workspace's stored data.
  await tx
    .delete(fileSets)
    .where(
      and(
        eq(fileSets.clientInstanceId, asClientInstanceId(input.clientInstanceId)),
        eq(fileSets.ownerKind, "asset"),
        inArray(fileSets.ownerId, removedIds)
      )
    );
  if (!state) {
    return;
  }
  // The set changed, so its version moves, and a default that named a removed agent is gone.
  const defaultRemoved = removed.some(
    (asset) => asset.kind === "agent" && asset.name === state.defaultAgentName
  );
  await tx
    .update(configAssetState)
    .set({
      version: state.version + 1,
      ...(defaultRemoved ? { defaultAgentName: null } : {}),
      updatedAt: new Date()
    })
    .where(eq(configAssetState.clientInstanceId, input.clientInstanceId));
}

function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

export async function findConfigAssetRow(
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
    fileSetId?: ConfigAssetRevisionRecord["fileSetId"];
    actor: Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0]["actor"];
    origin: ConfigAssetRevisionRecord["origin"];
    globalVersion: number;
    now: Date;
    status: ConfigAssetRecord["status"];
  }
): Promise<void> {
  // The highest number, not the active one: after a discarded draft the active revision is an
  // older one, and a number is never used twice.
  const [newest] = await tx
    .select({ revision: max(configAssetRevisions.revision) })
    .from(configAssetRevisions)
    .where(eq(configAssetRevisions.assetId, input.asset.id));
  const activeRevision = newest?.revision == null ? undefined : { revision: newest.revision };
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
    fileSetId: input.fileSetId ?? null,
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
