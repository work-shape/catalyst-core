import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { approvalRequests, conversations, operationRuns } from "./schema";
import { workflowRuns } from "./schema/workflowRuns";

// A call or request that belongs to a Workflow run whose values are already pruned: through the
// run thread its agent made it in, or as a call of the run's own steps (origin `workflow`). What
// is written there after the prune (a call approved before it and executed after, a decision
// made after it) keeps what the prune keeps and no more. One that belongs to no run is as ever.

const prunedRun = (clientInstanceId: AnyColumn, runId: SQL) =>
  sql`exists (select 1 from ${workflowRuns}
    where ${workflowRuns.clientInstanceId} = ${clientInstanceId}
      and ${workflowRuns.id} = ${runId}
      and ${workflowRuns.dataPrunedAt} is not null)`;

/** The conversation of the row at hand is a thread of a pruned run. */
export const isPrunedRunThread = prunedRun(
  conversations.clientInstanceId,
  sql`${conversations.workflowRunId}`
);

/** The conversation is a thread of a pruned run. Not for a statement on `conversations`. */
const prunedRunThread = (clientInstanceId: AnyColumn, conversationId: SQL | AnyColumn) =>
  prunedRun(
    clientInstanceId,
    sql`(select ${conversations.workflowRunId} from ${conversations}
      where ${conversations.clientInstanceId} = ${clientInstanceId}
        and ${conversations.id} = ${conversationId})`
  );

/** The Operation Run of the row at hand belongs to a pruned run. */
export const callOfPrunedRun = sql`(${prunedRunThread(
  operationRuns.clientInstanceId,
  operationRuns.conversationId
)} or (${operationRuns.originKind} = 'workflow' and ${prunedRun(
  operationRuns.clientInstanceId,
  sql`${operationRuns.origin}->>'workflowRunId'`
)}))`;

/** The approval request of the row at hand belongs to a pruned run, as do the calls it held. */
export const requestOfPrunedRun = sql`(${prunedRunThread(
  approvalRequests.clientInstanceId,
  sql`${approvalRequests.origin}->>'conversationId'`
)} or exists (select 1 from ${operationRuns}
    where ${operationRuns.clientInstanceId} = ${approvalRequests.clientInstanceId}
      and ${operationRuns.id} = ${approvalRequests.payload}->>'runId'
      and ${callOfPrunedRun}))`;

/** The request of the row at hand held a call: its payload names an Operation Run. */
export const heldCallRequest = sql`exists (select 1 from ${operationRuns}
    where ${operationRuns.clientInstanceId} = ${approvalRequests.clientInstanceId}
      and ${operationRuns.id} = ${approvalRequests.payload}->>'runId')`;

/** A JSON value as `jsonb`, for a written value the statement may still drop. */
export const jsonb = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

/**
 * The keys of a JSON object that stay, or null where it holds none. For the values of a pruned
 * run: whitelist rather than subtract, so a key added later does not escape the prune.
 */
export const onlyKeys = (column: SQL | AnyColumn, keys: readonly string[]) =>
  sql`case when ${column} is null then null else (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    from jsonb_each(${column}) where key in (${sql.join(
      keys.map((key) => sql`${key}`),
      sql`, `
    )})) end`;

/**
 * What a held call's settled request keeps of what its call came to: which call and request,
 * how it was carried out, and the code of an error without its message.
 */
export const minimizedHeldCallResult = (applyResult: SQL | AnyColumn) =>
  sql`${onlyKeys(applyResult, ["runId", "requestId", "execution", "approvalRequestId"])}
    || case when jsonb_typeof(${applyResult}->'error') = 'object'
      then jsonb_build_object('error', ${onlyKeys(sql`${applyResult}->'error'`, ["code"])})
      else '{}'::jsonb end`;
