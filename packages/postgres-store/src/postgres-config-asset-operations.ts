import { prefixPattern } from "./like-pattern";
import { keysetFilter } from "./paging";
import { and, asc, desc, eq, getTableColumns, inArray, like, max, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  AppError,
  INSTANCE_ASSET_SCOPE,
  asClientInstanceId,
  assertConfigAssetBases,
  assetScopesEqual,
  createPlatformId,
  type ConfigAssetRecord,
  type ConfigAssetRevisionRecord,
  type ConfigAssetState,
  type ConfigAssetStore
} from "@work-shape/catalyst-core";
import * as repo from "./postgres-asset-repo-operations";
import {
  insertInitialAgentAvailability,
  resolveBatchInitialAvailability
} from "./postgres-initial-agent-availability";
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
export const publishedRevisions = alias(configAssetRevisions, "published_revisions");
export const publishedColumns = {
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

/** A revision whose config, for a skill, is left without its resources in the database. */
const revisionWithoutSkillResources = {
  ...getTableColumns(configAssetRevisions),
  config:
    sql`case when ${configAssets.kind} = 'skill' then ${configAssetRevisions.config} - 'resources' else ${configAssetRevisions.config} end`.mapWith(
      configAssetRevisions.config
    )
};

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
    conditions.push(like(configAssets.name, prefixPattern(input.namePrefix)));
  }
  const rows = await db
    .select({
      asset: configAssets,
      revision: input.withoutSkillResources ? revisionWithoutSkillResources : configAssetRevisions
    })
    .from(configAssets)
    .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
    .where(and(...conditions))
    .orderBy(asc(configAssets.kind), asc(configAssets.name));
  return rows.map((row) => mapConfigAsset(row.asset, row.revision));
}

