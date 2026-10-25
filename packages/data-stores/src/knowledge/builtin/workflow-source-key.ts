import { z } from "zod";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import type { KnowledgeWorkflowIncarnation } from "../source-port";

// KBW-2c: a Workflow-fed source lives as long as its Workflow. Recreating a deleted Workflow's
// name reuses its asset row and id, so neither tells two Workflows apart: the source key
// carries the revision that created the Workflow, `workflow:<id>@<revision>`. A source of the
// release before (`workflow:<id>`, no revision) is adopted by the Workflow whose passes all
// came after its creation, and otherwise ended.

type WorkflowIncarnation = KnowledgeWorkflowIncarnation;

function workflowSourceKey(workflow: WorkflowIncarnation): string {
  return `workflow:${workflow.workflowId}@${workflow.revision}`;
}

/** What the resolution found: the source to use, or that the Workflow's source has ended. */
type WorkflowSourceResolution =
  { sourceId: string; endedLegacy: boolean } | { ended: true } | undefined;

/**
 * The source of this Workflow in the store, in a transaction of the store. `create` makes it
 * where there is none, as the Workflow's first `ingest` does; a `withdraw` makes none.
 */
export async function resolveWorkflowSource(
  sql: Pick<PostgresChangeStatements, "run">,
  workflow: WorkflowIncarnation,
  create: boolean
): Promise<WorkflowSourceResolution> {
  // Two calls of one Workflow resolve one after the other.
  await sql.run("select pg_advisory_xact_lock(hashtext('catalyst_kb.workflow_source:' || $1))", [
    workflow.workflowId
  ]);
  const [own] = z
    .array(z.object({ source_id: z.string(), ended: z.boolean() }))
    .parse(
      await sql.run(
        "select source_id,ended_at is not null as ended from catalyst_kb.source_cursors where kind='workflow' and workflow_id=$1::text and workflow_revision=$2::int",
        [workflow.workflowId, workflow.revision]
      )
    );
  if (own) return own.ended ? { ended: true } : { sourceId: own.source_id, endedLegacy: false };
  const [legacy] = z.array(z.object({ source_id: z.string(), before: z.boolean() })).parse(
    await sql.run(
      `select c.source_id,coalesce((select min(r.started_at) from catalyst_kb.sync_runs r where r.source_id=c.source_id) < $2::timestamptz,false) as before
         from catalyst_kb.source_cursors c
         where c.source_id='workflow:' || $1::text and c.workflow_revision is null and c.ended_at is null`,
      [workflow.workflowId, workflow.createdAt]
    )
  );
  // Every pass of a source of the release before came after this Workflow was created: it is
  // this Workflow's, and keeps its key.
  if (legacy && !legacy.before) {
    await sql.run(
      "update catalyst_kb.source_cursors set workflow_revision=$2::int where source_id=$1::text",
      [legacy.source_id, workflow.revision]
    );
    return { sourceId: legacy.source_id, endedLegacy: false };
  }
  if (!create) return undefined;
  // A pass of a deleted Workflow of the same name fed it: it ends, and its items go.
  if (legacy)
    await sql.run(
      "update catalyst_kb.source_cursors set ended_at=now() where source_id=$1::text and ended_at is null",
      [legacy.source_id]
    );
  const sourceId = workflowSourceKey(workflow);
  await sql.run(
    "insert into catalyst_kb.source_cursors (source_id,cursor,kind,workflow_id,workflow_revision) values ($1::text,null,'workflow',$2::text,$3::int) on conflict (source_id) do nothing",
    [sourceId, workflow.workflowId, workflow.revision]
  );
  return { sourceId, endedLegacy: legacy !== undefined };
}
