import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import {
  AppError,
  asClientInstanceId,
  type FeedbackRecord,
  type FeedbackRemoval,
  type FeedbackStore
} from "@work-shape/catalyst-core";
import { keysetFilter } from "./paging";
import type { PostgresConnection } from "./postgres-database";
import { feedback, productUsers } from "./schema";

type FeedbackRow = typeof feedback.$inferSelect;

/** The most comments one page of the reviewer's list holds. */
const FEEDBACK_PAGE_MAX = 200;

const columns = { row: feedback, authorDisplayLabel: productUsers.displayLabel };

function iso(value: Date): string {
  return value.toISOString();
}

function mapFeedback(row: FeedbackRow, authorDisplayLabel?: string | null): FeedbackRecord {
  return {
    id: row.id,
    clientInstanceId: asClientInstanceId(row.clientInstanceId),
    subjectKind: row.subjectKind,
    ...(row.messageId ? { messageId: row.messageId } : {}),
    agentName: row.agentName,
    ...(row.agentAssetId ? { agentAssetId: row.agentAssetId } : {}),
    ...(row.agentRevision === null ? {} : { agentRevision: row.agentRevision }),
    ...(row.agentWorkspaceId ? { agentWorkspaceId: row.agentWorkspaceId } : {}),
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    ...(row.agentRunId ? { agentRunId: row.agentRunId } : {}),
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    authorUserId: row.authorUserId,
    ...(authorDisplayLabel ? { authorDisplayLabel } : {}),
    text: row.text,
    ...(row.exchangeQuestion !== null && row.exchangeAnswer !== null
      ? { exchange: { question: row.exchangeQuestion, answer: row.exchangeAnswer } }
      : {}),
    ...(row.summary !== null && row.annotatedAt !== null
      ? {
          annotation: {
            summary: row.summary,
            ...(row.category ? { category: row.category } : {}),
            annotatedAt: iso(row.annotatedAt)
          }
        }
      : {}),
    state: row.state,
    // An emptied label is still a handled comment: its handler's account was deleted.
    ...(row.handledByUserId && row.handledByLabel !== null && row.handledAt
      ? {
          handled: {
            byUserId: row.handledByUserId,
            byLabel: row.handledByLabel,
            at: iso(row.handledAt),
            ...(row.handledNote ? { note: row.handledNote } : {})
          }
        }
      : {}),
    ...(row.approvalRequestId ? { approvalRequestId: row.approvalRequestId } : {}),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  };
}

const authorJoin = and(
  eq(productUsers.clientInstanceId, feedback.clientInstanceId),
  eq(productUsers.id, feedback.authorUserId)
);

type Input<Method extends keyof FeedbackStore> = Parameters<FeedbackStore[Method]>[0];

async function readOne(
  db: PostgresConnection,
  input: { clientInstanceId: string; id: string }
): Promise<FeedbackRecord | undefined> {
  const [row] = await db
    .select(columns)
    .from(feedback)
    .leftJoin(productUsers, authorJoin)
    .where(and(eq(feedback.clientInstanceId, input.clientInstanceId), eq(feedback.id, input.id)))
    .limit(1);
  return row ? mapFeedback(row.row, row.authorDisplayLabel) : undefined;
}

function removals(rows: { id: string; approvalRequestId: string | null }[]): FeedbackRemoval[] {
  return rows.map((row) => ({
    id: row.id,
    ...(row.approvalRequestId ? { approvalRequestId: row.approvalRequestId } : {})
  }));
}

