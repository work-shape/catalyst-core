import {
  AppError,
  approvalDecisionNote,
  readApprovalDecisionMetadata,
  type ClientInstanceId
} from "@work-shape/catalyst-core";
import { and, eq, or, sql } from "drizzle-orm";
import { isLockNotAvailable } from "./postgres-approval-request-operations";
import type { PostgresTransaction } from "./postgres-database";
import {
  approvalRequests,
  configAssetRevisions,
  connectionBindings,
  conversations,
  feedback,
  liveOnceRuns,
  liveOnceSwitches,
  messages,
  operationRuns,
  shippedGuardrailSwitches,
  workflowRuns
} from "./schema";

/**
 * The stored copies of a person's name, e-mail or identity-provider id that their account
 * deletion empties (access-and-permissions.md, Deleting an account), as `table.column`. The id
 * beside each copy stays. A schema test holds every column that copies a person's label or
 * actor to this list or to the kept list beside it, so a new copy joins one of them.
 */
export const ERASED_PERSON_COPIES = [
  "approval_requests.requested_by",
  "approval_requests.decision",
  "approval_requests.payload",
  "messages.metadata",
  "messages.text",
  "operation_runs.actor",
  "operation_runs.decision",
  "workflow_runs.started_by",
  "config_asset_revisions.actor",
  "feedback.handled_by_label",
  "shipped_guardrail_switches.switched_by_label",
  "live_once_switches.switched_by_label",
  "live_once_runs.switched_by_label",
  "conversations.created_by_external_user_id",
  "connection_bindings.account_label"
] as const;

/**
 * Columns that hold a label or an actor and are not emptied, each with the reason. Audit keeps
 * its actor until `retention.auditDays`; the rest name no person or go with the person's rows.
 */
export const KEPT_LABEL_COLUMNS: Readonly<Record<string, string>> = {
  "audit_events.actor": "kept until retention.auditDays, the minimal audit record",
  "product_users.display_label": "the user row itself, deleted with the account",
  "user_identities.display_label": "deleted with the user row (cascade)",
  "standalone_auth_profiles.display_label": "the password sign-in, deleted first in the deletion",
  "service_principals.display_label": "a technical account, not a person",
  "workflow_runs.principal_label": "the technical account a run runs as",
  "workflow_runs.item_label": "a loop item's text, content of the run",
  "workflow_step_runs.iteration_label": "a loop item's text, content of the run",
  "api_connect_codes.client_label": "the name a client gives itself, short-lived"
};

/**
 * Empties every stored copy of the person's name, e-mail and identity-provider id outside audit,
 * and deletes their personal connection bindings. Runs in the transaction that deletes the user
 * row, after the bindings' sign-ins ended. Each statement matches only what still holds a copy,
 * so a repeated pass changes nothing.
 */
