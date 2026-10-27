import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  asManagedArtifactId,
  PREVIEW_CAPTURE_REFUSALS,
  type PagesStore,
  type PreviewCaptureRefusal,
  type PreviewCaptureState
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { fileSets, previewCaptures, previewViewerReports } from "./schema/pages";

// The pictures of a preview a run asked for (PREVIEW-SEE-1): one row per tool call, answered by
// the browser of the person whose turn the run serves. A row holds where the request stands and
// the artifact of the picture, never the picture. A failed statement is answered with a
// sentence of its own: the driver's error names the statement's values.

type Input<Method extends keyof PagesStore> = Parameters<PagesStore[Method]>[0];

const HOUR_MS = 60 * 60 * 1000;

function withoutValues(what: string): Error {
  return new Error(`Could not ${what} a preview capture`);
}

export async function viewedPreview(
  db: PostgresConnection,
  input: Input<"viewedPreview">
): Promise<Awaited<ReturnType<PagesStore["viewedPreview"]>>> {
  try {
    const [row] = await db
      .select({ fileSetId: previewViewerReports.fileSetId })
      .from(previewViewerReports)
      .where(
        and(
          eq(previewViewerReports.clientInstanceId, input.clientInstanceId),
          eq(previewViewerReports.conversationId, input.conversationId),
          eq(previewViewerReports.userId, input.userId),
          gt(previewViewerReports.reportedAt, new Date(input.since))
        )
      )
      .orderBy(desc(previewViewerReports.reportedAt))
      .limit(1);
    return row?.fileSetId;
  } catch {
    throw withoutValues("find the preview of");
  }
}

/**
 * One lock per person orders every request of theirs, in this process or another, so the
 * counts of a run and of the person's hour see each request taken before.
 */
