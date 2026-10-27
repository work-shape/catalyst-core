import { and, asc, count, eq, gt, inArray, lt } from "drizzle-orm";
import { asClientInstanceId, type PlatformReportStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { platformReports, productUsers } from "./schema";

// Who reported which failed run to the operator (PLATFORM-REPORT). The author's row is locked
// while a report is decided, so two clicks of one person are counted one after the other.

const HOUR_MS = 60 * 60 * 1000;

type Input<Method extends keyof PlatformReportStore> = Parameters<PlatformReportStore[Method]>[0];

export function createPostgresPlatformReportStore(db: PostgresConnection): PlatformReportStore {
  return {
    createPlatformReport: (input: Input<"createPlatformReport">) =>
      db.transaction(async (tx) => {
        const [author] = await tx
          .select({ id: productUsers.id })
          .from(productUsers)
          .where(
            and(
              eq(productUsers.clientInstanceId, input.clientInstanceId),
              eq(productUsers.id, input.authorUserId)
            )
          )
          .for("update");
        if (!author) throw new Error("The author of a platform report was not found");
        const own = and(
          eq(platformReports.clientInstanceId, input.clientInstanceId),
          eq(platformReports.authorUserId, input.authorUserId)
        );
        const [before] = await tx
          .select({ id: platformReports.id })
          .from(platformReports)
          .where(and(own, eq(platformReports.agentRunId, input.agentRunId)))
          .limit(1);
        if (before) return { status: "duplicate" as const };
        const createdAt = new Date(input.createdAt);
        const [recent] = await tx
          .select({ count: count() })
          .from(platformReports)
          .where(and(own, gt(platformReports.createdAt, new Date(createdAt.getTime() - HOUR_MS))));
        if ((recent?.count ?? 0) >= input.perHour) return { status: "limited" as const };
        await tx.insert(platformReports).values({
          id: input.id,
          clientInstanceId: input.clientInstanceId,
          agentRunId: input.agentRunId,
          authorUserId: input.authorUserId,
          errorCode: input.errorCode,
          createdAt
        });
        return {
          status: "created" as const,
          record: {
            id: input.id,
            clientInstanceId: asClientInstanceId(input.clientInstanceId),
            agentRunId: input.agentRunId,
            authorUserId: input.authorUserId,
            errorCode: input.errorCode,
            createdAt: createdAt.toISOString()
          }
        };
      }),

    async deletePlatformReport(input) {
      await db
        .delete(platformReports)
        .where(
          and(
            eq(platformReports.clientInstanceId, input.clientInstanceId),
            eq(platformReports.id, input.id)
          )
        );
    },

    async deletePlatformReportsBefore(input) {
      const due = db
        .select({ id: platformReports.id })
        .from(platformReports)
        .where(
          and(
            eq(platformReports.clientInstanceId, input.clientInstanceId),
            lt(platformReports.createdAt, input.before)
          )
        )
        .orderBy(asc(platformReports.createdAt))
        .limit(input.limit);
      const removed = await db
        .delete(platformReports)
        .where(inArray(platformReports.id, due))
        .returning({ id: platformReports.id });
      return removed.length;
    }
  };
}
