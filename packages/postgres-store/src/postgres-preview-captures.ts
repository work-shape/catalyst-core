import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import {
  asManagedArtifactId,
  serverPreviewCaptureJob,
  subjectDedupeKey,
  PREVIEW_CAPTURE_REFUSALS,
  PREVIEW_CAPTURES_PER_RUN,
  PREVIEW_CAPTURES_PER_HOUR,
  type PagesStore,
  type PreviewCaptureRefusal,
  type PreviewCaptureState
} from "@work-shape/catalyst-core";
import { agentRuns } from "./schema/agentRuns";
import { enqueueJob } from "./jobs/store";
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
      if (input.server) {
        const deadline = new Date(input.server.deadline).getTime();
        const [run] = await tx
          .select()
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.clientInstanceId, input.clientInstanceId),
              eq(agentRuns.id, input.runId)
            )
          )
          .for("share");
        if (
          !run ||
          run.status !== "running" ||
          run.ownerUserId !== input.userId ||
          run.conversationId !== input.conversationId ||
          run.principalId ||
          run.authorizationContext?.principal.kind !== "user" ||
          run.authorizationContext.delegatedActor ||
          run.authorizationContext.subjectUserId !== input.userId ||
          deadline <= Date.now() ||
          deadline > Date.now() + 25_000
        )
          throw new Error("No live person run");
      }
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
          // A run counts every request, which bounds the time it spends waiting; the hour counts
          // the pictures a person's browser took or is taking, not the requests refused.
          hour: sql<number>`count(*) filter (where ${previewCaptures.userId} = ${input.userId} and ${previewCaptures.status} <> 'refused' and ${previewCaptures.requestedAt} > ${new Date(requestedAt.getTime() - HOUR_MS).toISOString()}::timestamptz)::int`
        })
        .from(previewCaptures)
        .where(
          and(
            eq(previewCaptures.clientInstanceId, input.clientInstanceId),
            sql`(${previewCaptures.runId} = ${input.runId} or ${previewCaptures.userId} = ${input.userId})`
          )
        );
      if (
        (counted?.run ?? 0) >=
          (input.server ? Math.min(PREVIEW_CAPTURES_PER_RUN, input.perRun) : input.perRun) ||
        (counted?.hour ?? 0) >=
          (input.server ? Math.min(PREVIEW_CAPTURES_PER_HOUR, input.perHour) : input.perHour)
      ) {
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
        requestedAt,
        ...(input.server ? { serverRequest: input.server } : {})
      });
      if (input.server)
        await enqueueJob(
          tx,
          serverPreviewCaptureJob,
          { captureId: id },
          {
            clientInstanceId: input.clientInstanceId,
            subject: id,
            dedupeKey: subjectDedupeKey(serverPreviewCaptureJob.kind, id),
            concurrencyKey: id
          }
        );
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
          isNull(previewCaptures.serverRequest),
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
          isNull(previewCaptures.serverRequest),
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

export async function getServerPreviewCapture(
  db: PostgresConnection,
  input: Input<"getServerPreviewCapture">
): Promise<Awaited<ReturnType<PagesStore["getServerPreviewCapture"]>>> {
  try {
    const [row] = await db
      .select()
      .from(previewCaptures)
      .where(
        and(
          eq(previewCaptures.clientInstanceId, input.clientInstanceId),
          eq(previewCaptures.id, input.id),
          isNotNull(previewCaptures.serverRequest)
        )
      );
    return row?.serverRequest
      ? {
          id: row.id,
          conversationId: row.conversationId,
          userId: row.userId,
          runId: row.runId,
          fileSetId: row.fileSetId,
          status: row.status,
          settings: row.serverRequest
        }
      : undefined;
  } catch {
    throw withoutValues("read");
  }
}
export async function claimServerPreviewCapture(
  db: PostgresConnection,
  input: Input<"claimServerPreviewCapture">
): Promise<Awaited<ReturnType<PagesStore["claimServerPreviewCapture"]>>> {
  try {
    const [row] = await db
      .update(previewCaptures)
      .set({ status: "answering" })
      .where(
        and(
          eq(previewCaptures.clientInstanceId, input.clientInstanceId),
          eq(previewCaptures.id, input.id),
          eq(previewCaptures.status, "pending"),
          isNotNull(previewCaptures.serverRequest)
        )
      )
      .returning();
    return row?.serverRequest
      ? {
          id: row.id,
          conversationId: row.conversationId,
          userId: row.userId,
          runId: row.runId,
          fileSetId: row.fileSetId,
          status: row.status,
          settings: row.serverRequest
        }
      : undefined;
  } catch {
    throw withoutValues("claim");
  }
}
export async function finishServerPreviewCapture(
  db: PostgresConnection,
  input: Input<"finishServerPreviewCapture">
): Promise<boolean> {
  try {
    const { outcome } = input;
    const rows = await db
      .update(previewCaptures)
      .set(
        outcome.status === "captured"
          ? {
              status: "captured",
              artifactId: outcome.artifactId,
              width: outcome.width,
              height: outcome.height,
              serverDiagnostics: outcome.diagnostics,
              answeredAt: new Date(input.answeredAt)
            }
          : { status: "refused", code: outcome.code, answeredAt: new Date(input.answeredAt) }
      )
      .where(
        and(
          eq(previewCaptures.clientInstanceId, input.clientInstanceId),
          eq(previewCaptures.id, input.id),
          inArray(previewCaptures.status, ["pending", "answering"]),
          isNotNull(previewCaptures.serverRequest)
        )
      )
      .returning({ id: previewCaptures.id });
    return rows.length > 0;
  } catch {
    throw withoutValues("end");
  }
}
