import { and, asc, count, desc, eq, isNull, lt, max, or, sql, type SQL } from "drizzle-orm";
import {
  CONVERSATION_MAX_PAGES,
  PAGE_BUILD_KEEP_MS,
  PAGE_MAX_FILE_SETS,
  createPageId,
  isPageId,
  pageRefusal,
  type FileSet,
  type FileSetOwner,
  type FileSetSummary,
  type Page,
  type PageBuild,
  type PageId,
  type PagesStore,
  type ServedFileSet
} from "@work-shape/catalyst-core";
import { publishedRevisions } from "./postgres-config-asset-operations";
import type { PostgresConnection } from "./postgres-database";
import { configAssetRevisions, configAssets } from "./schema/configAssets";
import { conversations } from "./schema/conversations";
import { fileSets, pageBuilds, pages } from "./schema/pages";

// A file set is inserted and read, and deleted with its Page. Nothing here updates one.

type PageRow = typeof pages.$inferSelect;
type FileSetRow = typeof fileSets.$inferSelect;
type Input<Method extends keyof PagesStore> = Parameters<PagesStore[Method]>[0];

const summaryColumns = {
  id: fileSets.id,
  ownerId: fileSets.ownerId,
  number: fileSets.number,
  kitVersion: fileSets.kitVersion,
  sourceFileCount: fileSets.sourceFileCount,
  builtFileCount: fileSets.builtFileCount,
  totalBytes: fileSets.totalBytes,
  createdByUserId: fileSets.createdByUserId,
  createdAt: fileSets.createdAt
};

export async function ensurePage(
  db: PostgresConnection,
  input: Input<"ensurePage">
): Promise<Page> {
  return db.transaction(async (tx) => {
    // One conversation's Pages are counted and added one caller at a time. The lock is the
    // conversation's alone and is held for these three statements.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`pages:${input.conversationId}`}, 0))`
    );
    const ofName = and(
      eq(pages.clientInstanceId, input.clientInstanceId),
      eq(pages.conversationId, input.conversationId),
      eq(pages.name, input.name)
    );
    const [existing] = await tx.select().from(pages).where(ofName).limit(1);
    if (existing) {
      return mapPage(existing);
    }
    const [held] = await tx
      .select({ count: count() })
      .from(pages)
      .where(
        and(
          eq(pages.clientInstanceId, input.clientInstanceId),
          eq(pages.conversationId, input.conversationId)
        )
      );
    if ((held?.count ?? 0) >= CONVERSATION_MAX_PAGES) {
      throw pageRefusal(
        "page_limit",
        `This conversation holds ${CONVERSATION_MAX_PAGES} Pages, which is the most one conversation keeps (CONVERSATION_MAX_PAGES). Save under the name of an existing Page or start a new conversation.`,
        { limit: CONVERSATION_MAX_PAGES }
      );
    }
    const [created] = await tx
      .insert(pages)
      .values({
        id: createPageId(),
        clientInstanceId: input.clientInstanceId,
        conversationId: input.conversationId,
        name: input.name,
        createdAt: new Date(input.createdAt)
      })
      .returning();
    if (!created) {
      throw new Error("The Page was not stored");
    }
    return mapPage(created);
  });
}

export async function createPageFileSet(
  db: PostgresConnection,
  input: Input<"createPageFileSet">
): Promise<FileSet> {
  const { fileSet } = input;
  return db.transaction(async (tx) => {
    // The Page's row is the lock of its numbering: two saves of one Page get two numbers.
    const [page] = await tx
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.clientInstanceId, input.clientInstanceId), eq(pages.id, input.pageId)))
      .for("update");
    if (!page) {
      throw new Error("The Page of the file set does not exist");
    }
    const [held] = await tx
      .select({ count: count(), newest: max(fileSets.number) })
      .from(fileSets)
      .where(ownedByPage(input.pageId));
    if ((held?.count ?? 0) >= PAGE_MAX_FILE_SETS) {
      throw pageRefusal(
        "page_revision_limit",
        `This Page has ${PAGE_MAX_FILE_SETS} revisions, which is the most one Page keeps (PAGE_MAX_FILE_SETS). Save it under a new name to go on.`,
        { limit: PAGE_MAX_FILE_SETS }
      );
    }
    const row = await insertFileSet(tx, {
      clientInstanceId: input.clientInstanceId,
      owner: { kind: "page", id: input.pageId },
      number: (held?.newest ?? 0) + 1,
      fileSet
    });
    return mapFileSet(row);
  });
}