export async function requestPreviewCapture(
  db: PostgresConnection,
  input: Input<"requestPreviewCapture">
): Promise<Awaited<ReturnType<PagesStore["requestPreviewCapture"]>>> {
  const requestedAt = new Date(input.requestedAt);
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["preview-captures", input.clientInstanceId, input.userId])}, 0))`
      );
      const [asked] = await tx
        .select({ id: previewCaptures.id })
        .from(previewCaptures)
        .where(
          and(
            eq(previewCaptures.clientInstanceId, input.clientInstanceId),
            eq(previewCaptures.runId, input.runId),
            eq(previewCaptures.toolCallId, input.toolCallId)
          )
        );
      if (asked) return { id: asked.id };
      const [counted] = await tx
        .select({
          run: sql<number>`count(*) filter (where ${previewCaptures.runId} = ${input.runId})::int`,
          hour: sql<number>`count(*) filter (where ${previewCaptures.userId} = ${input.userId} and ${previewCaptures.requestedAt} > ${new Date(requestedAt.getTime() - HOUR_MS).toISOString()}::timestamptz)::int`
        })
        .from(previewCaptures)
        .where(
          and(
            eq(previewCaptures.clientInstanceId, input.clientInstanceId),
            sql`(${previewCaptures.runId} = ${input.runId} or ${previewCaptures.userId} = ${input.userId})`
          )
        );
      if ((counted?.run ?? 0) >= input.perRun || (counted?.hour ?? 0) >= input.perHour) {
        return { refused: "capture_limit" as const };
      }
      const id = `pcap_${randomUUID()}`;
      await tx.insert(previewCaptures).values({
        id,
        clientInstanceId: input.clientInstanceId,
        conversationId: input.conversationId,
        userId: input.userId,
        runId: input.runId,
        toolCallId: input.toolCallId,
        fileSetId: input.fileSetId,
        status: "pending",
        requestedAt
      });
      return { id };
    });
  } catch {
    throw withoutValues("keep");
  }
}

export async function pendingPreviewCaptures(
  db: PostgresConnection,
  input: Input<"pendingPreviewCaptures">
): Promise<Awaited<ReturnType<PagesStore["pendingPreviewCaptures"]>>> {
  try {
    return await db
      .select({ id: previewCaptures.id, fileSetId: previewCaptures.fileSetId })
      .from(previewCaptures)
      .where(
        and(
          eq(previewCaptures.clientInstanceId, input.clientInstanceId),
          eq(previewCaptures.conversationId, input.conversationId),
          eq(previewCaptures.userId, input.userId),
          eq(previewCaptures.status, "pending"),
          gt(previewCaptures.requestedAt, new Date(input.notBefore))
        )
      )
      .orderBy(desc(previewCaptures.requestedAt))
      .limit(5);
  } catch {
    throw withoutValues("read");
  }
}

export async function claimPreviewCapture(
  db: PostgresConnection,
  input: Input<"claimPreviewCapture">
): Promise<boolean> {
  try {
    const rows = await db
      .update(previewCaptures)
      .set({ status: "answering" })
      .where(
        and(
          eq(previewCaptures.clientInstanceId, input.clientInstanceId),
          eq(previewCaptures.id, input.id),
          eq(previewCaptures.conversationId, input.conversationId),
          eq(previewCaptures.userId, input.userId),
          eq(previewCaptures.fileSetId, input.fileSetId),
          eq(previewCaptures.status, "pending"),
          gt(previewCaptures.requestedAt, new Date(input.notBefore))
        )
      )
      .returning({ id: previewCaptures.id });
    return rows.length > 0;
  } catch {
    throw withoutValues("take");
  }
}

export async function settlePreviewCapture(
  db: PostgresConnection,
  input: Input<"settlePreviewCapture">
): Promise<boolean> {
  const { outcome } = input;
  try {
    const rows = await db
      .update(previewCaptures)
      .set(
        outcome.status === "captured"
          ? {
              status: "captured",
              artifactId: outcome.artifactId,
              width: outcome.width,
              height: outcome.height,
              answeredAt: new Date(input.answeredAt)
            }
          : { status: "refused", code: outcome.code, answeredAt: new Date(input.answeredAt) }
      )
      .where(
        and(
          eq(previewCaptures.clientInstanceId, input.clientInstanceId),
          eq(previewCaptures.id, input.id),
          inArray(previewCaptures.status, [...input.from])
        )
      )
      .returning({ id: previewCaptures.id });
    return rows.length > 0;
  } catch {
    throw withoutValues("end");
  }
}

export async function getPreviewCapture(
  db: PostgresConnection,
  input: Input<"getPreviewCapture">
): Promise<PreviewCaptureState | undefined> {
  try {
    const [row] = await db
      .select({
        status: previewCaptures.status,
        code: previewCaptures.code,
        artifactId: previewCaptures.artifactId,
        width: previewCaptures.width,
        height: previewCaptures.height,
        number: fileSets.number
      })
      .from(previewCaptures)
      .innerJoin(fileSets, eq(fileSets.id, previewCaptures.fileSetId))
      .where(
        and(
          eq(previewCaptures.clientInstanceId, input.clientInstanceId),
          eq(previewCaptures.id, input.id)
        )
      );
    if (!row) return undefined;
    if (row.status === "pending" || row.status === "answering") return { status: row.status };
    if (
      row.status === "captured" &&
      row.artifactId !== null &&
      row.width !== null &&
      row.height !== null
    ) {
      return {
        status: "captured",
        artifactId: asManagedArtifactId(row.artifactId),
        width: row.width,
        height: row.height,
        number: row.number
      };
    }
    return { status: "refused", code: refusalOf(row.code) };
  } catch {
    throw withoutValues("read");
  }
}

function refusalOf(code: string | null): PreviewCaptureRefusal {
  return PREVIEW_CAPTURE_REFUSALS.find((refusal) => refusal === code) ?? "capture_unavailable";
}

/** Removes the requests made before `before`; the pictures stay with their conversation. */
export async function prunePreviewCaptures(
  db: PostgresConnection,
  input: { clientInstanceId: Input<"prunePreviewReports">["clientInstanceId"]; before: Date }
): Promise<number> {
  const removed = await db
    .delete(previewCaptures)
    .where(
      and(
        eq(previewCaptures.clientInstanceId, input.clientInstanceId),
        sql`${previewCaptures.requestedAt} < ${input.before.toISOString()}::timestamptz`
      )
    )
    .returning({ id: previewCaptures.id });
  return removed.length;
}