export function createPostgresFeedbackStore(db: PostgresConnection): FeedbackStore {
  return {
    async createFeedback(input: Input<"createFeedback">) {
      const now = new Date();
      const inserted = await db
        .insert(feedback)
        .values({
          id: input.id,
          clientInstanceId: input.clientInstanceId,
          subjectKind: input.subjectKind,
          messageId: input.messageId,
          agentName: input.agentName,
          agentAssetId: input.agentAssetId ?? null,
          agentRevision: input.agentRevision ?? null,
          agentWorkspaceId: input.agentWorkspaceId ?? null,
          conversationId: input.conversationId,
          agentRunId: input.agentRunId,
          workspaceId: input.workspaceId,
          authorUserId: input.authorUserId,
          text: input.text,
          exchangeQuestion: input.exchange?.question ?? null,
          exchangeAnswer: input.exchange?.answer ?? null,
          state: "new",
          createdAt: now,
          updatedAt: now
        })
        .onConflictDoNothing()
        .returning({ id: feedback.id });
      if (inserted.length === 0) {
        throw new AppError("CONFLICT", "You already sent feedback on this message", {
          reason: "feedback_exists"
        });
      }
      const created = await readOne(db, input);
      if (!created) throw new AppError("INTERNAL", "Created feedback was not found");
      return created;
    },

    getFeedback: (input) => readOne(db, input),

    async listOwnFeedback(input) {
      const rows = await db
        .select(columns)
        .from(feedback)
        .leftJoin(productUsers, authorJoin)
        .where(
          and(
            eq(feedback.clientInstanceId, input.clientInstanceId),
            eq(feedback.authorUserId, input.authorUserId),
            eq(feedback.conversationId, input.conversationId)
          )
        )
        .orderBy(asc(feedback.createdAt), asc(feedback.id))
        .limit(FEEDBACK_PAGE_MAX * 5);
      return rows.map((row) => mapFeedback(row.row, row.authorDisplayLabel));
    },

    async listFeedback(input) {
      if (input.agentAssetIds?.length === 0) return [];
      const rows = await db
        .select(columns)
        .from(feedback)
        .leftJoin(productUsers, authorJoin)
        .where(
          and(
            eq(feedback.clientInstanceId, input.clientInstanceId),
            input.agentAssetIds
              ? inArray(feedback.agentAssetId, [...input.agentAssetIds])
              : undefined,
            input.agentName ? eq(feedback.agentName, input.agentName) : undefined,
            input.state ? eq(feedback.state, input.state) : undefined,
            keysetFilter(input.page, [feedback.createdAt, feedback.id], true)
          )
        )
        .orderBy(desc(feedback.createdAt), desc(feedback.id))
        .limit(Math.min(input.page?.limit ?? FEEDBACK_PAGE_MAX, FEEDBACK_PAGE_MAX));
      return rows.map((row) => mapFeedback(row.row, row.authorDisplayLabel));
    },

    async updateFeedback(input) {
      const updated = await db
        .update(feedback)
        .set({
          text: input.text,
          exchangeQuestion: input.exchange?.question ?? null,
          exchangeAnswer: input.exchange?.answer ?? null,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(feedback.clientInstanceId, input.clientInstanceId),
            eq(feedback.id, input.id),
            eq(feedback.state, "new")
          )
        )
        .returning({ id: feedback.id });
      return updated.length > 0 ? readOne(db, input) : undefined;
    },

    async setFeedbackApprovalRequest(input) {
      await db
        .update(feedback)
        .set({ approvalRequestId: input.approvalRequestId })
        .where(
          and(eq(feedback.clientInstanceId, input.clientInstanceId), eq(feedback.id, input.id))
        );
    },

    async markFeedbackHandled(input) {
      const now = new Date();
      const updated = await db
        .update(feedback)
        .set({
          state: "handled",
          handledByUserId: input.byUserId,
          handledByLabel: input.byLabel,
          handledAt: now,
          handledNote: input.note ?? null,
          updatedAt: now
        })
        .where(
          and(
            eq(feedback.clientInstanceId, input.clientInstanceId),
            eq(feedback.id, input.id),
            eq(feedback.state, "new")
          )
        )
        .returning({ id: feedback.id });
      return updated.length > 0 ? readOne(db, input) : undefined;
    },

    async annotateFeedback(input) {
      const now = new Date();
      const updated = await db
        .update(feedback)
        .set({
          summary: input.summary,
          category: input.category ?? null,
          annotatedAt: now,
          updatedAt: now
        })
        .where(
          and(eq(feedback.clientInstanceId, input.clientInstanceId), eq(feedback.id, input.id))
        )
        .returning({ id: feedback.id });
      return updated.length > 0 ? readOne(db, input) : undefined;
    },

    async deleteFeedback(input) {
      const deleted = await db
        .delete(feedback)
        .where(
          and(eq(feedback.clientInstanceId, input.clientInstanceId), eq(feedback.id, input.id))
        )
        .returning({ id: feedback.id });
      return deleted.length > 0;
    },

    async listExpiredFeedback(input) {
      return removals(
        await db
          .select({ id: feedback.id, approvalRequestId: feedback.approvalRequestId })
          .from(feedback)
          .where(
            and(
              eq(feedback.clientInstanceId, input.clientInstanceId),
              lt(feedback.createdAt, input.before)
            )
          )
          .orderBy(asc(feedback.createdAt), asc(feedback.id))
          .limit(input.limit)
      );
    },

    async listFeedbackOfAuthor(input) {
      return removals(
        await db
          .select({ id: feedback.id, approvalRequestId: feedback.approvalRequestId })
          .from(feedback)
          .where(
            and(
              eq(feedback.clientInstanceId, input.clientInstanceId),
              eq(feedback.authorUserId, input.authorUserId)
            )
          )
          .orderBy(asc(feedback.createdAt), asc(feedback.id))
          .limit(input.limit)
      );
    }
  };
}