async function insertFileSet(
  tx: PostgresConnection,
  input: {
    clientInstanceId: FileSet["clientInstanceId"];
    owner: FileSetOwner;
    number: number;
    fileSet: Input<"createPageFileSet">["fileSet"];
  }
): Promise<FileSetRow> {
  const { fileSet } = input;
  const files = [...fileSet.sourceFiles, ...fileSet.builtFiles];
  const [row] = await tx
    .insert(fileSets)
    .values({
      id: fileSet.id,
      clientInstanceId: input.clientInstanceId,
      ownerKind: input.owner.kind,
      ownerId: input.owner.id,
      number: input.number,
      kitVersion: fileSet.kitVersion,
      manifest: fileSet.manifest,
      sourceFiles: fileSet.sourceFiles,
      builtFiles: fileSet.builtFiles,
      sourceFileCount: fileSet.sourceFiles.length,
      builtFileCount: fileSet.builtFiles.length,
      totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      createdByUserId: fileSet.createdByUserId,
      createdAt: new Date(fileSet.createdAt)
    })
    .returning();
  if (!row) {
    throw new Error("The file set was not stored");
  }
  return row;
}

function ownedByAsset(assetId: string) {
  return and(eq(fileSets.ownerKind, "asset"), eq(fileSets.ownerId, assetId));
}

export async function createAssetFileSet(
  db: PostgresConnection,
  input: Input<"createAssetFileSet">
): Promise<FileSet> {
  return db.transaction(async (tx) => {
    // The asset's row may not exist yet, so the numbering is held by a lock of its id alone.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`file-sets:asset:${input.assetId}`}, 0))`
    );
    const [held] = await tx
      .select({ newest: max(fileSets.number) })
      .from(fileSets)
      .where(ownedByAsset(input.assetId));
    const row = await insertFileSet(tx, {
      clientInstanceId: input.clientInstanceId,
      owner: { kind: "asset", id: input.assetId },
      number: (held?.newest ?? 0) + 1,
      fileSet: input.fileSet
    });
    return mapFileSet(row);
  });
}

export async function getAssetFileSet(
  db: PostgresConnection,
  input: Input<"getAssetFileSet">
): Promise<FileSet | undefined> {
  const [row] = await db
    .select()
    .from(fileSets)
    .where(
      and(
        eq(fileSets.clientInstanceId, input.clientInstanceId),
        ownedByAsset(input.assetId),
        eq(fileSets.id, input.fileSetId)
      )
    )
    .limit(1);
  return row ? mapFileSet(row) : undefined;
}

export async function deleteAssetFileSet(
  db: PostgresConnection,
  input: Input<"deleteAssetFileSet">
): Promise<boolean> {
  const removed = await db
    .delete(fileSets)
    .where(
      and(
        eq(fileSets.clientInstanceId, input.clientInstanceId),
        ownedByAsset(input.assetId),
        eq(fileSets.id, input.fileSetId),
        sql`not ${namedByRevision(input.assetId, input.fileSetId)}`
      )
    )
    .returning({ id: fileSets.id });
  return removed.length > 0;
}

/**
 * Whether a revision of the asset names the file set. Read by the asset's key: the revisions
 * of one asset are the rows it looks at.
 */
function namedByRevision(assetId: string | SQL, fileSetId: string | SQL): SQL<boolean> {
  return sql<boolean>`exists (select 1 from ${configAssetRevisions} where ${configAssetRevisions.assetId} = ${assetId} and ${configAssetRevisions.fileSetId} = ${fileSetId})`;
}

export async function listPages(
  db: PostgresConnection,
  input: Input<"listPages">
): Promise<Page[]> {
  const rows = await db
    .select()
    .from(pages)
    .where(
      and(
        eq(pages.clientInstanceId, input.clientInstanceId),
        eq(pages.conversationId, input.conversationId)
      )
    )
    .orderBy(asc(pages.createdAt), asc(pages.id));
  return rows.map(mapPage);
}

export async function getPage(
  db: PostgresConnection,
  input: Input<"getPage">
): Promise<Page | undefined> {
  const [row] = await db
    .select()
    .from(pages)
    .where(
      and(
        eq(pages.clientInstanceId, input.clientInstanceId),
        eq(pages.conversationId, input.conversationId),
        eq(pages.id, input.pageId)
      )
    )
    .limit(1);
  return row ? mapPage(row) : undefined;
}

export async function listPageFileSets(
  db: PostgresConnection,
  input: Input<"listPageFileSets">
): Promise<FileSetSummary[]> {
  // The file index stays in the table: a history of a thousand revisions reads no index.
  const rows = await db
    .select(summaryColumns)
    .from(fileSets)
    .where(and(eq(fileSets.clientInstanceId, input.clientInstanceId), ownedByPage(input.pageId)))
    .orderBy(desc(fileSets.number));
  return rows.map((row) => mapSummary({ ...row, ownerKind: "page" }));
}

