import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { PagesStore, StoredPreviewReport } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { conversations } from "./schema/conversations";
import { fileSets, previewReports } from "./schema/pages";

// What a preview last reported of itself (PREVIEW-STATUS-1): one row per conversation and file
// set, kept for 24 hours. A failed statement is answered with a sentence of its own: the
// driver's error names the statement's values, and those are the report.

type Input<Method extends keyof PagesStore> = Parameters<PagesStore[Method]>[0];

/** An error that names what failed and none of the values it was given. */
function withoutValues(what: string): Error {
  return new Error(`Could not ${what} a preview report`);
}

export async function putPreviewReport(
  db: PostgresConnection,
  input: Input<"putPreviewReport">
): Promise<boolean> {
  const reportedAt = new Date(input.reportedAt);
  try {
    // Kept only while the conversation is active and the file set is there: a report that
    // arrives after a delete stores nothing, and no key it names is refused.
    const rows = await db
      .insert(previewReports)
      .select(
        db
          .select({
            clientInstanceId: sql`${input.clientInstanceId}`.as("client_instance_id"),
            conversationId: conversations.id,
            fileSetId: fileSets.id,
            report: sql`${JSON.stringify(input.report)}::jsonb`.as("report"),
            reportedAt: sql`${reportedAt.toISOString()}::timestamptz`.as("reported_at")
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
        target: [previewReports.conversationId, previewReports.fileSetId],
        set: { report: sql`excluded.report`, reportedAt: sql`excluded.reported_at` }
      })
      .returning({ fileSetId: previewReports.fileSetId });
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
      .select({ report: previewReports.report, reportedAt: previewReports.reportedAt })
      .from(previewReports)
      .where(
        and(
          eq(previewReports.clientInstanceId, input.clientInstanceId),
          eq(previewReports.conversationId, input.conversationId),
          eq(previewReports.fileSetId, input.fileSetId),
          gt(previewReports.reportedAt, new Date(input.notBefore))
        )
      );
    return row ? { report: row.report, reportedAt: row.reportedAt.toISOString() } : undefined;
  } catch {
    throw withoutValues("read");
  }
}

export async function prunePreviewReports(
  db: PostgresConnection,
  input: Input<"prunePreviewReports">
): Promise<number> {
  const removed = await db
    .delete(previewReports)
    .where(
      and(
        eq(previewReports.clientInstanceId, input.clientInstanceId),
        lt(previewReports.reportedAt, new Date(input.before))
      )
    )
    .returning({ fileSetId: previewReports.fileSetId });
  return removed.length;
}
