import { and, eq, gt, gte, lt, sql } from "drizzle-orm";
import type {
  PagesStore,
  StoredPreviewReport,
  TakenPreviewReport
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { conversations } from "./schema/conversations";
import { fileSets, previewReports, previewViewerReports } from "./schema/pages";

// What a preview last reported of itself (PREVIEW-STATUS-1): one row per conversation, file set
// and person whose browser showed it, kept for 24 hours. A failed statement is answered with a
// sentence of its own: the driver's error names the statement's values, and those are the
// report.

type Input<Method extends keyof PagesStore> = Parameters<PagesStore[Method]>[0];

/** An error that names what failed and none of the values it was given. */
function withoutValues(what: string): Error {
  return new Error(`Could not ${what} a preview report`);
}

const table = previewViewerReports;
/** The report as a run notes it: a digest, so that one which reads the same is noted once. */
const reportDigest = sql<string>`md5(${table.report}::text)`;
const settled = sql`(${table.report} ->> 'settled')::boolean`;

export async function putPreviewReport(
  db: PostgresConnection,
  input: Input<"putPreviewReport">
): Promise<boolean> {
  const reportedAt = new Date(input.reportedAt);
  try {
    // Kept only while the conversation is active and the file set is there: a report that
    // arrives after a delete stores nothing, and no key it names is refused.
    const rows = await db
      .insert(table)
      .select(
        db
          .select({
            clientInstanceId: sql`${input.clientInstanceId}`.as("client_instance_id"),
            conversationId: conversations.id,
            userId: sql`${input.userId}`.as("user_id"),
            fileSetId: fileSets.id,
            report: sql`${JSON.stringify(input.report)}::jsonb`.as("report"),
            reportedAt: sql`${reportedAt.toISOString()}::timestamptz`.as("reported_at"),
            notedDigest: sql`null::text`.as("noted_digest")
          })
          .from(conversations)
          .innerJoin(
            fileSets,
            and(
              eq(fileSets.id, input.fileSetId),
              eq(fileSets.clientInstanceId, input.clientInstanceId)
            )
          )
          .where(
            and(
              eq(conversations.clientInstanceId, input.clientInstanceId),
              eq(conversations.id, input.conversationId),
              eq(conversations.status, "active")
            )
          )
          // A delete of the conversation that commits meanwhile is waited for and seen.
          .for("share", { of: conversations })
      )
      .onConflictDoUpdate({
        target: [table.conversationId, table.userId, table.fileSetId],
        // What a run noted stays: a report that reads the same is not noted again.
        set: { report: sql`excluded.report`, reportedAt: sql`excluded.reported_at` }
      })
      .returning({ fileSetId: table.fileSetId });
    return rows.length > 0;
  } catch {
    throw withoutValues("keep");
  }
}

export async function getPreviewReport(
  db: PostgresConnection,
  input: Input<"getPreviewReport">
): Promise<StoredPreviewReport | undefined> {
  try {
    const [row] = await db
      .select({ report: table.report, reportedAt: table.reportedAt })
      .from(table)
      .where(
        and(
          eq(table.clientInstanceId, input.clientInstanceId),
          eq(table.conversationId, input.conversationId),
          eq(table.userId, input.userId),
          eq(table.fileSetId, input.fileSetId),
          gt(table.reportedAt, new Date(input.notBefore))
        )
      );
    return row ? { report: row.report, reportedAt: row.reportedAt.toISOString() } : undefined;
  } catch {
    throw withoutValues("read");
  }
}

export async function previewViewedSince(
  db: PostgresConnection,
  input: Input<"previewViewedSince">
): Promise<boolean> {
  try {
    const rows = await db
      .select({ fileSetId: table.fileSetId })
      .from(table)
      .where(
        and(
          eq(table.clientInstanceId, input.clientInstanceId),
          eq(table.conversationId, input.conversationId),
          eq(table.userId, input.userId),
          gt(table.reportedAt, new Date(input.since))
        )
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    throw withoutValues("read");
  }
}

export async function takePreviewReport(
  db: PostgresConnection,
  input: Input<"takePreviewReport">
): Promise<TakenPreviewReport | undefined> {
  const notBefore = new Date(input.notBefore);
  try {
    const rows = await db
      .update(table)
      .set({ notedDigest: reportDigest })
      .from(fileSets)
      .where(
        and(
          eq(fileSets.id, table.fileSetId),
          eq(table.clientInstanceId, input.clientInstanceId),
          eq(table.conversationId, input.conversationId),
          eq(table.userId, input.userId),
          settled,
          ...(input.fileSetId === undefined
            ? [
                gt(table.reportedAt, notBefore),
                sql`${table.notedDigest} is distinct from ${reportDigest}`
              ]
            : [eq(table.fileSetId, input.fileSetId), gte(table.reportedAt, notBefore)])
        )
      )
      .returning({
        fileSetId: table.fileSetId,
        number: fileSets.number,
        report: table.report,
        reportedAt: table.reportedAt
      });
    const [newest] = rows.sort((a, b) => b.reportedAt.getTime() - a.reportedAt.getTime());
    return newest && { ...newest, reportedAt: newest.reportedAt.toISOString() };
  } catch {
    throw withoutValues("take");
  }
}

export async function prunePreviewReports(
  db: PostgresConnection,
  input: Input<"prunePreviewReports">
): Promise<number> {
  const before = new Date(input.before);
  const removed = await db
    .delete(table)
    .where(and(eq(table.clientInstanceId, input.clientInstanceId), lt(table.reportedAt, before)))
    .returning({ fileSetId: table.fileSetId });
  // The rows of the table reports were kept in before they were kept per viewer.
  const former = await db
    .delete(previewReports)
    .where(
      and(
        eq(previewReports.clientInstanceId, input.clientInstanceId),
        lt(previewReports.reportedAt, before)
      )
    )
    .returning({ fileSetId: previewReports.fileSetId });
  return removed.length + former.length;
}
