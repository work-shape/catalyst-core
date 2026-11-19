import { and, eq, isNull, lt } from "drizzle-orm";
import type { ToolCodeCall, ToolCodeCallsStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { toolCodeCalls } from "./schema/toolCodeCalls";

function mapCall(row: typeof toolCodeCalls.$inferSelect): ToolCodeCall {
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId,
    conversationId: row.conversationId,
    tool: row.tool,
    revisionId: row.revisionId,
    input: row.input,
    timeoutSeconds: row.timeoutSeconds,
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(row.request ? { request: row.request } : {}),
    ...(row.answer ? { answer: row.answer } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.toISOString() } : {})
  };
}

/** The calls of code tools while they run (TOOL-2b). */
export function createPostgresToolCodeCallsStore(db: PostgresConnection): ToolCodeCallsStore {
  return {
    async createToolCodeCall(call) {
      await db.insert(toolCodeCalls).values({
        id: call.id,
        clientInstanceId: call.clientInstanceId,
        conversationId: call.conversationId,
        tool: call.tool,
        revisionId: call.revisionId,
        input: call.input,
        timeoutSeconds: call.timeoutSeconds,
        createdAt: new Date(call.createdAt)
      });
    },
    async getToolCodeCall({ clientInstanceId, id }) {
      const [row] = await db
        .select()
        .from(toolCodeCalls)
        .where(and(eq(toolCodeCalls.clientInstanceId, clientInstanceId), eq(toolCodeCalls.id, id)))
        .limit(1);
      return row ? mapCall(row) : undefined;
    },
    async startToolCodeCall({ clientInstanceId, id, startedAt }) {
      const started = await db
        .update(toolCodeCalls)
        .set({ startedAt: new Date(startedAt), request: null, answer: null })
        .where(
          and(
            eq(toolCodeCalls.clientInstanceId, clientInstanceId),
            eq(toolCodeCalls.id, id),
            isNull(toolCodeCalls.outcome)
          )
        )
        .returning({ id: toolCodeCalls.id });
      return started.length > 0;
    },
    async requestToolCodeCall({ clientInstanceId, id, request }) {
      const written = await db
        .update(toolCodeCalls)
        .set({ request })
        .where(
          and(
            eq(toolCodeCalls.clientInstanceId, clientInstanceId),
            eq(toolCodeCalls.id, id),
            isNull(toolCodeCalls.outcome)
          )
        )
        .returning({ id: toolCodeCalls.id });
      return written.length > 0;
    },
    async answerToolCodeCall({ clientInstanceId, id, answer }) {
      const written = await db
        .update(toolCodeCalls)
        .set({ answer })
        .where(
          and(
            eq(toolCodeCalls.clientInstanceId, clientInstanceId),
            eq(toolCodeCalls.id, id),
            isNull(toolCodeCalls.outcome)
          )
        )
        .returning({ id: toolCodeCalls.id });
      return written.length > 0;
    },
    async finishToolCodeCall({ clientInstanceId, id, outcome, finishedAt }) {
      const finished = await db
        .update(toolCodeCalls)
        .set({ outcome, input: {}, request: null, answer: null, finishedAt: new Date(finishedAt) })
        .where(
          and(
            eq(toolCodeCalls.clientInstanceId, clientInstanceId),
            eq(toolCodeCalls.id, id),
            isNull(toolCodeCalls.outcome)
          )
        )
        .returning({ id: toolCodeCalls.id });
      return finished.length > 0;
    },
    async removeToolCodeCall({ clientInstanceId, id }) {
      await db
        .delete(toolCodeCalls)
        .where(and(eq(toolCodeCalls.clientInstanceId, clientInstanceId), eq(toolCodeCalls.id, id)));
    },
    async pruneToolCodeCalls({ clientInstanceId, before }) {
      const removed = await db
        .delete(toolCodeCalls)
        .where(
          and(
            eq(toolCodeCalls.clientInstanceId, clientInstanceId),
            lt(toolCodeCalls.createdAt, new Date(before))
          )
        )
        .returning({ id: toolCodeCalls.id });
      return removed.length;
    }
  };
}