export async function eraseStoredPersonCopies(
  tx: PostgresTransaction,
  input: { clientInstanceId: ClientInstanceId; userId: string }
): Promise<void> {
  const { clientInstanceId, userId } = input;

  // A request someone is deciding right now is locked by the decision, which may take a
  // while. The deletion does not wait for it: it fails this pass, which rolls back and keeps
  // the account, and the next pass empties the request once the decision has ended.
  await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.clientInstanceId, clientInstanceId),
        sql`(${approvalRequests.requestedBy}->>'id' = ${userId}
          or ${approvalRequests.decision}->>'decidedBy' = ${userId}
          or ${approvalRequests.decision}->'reversion'->>'revertedBy' = ${userId}
          or ${approvalRequests.payload}->'actor'->>'id' = ${userId})`
      )
    )
    .for("update", { noWait: true })
    .catch((error: unknown) => {
      if (isLockNotAvailable(error)) {
        throw new AppError(
          "CONFLICT",
          "An approval request of this account is being decided; the deletion goes on in its next pass"
        );
      }
      throw error;
    });

  await tx
    .update(approvalRequests)
    .set({
      requestedBy: sql`jsonb_set(${approvalRequests.requestedBy}, '{displayLabel}', '""')`
    })
    .where(
      and(
        eq(approvalRequests.clientInstanceId, clientInstanceId),
        sql`${approvalRequests.requestedBy}->>'id' = ${userId}`,
        sql`${approvalRequests.requestedBy}->>'displayLabel' <> ''`
      )
    );
  await tx
    .update(approvalRequests)
    .set({ decision: sql`jsonb_set(${approvalRequests.decision}, '{decidedByLabel}', '""')` })
    .where(
      and(
        eq(approvalRequests.clientInstanceId, clientInstanceId),
        sql`${approvalRequests.decision}->>'decidedBy' = ${userId}`,
        sql`${approvalRequests.decision}->>'decidedByLabel' <> ''`
      )
    );
  await tx
    .update(approvalRequests)
    .set({
      decision: sql`jsonb_set(${approvalRequests.decision}, '{reversion,revertedByLabel}', '""')`
    })
    .where(
      and(
        eq(approvalRequests.clientInstanceId, clientInstanceId),
        sql`${approvalRequests.decision}->'reversion'->>'revertedBy' = ${userId}`,
        sql`${approvalRequests.decision}->'reversion'->>'revertedByLabel' <> ''`
      )
    );
  // A held call's request names its caller, and while it waits how they were signed in; an
  // App publish also names the person whose audience it was.
  await tx
    .update(approvalRequests)
    .set({
      payload: sql`case
        when ${approvalRequests.payload}->'subject' ? 'audiencePersonName'
        then jsonb_set(
          jsonb_set(${approvalRequests.payload}, '{actor}',
            jsonb_set(${approvalRequests.payload}->'actor', '{label}', '""') - 'externalUserId'),
          '{subject,audiencePersonName}', '""')
        else jsonb_set(${approvalRequests.payload}, '{actor}',
          jsonb_set(${approvalRequests.payload}->'actor', '{label}', '""') - 'externalUserId')
        end`
    })
    .where(
      and(
        eq(approvalRequests.clientInstanceId, clientInstanceId),
        sql`${approvalRequests.payload}->'actor'->>'id' = ${userId}`,
        sql`(${approvalRequests.payload}->'actor'->>'label' <> ''
          or ${approvalRequests.payload}->'actor' ? 'externalUserId'
          or ${approvalRequests.payload}->'subject'->>'audiencePersonName' <> '')`
      )
    );

  // An approval decision in a Conversation names who decided, in its metadata and in the note
  // the model reads. The note is written again from the emptied metadata.
  const decisions = await tx
    .select({ id: messages.id, metadata: messages.metadata })
    .from(messages)
    .where(
      and(
        eq(messages.clientInstanceId, clientInstanceId),
        sql`${messages.metadata}->'agentRuntime'->>'kind' = 'approval_decision'`,
        sql`${messages.metadata}->'agentRuntime'->>'decidedBy' = ${userId}`,
        sql`${messages.metadata}->'agentRuntime'->>'decidedByLabel' <> ''`
      )
    );
  for (const row of decisions) {
    const decision = readApprovalDecisionMetadata(row.metadata);
    await tx
      .update(messages)
      .set({
        metadata: sql`jsonb_set(${messages.metadata}, '{agentRuntime,decidedByLabel}', '""')`,
        // A decision this release cannot read keeps no note that names the person either.
        text: decision ? approvalDecisionNote({ ...decision, decidedByLabel: "" }) : ""
      })
      .where(eq(messages.id, row.id));
  }

  await tx
    .update(operationRuns)
    .set({ actor: sql`jsonb_set(${operationRuns.actor}, '{label}', '""')` })
    .where(
      and(
        eq(operationRuns.clientInstanceId, clientInstanceId),
        eq(operationRuns.actorKind, "user"),
        eq(operationRuns.actorId, userId),
        sql`${operationRuns.actor}->>'label' <> ''`
      )
    );
  await tx
    .update(operationRuns)
    .set({ decision: sql`jsonb_set(${operationRuns.decision}, '{byLabel}', '""')` })
    .where(
      and(
        eq(operationRuns.clientInstanceId, clientInstanceId),
        sql`${operationRuns.decision}->>'by' = ${userId}`,
        sql`${operationRuns.decision}->>'byLabel' <> ''`
      )
    );

  await tx
    .update(workflowRuns)
    .set({ startedBy: sql`jsonb_set(${workflowRuns.startedBy}, '{label}', '""')` })
    .where(
      and(
        eq(workflowRuns.clientInstanceId, clientInstanceId),
        sql`${workflowRuns.startedBy}->>'kind' = 'user'`,
        sql`${workflowRuns.startedBy}->>'id' = ${userId}`,
        sql`${workflowRuns.startedBy}->>'label' <> ''`
      )
    );

  await tx
    .update(configAssetRevisions)
    .set({
      actor: sql`jsonb_set(${configAssetRevisions.actor}, '{displayLabel}', '""') - 'externalUserId'`
    })
    .where(
      and(
        eq(configAssetRevisions.clientInstanceId, clientInstanceId),
        sql`${configAssetRevisions.actor}->>'userId' = ${userId}`,
        sql`(${configAssetRevisions.actor}->>'displayLabel' <> ''
          or ${configAssetRevisions.actor} ? 'externalUserId')`
      )
    );

  await tx
    .update(feedback)
    .set({ handledByLabel: "" })
    .where(
      and(
        eq(feedback.clientInstanceId, clientInstanceId),
        eq(feedback.handledByUserId, userId),
        sql`${feedback.handledByLabel} <> ''`
      )
    );
  await tx
    .update(shippedGuardrailSwitches)
    .set({ switchedByLabel: "" })
    .where(
      and(
        eq(shippedGuardrailSwitches.clientInstanceId, clientInstanceId),
        eq(shippedGuardrailSwitches.switchedById, userId)
      )
    );
  await tx
    .update(liveOnceSwitches)
    .set({ switchedByLabel: "" })
    .where(
      and(
        eq(liveOnceSwitches.clientInstanceId, clientInstanceId),
        eq(liveOnceSwitches.switchedById, userId)
      )
    );
  await tx
    .update(liveOnceRuns)
    .set({ switchedByLabel: "" })
    .where(
      and(
        eq(liveOnceRuns.clientInstanceId, clientInstanceId),
        eq(liveOnceRuns.switchedById, userId)
      )
    );

  // The Conversations that outlive the account keep their creator's id, not the identity
  // provider's. An empty string, not null: the Conversation check and every release's reader
  // require a value on a chat Conversation.
  await tx
    .update(conversations)
    .set({ createdByExternalUserId: "" })
    .where(
      and(
        eq(conversations.clientInstanceId, clientInstanceId),
        eq(conversations.createdByUserId, userId),
        sql`${conversations.createdByExternalUserId} <> ''`
      )
    );

  // The person's own sign-ins at outside systems, revoked when they were closed, go with their
  // account label and account id.
  await tx
    .delete(connectionBindings)
    .where(
      and(
        eq(connectionBindings.clientInstanceId, clientInstanceId),
        or(
          eq(connectionBindings.userId, userId),
          eq(connectionBindings.subject, `user:${userId}`),
          eq(connectionBindings.subject, `person_context:user:${userId}`)
        )
      )
    );
}