export async function getPageFileSet(
  db: PostgresConnection,
  input: Input<"getPageFileSet">
): Promise<FileSet | undefined> {
  const [row] = await db
    .select()
    .from(fileSets)
    .where(
      and(
        eq(fileSets.clientInstanceId, input.clientInstanceId),
        ownedByPage(input.pageId),
        ...(input.fileSetId ? [eq(fileSets.id, input.fileSetId)] : [])
      )
    )
    .orderBy(desc(fileSets.number))
    .limit(1);
  return row ? mapFileSet(row) : undefined;
}

export async function getServedFileSet(
  db: PostgresConnection,
  input: Input<"getServedFileSet">
): Promise<ServedFileSet | undefined> {
  const [fileSet] = await db
    .select()
    .from(fileSets)
    .where(
      and(eq(fileSets.id, input.fileSetId), eq(fileSets.clientInstanceId, input.clientInstanceId))
    )
    .limit(1);
  if (!fileSet) {
    return undefined;
  }
  return fileSet.ownerKind === "asset"
    ? getServedAssetFileSet(db, fileSet)
    : getServedPageFileSet(db, input);
}

/**
 * The file set with the asset that owns it, while that asset is active and one of its
 * revisions names the file set. A file set no revision names is nobody's to open: a write
 * stored it and did not come to its revision.
 */
async function getServedAssetFileSet(
  db: PostgresConnection,
  fileSet: FileSetRow
): Promise<ServedFileSet | undefined> {
  // The asset with whichever of its two pointers names a revision of this file set, and the
  // file set of its published revision: one read by the asset's key that reaches at most three
  // revisions by theirs.
  const rows = await db
    .select({
      id: configAssets.id,
      kind: configAssets.kind,
      name: configAssets.name,
      scopeId: configAssets.scopeId,
      activeRevisionId: configAssets.activeRevisionId,
      publishedRevisionId: configAssets.publishedRevisionId,
      publishedFileSetId: publishedRevisions.fileSetId,
      revisionId: configAssetRevisions.id
    })
    .from(configAssets)
    .leftJoin(publishedRevisions, eq(publishedRevisions.id, configAssets.publishedRevisionId))
    .leftJoin(
      configAssetRevisions,
      and(
        or(
          eq(configAssetRevisions.id, configAssets.activeRevisionId),
          eq(configAssetRevisions.id, configAssets.publishedRevisionId)
        ),
        eq(configAssetRevisions.fileSetId, fileSet.id)
      )
    )
    .where(
      and(
        eq(configAssets.id, fileSet.ownerId),
        eq(configAssets.clientInstanceId, fileSet.clientInstanceId),
        eq(configAssets.status, "active"),
        namedByRevision(sql`${configAssets.id}`, fileSet.id)
      )
    );
  const [asset] = rows;
  if (!asset) {
    return undefined;
  }
  return {
    ...mapFileSet(fileSet),
    asset: {
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      ...(asset.scopeId ? { workspaceId: asset.scopeId } : {}),
      activeRevisionId: asset.activeRevisionId,
      ...(asset.publishedRevisionId ? { publishedRevisionId: asset.publishedRevisionId } : {}),
      ...(asset.publishedFileSetId ? { publishedFileSetId: asset.publishedFileSetId } : {}),
      revisionIds: rows.flatMap((row) => row.revisionId ?? [])
    }
  };
}

async function getServedPageFileSet(
  db: PostgresConnection,
  input: Input<"getServedFileSet">
): Promise<ServedFileSet | undefined> {
  const [row] = await db
    .select({ fileSet: fileSets, pageId: pages.id, conversationId: pages.conversationId })
    .from(fileSets)
    .innerJoin(
      pages,
      and(eq(pages.id, fileSets.ownerId), eq(pages.clientInstanceId, fileSets.clientInstanceId))
    )
    .innerJoin(
      conversations,
      and(
        eq(conversations.id, pages.conversationId),
        eq(conversations.clientInstanceId, pages.clientInstanceId)
      )
    )
    .where(
      and(
        eq(fileSets.id, input.fileSetId),
        eq(fileSets.clientInstanceId, input.clientInstanceId),
        eq(fileSets.ownerKind, "page"),
        eq(conversations.status, "active")
      )
    )
    .limit(1);
  return row ? { ...mapFileSet(row.fileSet), conversationId: row.conversationId } : undefined;
}

export async function listConversationPageIds(
  db: PostgresConnection,
  input: Input<"listConversationPageIds">
): Promise<PageId[]> {
  const rows = await db
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.clientInstanceId, input.clientInstanceId),
        eq(pages.conversationId, input.conversationId)
      )
    )
    .orderBy(asc(pages.id));
  return rows.map((row) => row.id);
}

