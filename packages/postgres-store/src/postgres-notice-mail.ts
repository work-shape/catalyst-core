import { and, asc, count, eq, lte, min } from "drizzle-orm";
import { asUserId, type NoticeMailStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { approvalRequests, noticeMail } from "./schema";

export function createPostgresNoticeMailStore(db: PostgresConnection): NoticeMailStore {
  const scope = (input: Parameters<NoticeMailStore["countPending"]>[0]) =>
    and(
      eq(noticeMail.clientInstanceId, input.clientInstanceId),
      eq(noticeMail.userId, input.userId),
      lte(noticeMail.dueAt, new Date(input.before))
    );
  return {
    async enqueue(input) {
      await db
        .insert(noticeMail)
        .values({ ...input, dueAt: new Date(input.dueAt) })
        .onConflictDoNothing();
    },
    async dueRecipients(input) {
      const rows = await db
        .select({ userId: noticeMail.userId, dueAt: min(noticeMail.dueAt) })
        .from(noticeMail)
        .where(
          and(
            eq(noticeMail.clientInstanceId, input.clientInstanceId),
            lte(noticeMail.dueAt, new Date(input.now))
          )
        )
        .groupBy(noticeMail.userId)
        .orderBy(asc(min(noticeMail.dueAt)), asc(noticeMail.userId))
        .limit(input.limit);
      return rows.map((row) => asUserId(row.userId));
    },
    async countPending(input) {
      const [row] = await db
        .select({ count: count() })
        .from(noticeMail)
        .innerJoin(
          approvalRequests,
          and(
            eq(approvalRequests.id, noticeMail.noticeId),
            eq(approvalRequests.clientInstanceId, noticeMail.clientInstanceId)
          )
        )
        .where(and(scope(input), eq(approvalRequests.status, "pending")));
      return row?.count ?? 0;
    },
    async deferPending(input) {
      await db
        .update(noticeMail)
        .set({ dueAt: new Date(input.dueAt) })
        .where(scope(input));
    },
    async removePending(input) {
      await db.delete(noticeMail).where(scope(input));
    }
  };
}
