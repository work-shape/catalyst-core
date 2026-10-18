import { alias } from "drizzle-orm/pg-core";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { ClientInstanceId } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { workflowRuns } from "./schema/workflowRuns";

/**
 * One grouped count for the requested page, shared by run reads and root failure notices.
 * The engine caps run depth at two: rootRunId covers a root's whole tree, parentRunId a
 * non-root's children. Grouping both avoids a separate count per run and sibling leakage.
 * A persisted failed-item count makes successful runs with failed items failures here too.
 * Notices include the root's own failure; read models count only descendants.
 */
export async function countWorkflowFailures(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; runIds: readonly string[]; includeRoot?: boolean }
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (input.runIds.length === 0) return counts;
  const requested = new Set(input.runIds);
  // Resolve a non-root's tree first: the partial index can then constrain both columns,
  // instead of scanning every failure of an instance to check parentRunId.
  const ancestor = alias(workflowRuns, "requested_run");
  const roots = db
    .select({ root: sql<string>`coalesce(${ancestor.rootRunId}, ${ancestor.id})` })
    .from(ancestor)
    .where(
      and(
        eq(ancestor.clientInstanceId, input.clientInstanceId),
        inArray(sql<string>`${ancestor.id}`, [...input.runIds])
      )
    );
  const rows = await db
    .select({
      root: workflowRuns.rootRunId,
      parent: workflowRuns.parentRunId,
      count: sql<number>`count(*)::integer`
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.clientInstanceId, input.clientInstanceId),
        // Literal predicate matches the partial index even for a generic prepared plan.
        sql`(${workflowRuns.status} in ('failed', 'limit_reached') or ${workflowRuns.failedItemCount} > 0)`,
        // A successor carries prior failures; count a completed Lauf once, at its last part.
        ne(workflowRuns.status, "continued"),
        inArray(workflowRuns.rootRunId, roots),
        or(
          inArray(sql<string>`${workflowRuns.rootRunId}`, [...input.runIds]),
          inArray(sql<string>`${workflowRuns.parentRunId}`, [...input.runIds])
        ),
        input.includeRoot ? undefined : ne(workflowRuns.id, workflowRuns.rootRunId)
      )
    )
    .groupBy(workflowRuns.rootRunId, workflowRuns.parentRunId);
  for (const row of rows) {
    // A direct child names the same root and parent: count it once for that ancestor.
    for (const id of new Set([row.root, row.parent])) {
      if (id !== null && requested.has(id)) counts.set(id, (counts.get(id) ?? 0) + row.count);
    }
  }
  return counts;
}