export async function deletePage(
  db: PostgresConnection,
  input: Input<"deletePage">
): Promise<{ fileSetCount: number }> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(fileSets)
      .where(and(eq(fileSets.clientInstanceId, input.clientInstanceId), ownedByPage(input.pageId)))
      .returning({ id: fileSets.id });
    await tx
      .delete(pages)
      .where(and(eq(pages.clientInstanceId, input.clientInstanceId), eq(pages.id, input.pageId)));
    return { fileSetCount: deleted.length };
  });
}

export async function createPageBuild(
  db: PostgresConnection,
  input: Input<"createPageBuild">
): Promise<PageBuild> {
  const createdAt = new Date(input.createdAt);
  // What an earlier save of this conversation left behind and never read, or, for the build
  // of an asset's files, what an earlier write of any asset left.
  await db
    .delete(pageBuilds)
    .where(
      and(
        eq(pageBuilds.clientInstanceId, input.clientInstanceId),
        input.conversationId === undefined
          ? isNull(pageBuilds.conversationId)
          : eq(pageBuilds.conversationId, input.conversationId),
        lt(pageBuilds.createdAt, new Date(createdAt.getTime() - PAGE_BUILD_KEEP_MS))
      )
    );
  const [created] = await db
    .insert(pageBuilds)
    .values({
      id: input.id,
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      request: input.request,
      createdAt
    })
    .returning();
  if (!created) {
    throw new Error("The build of a Page was not recorded");
  }
  return mapPageBuild(created);
}

export async function getPageBuild(
  db: PostgresConnection,
  input: Input<"getPageBuild">
): Promise<PageBuild | undefined> {
  const [row] = await db
    .select()
    .from(pageBuilds)
    .where(
      and(eq(pageBuilds.clientInstanceId, input.clientInstanceId), eq(pageBuilds.id, input.buildId))
    )
    .limit(1);
  return row ? mapPageBuild(row) : undefined;
}

export async function finishPageBuild(
  db: PostgresConnection,
  input: Input<"finishPageBuild">
): Promise<boolean> {
  const finished = await db
    .update(pageBuilds)
    .set({ result: input.result, finishedAt: new Date(input.finishedAt) })
    .where(
      and(
        eq(pageBuilds.clientInstanceId, input.clientInstanceId),
        eq(pageBuilds.id, input.buildId),
        isNull(pageBuilds.result)
      )
    )
    .returning({ id: pageBuilds.id });
  return finished.length > 0;
}

export async function deletePageBuild(
  db: PostgresConnection,
  input: Input<"deletePageBuild">
): Promise<void> {
  await db
    .delete(pageBuilds)
    .where(
      and(eq(pageBuilds.clientInstanceId, input.clientInstanceId), eq(pageBuilds.id, input.buildId))
    );
}

function mapPageBuild(row: typeof pageBuilds.$inferSelect): PageBuild {
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId,
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    request: row.request,
    ...(row.result ? { result: row.result } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.toISOString() } : {})
  };
}

function ownedByPage(pageId: PageId) {
  return and(eq(fileSets.ownerKind, "page"), eq(fileSets.ownerId, pageId));
}

function mapPage(row: PageRow): Page {
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId,
    conversationId: row.conversationId,
    name: row.name,
    createdAt: row.createdAt.toISOString()
  };
}

function ownerOf(row: Pick<FileSetRow, "ownerKind" | "ownerId">): FileSetOwner {
  if (row.ownerKind === "asset") {
    return { kind: "asset", id: row.ownerId };
  }
  if (!isPageId(row.ownerId)) {
    throw new Error(`File set owner '${row.ownerId}' is no Page`);
  }
  return { kind: "page", id: row.ownerId };
}

function mapSummary(
  row: Pick<FileSetRow, keyof typeof summaryColumns | "ownerKind">
): FileSetSummary {
  return {
    id: row.id,
    owner: ownerOf(row),
    number: row.number,
    kitVersion: row.kitVersion,
    sourceFileCount: row.sourceFileCount,
    builtFileCount: row.builtFileCount,
    totalBytes: row.totalBytes,
    ...(row.createdByUserId ? { createdByUserId: row.createdByUserId } : {}),
    createdAt: row.createdAt.toISOString()
  };
}

function mapFileSet(row: FileSetRow): FileSet {
  return {
    ...mapSummary(row),
    clientInstanceId: row.clientInstanceId,
    manifest: row.manifest,
    sourceFiles: row.sourceFiles,
    builtFiles: row.builtFiles
  };
}