export async function listPublishedConfigAssets(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["listPublishedConfigAssets"]>[0]
): Promise<ConfigAssetRecord[]> {
  if (input.names?.length === 0) {
    return [];
  }
  const rows = await db
    .select({ asset: configAssets, revision: configAssetRevisions, published: publishedColumns })
    .from(configAssets)
    .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
    .innerJoin(publishedRevisions, eq(publishedRevisions.id, configAssets.publishedRevisionId))
    .where(
      and(
        eq(configAssets.clientInstanceId, input.clientInstanceId),
        eq(configAssets.kind, input.kind),
        eq(configAssets.status, "active"),
        input.names === undefined ? undefined : inArray(configAssets.name, [...input.names])
      )
    )
    // Byte order through the operators of the prefix index, as a page of a list is read.
    .orderBy(sql`${configAssets.name} using ~<~`)
    .limit(input.limit);
  return rows.map((row) => mapConfigAsset(row.asset, row.revision, row.published));
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

/**
 * How many rows one statement of a batch writes. A batch of 2,000 assets is written in a
 * handful of statements, so the time the lock is held grows with the bytes and not with a
 * round trip per asset.
 */
const ASSET_WRITE_CHUNK = 500;

/** One asset as a batch leaves it, followed through the mutations that name it. */
interface WrittenAsset {
  id: string;
  kind: string;
  /** Whether the row is there before the batch. */
  stored: boolean;
  status: ConfigAssetRecord["status"];
  /** The highest revision number of the asset, the ones this batch adds included. */
  newest: number;
  activeRevisionId: string;
  /** The batch gave it a revision. */
  written: boolean;
  /** The batch deleted it, whatever it did to it afterwards. */
  deleted: boolean;
  /** An agent that is there after a create: it starts with an availability of its own. */
  created: boolean;
}

export async function applyConfigAssetMutations(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0]
): ReturnType<ConfigAssetStore["applyConfigAssetMutations"]> {
  await repo.assertRepoObjects(input);
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
    const keyOf = (address: { kind: string; name: string }) => `${address.kind}:${address.name}`;
    const named = input.mutations.flatMap((mutation) =>
      mutation.type === "setDefaultAgent" ? [] : [{ kind: mutation.kind, name: mutation.name }]
    );
    // Every row the batch names and the highest revision number of each, in one read each.
    const rows = await selectAssetRowsByKey(tx, input.clientInstanceId, named);
    const current = new Map(
      rows.map((row) => [
        keyOf(row.asset),
        {
          id: row.asset.id,
          status: row.asset.status,
          revision: mapConfigAssetRevision(row.revision)
        }
      ])
    );
    const repoWrites = repo.lockedRepoWrites(input.mutations, rows);
    const kept = repo.tombstoneColumns(rows);
    assertConfigAssetBases(input, mapConfigAssetState(state), current);
    await input.validate?.({
      state: mapConfigAssetState(state),
      listActiveRevisionIds: async () =>
        (
          await tx
            .select({ id: configAssets.activeRevisionId })
            .from(configAssets)
            .where(
              and(
                eq(configAssets.clientInstanceId, input.clientInstanceId),
                eq(configAssets.status, "active")
              )
            )
        ).map((row) => row.id),
      listActiveConfigAssets: () =>
        listActiveConfigAssets(tx, { clientInstanceId: input.clientInstanceId })
    });
    const newest = await selectNewestRevisions(
      tx,
      rows.map((row) => row.asset.id)
    );

    const initialAgentAvailability = await resolveBatchInitialAvailability(tx, input);

    // A batch of draft writes alone leaves the set the runtime reads as it is, so its version
    // stays: a draft is no part of the runtime snapshot.
    const draftsOnly =
      input.mutations.length > 0 &&
      input.mutations.every((mutation) => mutation.type === "upsert" && mutation.draft === true);
    const version = draftsOnly ? state.version : state.version + 1;
    let defaultAgentName = state.defaultAgentName ?? undefined;

    // The batch is worked out in memory, in the order of its mutations, and written after it
    // in one statement per table.
    const assets = new Map<string, WrittenAsset>(
      rows.map((row) => [
        keyOf(row.asset),
        {
          id: row.asset.id,
          kind: row.asset.kind,
          stored: true,
          status: row.asset.status,
          newest: newest.get(row.asset.id) ?? row.revision.revision,
          activeRevisionId: row.asset.activeRevisionId,
          written: false,
          deleted: false,
          created: false
        }
      ])
    );
    const scopes = new Map(rows.map((row) => [keyOf(row.asset), mapAssetScope(row.asset)]));
    const newAssets: (typeof configAssets.$inferInsert)[] = [];
    const newRevisions: (typeof configAssetRevisions.$inferInsert)[] = [];
    const revisions: Record<string, number> = {};
    const assetIds: Record<string, string> = {};
    const appendRevision = (
      key: string,
      asset: WrittenAsset,
      revision: Pick<
        typeof configAssetRevisions.$inferInsert,
        "operation" | "config" | "fileSetId" | "commit" | "tree"
      >,
      status: ConfigAssetRecord["status"]
    ) => {
      const id = createPlatformId("cfgr");
      // The highest number, not the active one: after a discarded draft the active revision is
      // an older one, and a number is never used twice.
      asset.newest += 1;
      asset.activeRevisionId = id;
      asset.status = status;
      asset.written = true;
      revisions[key] = asset.newest;
      assetIds[key] = asset.id;
      newRevisions.push({
        id,
        clientInstanceId: input.clientInstanceId,
        assetId: asset.id,
        revision: asset.newest,
        ...revision,
        actor: input.actor ?? null,
        origin: input.origin ?? null,
        globalVersion: version,
        createdAt: now
      });
    };
    for (const mutation of input.mutations) {
      if (mutation.type === "setDefaultAgent") {
        defaultAgentName = mutation.agentName;
        continue;
      }
      const key = keyOf(mutation);
      const asset = assets.get(key);
      // A mutation that names no scope means the instance's own assets. It never reaches an
      // asset a workspace owns, and a write never moves an asset: the name stays with its
      // owner, also across a delete.
      const scope = mutation.scope ?? INSTANCE_ASSET_SCOPE;
      const owner = scopes.get(key);
      if (owner && !assetScopesEqual(scope, owner)) {
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
        appendRevision(key, asset, { operation: "delete", config: null, ...kept(key) }, "deleted");
        asset.deleted = true;
        asset.created = false;
        continue;
      }
      if (asset && mutation.assetId !== undefined && mutation.assetId !== asset.id) {
        throw new AppError(
          "CONFLICT",
          `Config ${mutation.kind} '${mutation.name}' exists under another id`,
          { kind: mutation.kind, name: mutation.name }
        );
      }
      const written = repo.writtenColumns(mutation);
      if (!asset) {
        const created: WrittenAsset = {
          id: mutation.assetId ?? createPlatformId("cfga"),
          kind: mutation.kind,
          stored: false,
          status: "active",
          newest: 0,
          activeRevisionId: "",
          written: false,
          deleted: false,
          created: true
        };
        assets.set(key, created);
        scopes.set(key, scope);
        appendRevision(
          key,
          created,
          { operation: mutation.operation ?? "create", ...written },
          "active"
        );
        newAssets.push({
          id: created.id,
          clientInstanceId: input.clientInstanceId,
          kind: mutation.kind,
          name: mutation.name,
          scopeKind: scope.kind,
          scopeId: scope.kind === "workspace" ? scope.workspaceId : null,
          status: "active",
          activeRevisionId: created.activeRevisionId,
          createdAt: now,
          updatedAt: now
        });
        continue;
      }
      const recreated = asset.status === "deleted";
      appendRevision(
        key,
        asset,
        { operation: mutation.operation ?? (recreated ? "create" : "update"), ...written },
        "active"
      );
      asset.created ||= recreated;
    }

    const all = [...assets.values()];
    const writtenRows = all.filter((asset) => asset.written);
    for (const chunk of chunksOf(newAssets)) {
      await tx.insert(configAssets).values(chunk);
    }
    for (const chunk of chunksOf(newRevisions)) {
      await tx.insert(configAssetRevisions).values(chunk);
    }
    await repo.insertRepoWrites(tx, input.clientInstanceId, now, repoWrites, revisions, assetIds);
    // A row that is new in this batch was inserted as its first mutation left it.
    for (const chunk of chunksOf(writtenRows.filter((asset) => asset.stored || asset.newest > 1))) {
      await tx.execute(sql`
        update ${configAssets} as asset
        set status = written.status,
            active_revision_id = written.active_revision_id,
            updated_at = ${now.toISOString()}::timestamptz
        from (values ${sql.join(
          chunk.map((asset) => sql`(${asset.id}, ${asset.status}, ${asset.activeRevisionId})`),
          sql`, `
        )}) as written (id, status, active_revision_id)
        where asset.id = written.id
      `);
    }
    const deletedIds = all.filter((asset) => asset.deleted && asset.stored).map(({ id }) => id);
    if (deletedIds.length > 0) {
      // A deleted asset has no published revision. Whoever writes the name again makes a
      // draft, and the revision that is served is chosen anew by a publish, which asks who
      // may make it live. Without this a write brought the earlier published revision back.
      await tx
        .update(configAssets)
        .set({ publishedRevisionId: null })
        .where(inArray(configAssets.id, deletedIds));
      await tx
        .delete(configAssetAvailability)
        .where(inArray(configAssetAvailability.assetId, deletedIds));
      // The row is reused when the name is created again, so an allow on this asset must not
      // come back with the next one. A deny stays: the retained revisions are still the
      // content it refuses, and whoever restores the name restores that content.
      await tx
        .delete(permissionGrants)
        .where(
          and(
            eq(permissionGrants.clientInstanceId, input.clientInstanceId),
            eq(permissionGrants.scopeKind, "asset"),
            inArray(permissionGrants.scopeId, deletedIds),
            eq(permissionGrants.effect, "allow")
          )
        );
    }
    const createdAgents = all.filter(
      (asset) => asset.kind === "agent" && asset.created && asset.status === "active"
    );
    for (const chunk of chunksOf(createdAgents)) {
      await insertInitialAgentAvailability(tx, {
        clientInstanceId: input.clientInstanceId,
        assetIds: chunk.map((asset) => asset.id),
        availability: initialAgentAvailability,
        now
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
    return { version, revisions, assetIds };
  });
}

function chunksOf<Row>(rows: readonly Row[]): Row[][] {
  const chunks: Row[][] = [];
  for (let start = 0; start < rows.length; start += ASSET_WRITE_CHUNK) {
    chunks.push(rows.slice(start, start + ASSET_WRITE_CHUNK));
  }
  return chunks;
}

/** The rows of the named assets with their active revisions, deleted ones included. */
async function selectAssetRowsByKey(
  db: PostgresConnection,
  clientInstanceId: string,
  keys: readonly { kind: string; name: string }[]
) {
  const namesByKind = new Map<string, Set<string>>();
  for (const { kind, name } of keys) {
    namesByKind.set(kind, (namesByKind.get(kind) ?? new Set()).add(name));
  }
  if (namesByKind.size === 0) {
    return [];
  }
  return db
    .select({ asset: configAssets, revision: configAssetRevisions, published: publishedColumns })
    .from(configAssets)
    .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
    .leftJoin(publishedRevisions, eq(publishedRevisions.id, configAssets.publishedRevisionId))
    .where(
      and(
        eq(configAssets.clientInstanceId, clientInstanceId),
        or(
          ...[...namesByKind].map(([kind, names]) =>
            and(eq(configAssets.kind, kind), inArray(configAssets.name, [...names]))
          )
        )
      )
    );
}

export async function listConfigAssetsByKey(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["listConfigAssetsByKey"]>[0]
): Promise<ConfigAssetRecord[]> {
  const rows = await selectAssetRowsByKey(db, input.clientInstanceId, input.keys);
  return rows.map((row) => mapConfigAsset(row.asset, row.revision, row.published));
}

/** The highest revision number of each asset, in one read. */
async function selectNewestRevisions(
  tx: PostgresTransaction,
  assetIds: readonly string[]
): Promise<Map<string, number>> {
  if (assetIds.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ assetId: configAssetRevisions.assetId, revision: max(configAssetRevisions.revision) })
    .from(configAssetRevisions)
    .where(inArray(configAssetRevisions.assetId, [...assetIds]))
    .groupBy(configAssetRevisions.assetId);
  return new Map(
    rows.flatMap((row) => (row.revision == null ? [] : [[row.assetId, row.revision]]))
  );
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
  await repo.sweepAssetRepoBundlesOf(tx, removedIds);
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
