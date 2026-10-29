import { appAvailabilityColumn } from "./app-availability";
import {
  asc,
  getTableColumns,
  and,
  eq,
  ilike,
  inArray,
  like,
  or,
  sql,
  type SQLWrapper
} from "drizzle-orm";
import type { ConfigAssetRecord, ConfigAssetStore } from "@work-shape/catalyst-core";
import { containsPattern, prefixPattern } from "./like-pattern";
import { publishedColumns, publishedRevisions } from "./postgres-config-asset-revisions";
import type { PostgresConnection } from "./postgres-database";
import { mapAssetScope, mapConfigAsset, withPersonTitle } from "./rows";
import { configAssetRevisions, configAssets } from "./schema";

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
      ? or(
          input.kind === "app"
            ? sql`${appAvailabilityColumn}->>'audience' = 'instance'`
            : undefined,
          and(
            eq(configAssets.scopeKind, "workspace"),
            eq(configAssets.scopeId, input.scope.workspaceId)
          )
        )
      : or(
          input.kind === "app"
            ? sql`${appAvailabilityColumn}->>'audience' = 'instance'`
            : undefined,
          eq(configAssets.scopeKind, "instance")
        )
  ];
  if (input.namePrefix !== undefined) {
    // A constant pattern, so the planner reads it as a range of the prefix index.
    conditions.push(like(configAssets.name, prefixPattern(input.namePrefix)));
  }
  const { text } = input;
  if (text !== undefined) {
    // What the title can be read from holds the text: the store cannot read a kind's title,
    // so this keeps every asset with a string value that may match, and `titleOf` decides
    // below. A value is matched decoded: the JSON text of a config escapes `"` and `\`.
    const pattern = containsPattern(text.contains);
    const holdsString = (config: SQLWrapper) => sql`exists (
      select from jsonb_path_query(${config}, 'strict $.** ? (@.type() == "string")') as value
      where value #>> '{}' ilike ${pattern})`;
    conditions.push(
      or(
        ilike(configAssets.name, pattern),
        ilike(configAssets.personTitle, pattern),
        holdsString(configAssetRevisions.config),
        holdsString(publishedRevisions.config)
      )
    );
  }
  // Byte order through the operators of the prefix index: one index range answers the
  // filter, the cursor and the order, under any collation of the database.
  const ids: string[] = [];
  let afterName = input.afterName;
  while (ids.length < input.limit) {
    const keys = await db
      .select({
        appAvailability: appAvailabilityColumn,
        id: configAssets.id,
        kind: configAssets.kind,
        name: configAssets.name,
        scopeKind: configAssets.scopeKind,
        scopeId: configAssets.scopeId,
        publishedRevisionId: configAssets.publishedRevisionId,
        // Read only where a search asks for the title.
        config: text === undefined ? sql<null>`null` : configAssetRevisions.config,
        publishedConfig: text === undefined ? sql<null>`null` : publishedRevisions.config,
        personTitle: configAssets.personTitle
      })
      .from(configAssets)
      .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
      .leftJoin(publishedRevisions, eq(publishedRevisions.id, configAssets.publishedRevisionId))
      .where(
        and(
          ...conditions,
          afterName === undefined ? undefined : sql`${configAssets.name} ~>~ ${afterName}`
        )
      )
      .orderBy(sql`${configAssets.name} using ~<~`)
      .limit(ASSET_LIST_SCAN_BATCH);
    for (const key of keys) {
      if (ids.length >= input.limit) break;
      const asset = {
        ...(key.appAvailability ? { appAvailability: key.appAvailability } : {}),
        id: key.id,
        kind: key.kind,
        name: key.name,
        scope: mapAssetScope(key),
        published: key.publishedRevisionId !== null
      };
      if (!input.readable(asset)) continue;
      const holds = (value: string) =>
        text === undefined || value.toLowerCase().includes(text.contains.toLowerCase());
      if (
        holds(key.name) ||
        holds(
          text?.titleOf(asset, {
            ...(key.config ? { active: withPersonTitle(key.config, key.personTitle) } : {}),
            ...(key.publishedConfig
              ? { published: withPersonTitle(key.publishedConfig, key.personTitle) }
              : {})
          }) ?? ""
        )
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
    .select({
      asset: configAssets,
      revision: configAssetRevisions,
      published: publishedColumns,
      appAvailability: appAvailabilityColumn
    })
    .from(configAssets)
    .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
    .leftJoin(publishedRevisions, eq(publishedRevisions.id, configAssets.publishedRevisionId))
    .where(and(inArray(configAssets.id, ids), eq(configAssets.status, "active")));
  const byId = new Map(rows.map((row) => [row.asset.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [mapConfigAsset(row.asset, row.revision, row.published, row.appAvailability)] : [];
  });
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
  if (input.afterName !== undefined) {
    conditions.push(sql`${configAssets.name} ~>~ ${input.afterName}`);
  }
  const query = db
    .select({
      asset: configAssets,
      revision: input.withoutSkillResources ? revisionWithoutSkillResources : configAssetRevisions
    })
    .from(configAssets)
    .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
    .where(and(...conditions))
    .orderBy(asc(configAssets.kind), sql`${configAssets.name} using ~<~`)
    .$dynamic();
  const rows = await (input.limit === undefined ? query : query.limit(input.limit));
  return rows.map((row) => mapConfigAsset(row.asset, row.revision));
}
