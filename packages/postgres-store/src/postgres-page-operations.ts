import { and, asc, count, desc, eq, max, sql } from "drizzle-orm";
import {
  CONVERSATION_MAX_PAGES,
  PAGE_MAX_FILE_SETS,
  createPageId,
  pageRefusal,
  type FileSet,
  type FileSetSummary,
  type Page,
  type PageId,
  type PagesStore
} from "@vivd-catalyst/core";
import type { PostgresConnection } from "./postgres-database";
import { conversations } from "./schema/conversations";
import { fileSets, pages } from "./schema/pages";

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
    const files = [...fileSet.sourceFiles, ...fileSet.builtFiles];
    const [row] = await tx
      .insert(fileSets)
      .values({
        id: fileSet.id,
        clientInstanceId: input.clientInstanceId,
        ownerKind: "page",
        ownerId: input.pageId,
        number: (held?.newest ?? 0) + 1,
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
    return mapFileSet(row, input.pageId);
  });
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
  return rows.map((row) => mapSummary(row, input.pageId));
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
  return row ? mapFileSet(row, input.pageId) : undefined;
}

export async function getServedFileSet(
  db: PostgresConnection,
  input: Input<"getServedFileSet">
): Promise<FileSet | undefined> {
  const [row] = await db
    .select({ fileSet: fileSets, pageId: pages.id })
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
  return row ? mapFileSet(row.fileSet, row.pageId) : undefined;
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

function mapSummary(
  row: Pick<FileSetRow, keyof typeof summaryColumns>,
  pageId: PageId
): FileSetSummary {
  return {
    id: row.id,
    owner: { kind: "page", id: pageId },
    number: row.number,
    kitVersion: row.kitVersion,
    sourceFileCount: row.sourceFileCount,
    builtFileCount: row.builtFileCount,
    totalBytes: row.totalBytes,
    ...(row.createdByUserId ? { createdByUserId: row.createdByUserId } : {}),
    createdAt: row.createdAt.toISOString()
  };
}

function mapFileSet(row: FileSetRow, pageId: PageId): FileSet {
  return {
    ...mapSummary(row, pageId),
    clientInstanceId: row.clientInstanceId,
    manifest: row.manifest,
    sourceFiles: row.sourceFiles,
    builtFiles: row.builtFiles
  };
}
