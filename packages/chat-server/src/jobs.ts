import {
  asCollaborationWorkspaceId,
  asConversationId,
  asUserId,
  createAgentRunUpkeepJobs,
  defineJobHandler,
  defineSchedule,
  type JobSchedule,
  type RegisteredJobHandler
} from "@vivd-catalyst/core";
import { completeAccountDeletion, recordAccountDeletionStalled } from "./account-deletion";
import { ConversationWorkflow } from "./conversation-workflow";
import {
  adoptLegacyJobsJob,
  adoptLegacyJobsSchedule,
  backfillUsageAttributionJob,
  backfillUsageAttributionSchedule,
  cleanUpExecutionWorkspacesJob,
  deleteAccountJob,
  deleteWorkspaceJob,
  expireConversationsJob,
  expireConversationsSchedule,
  generateConversationTitleJob,
  pruneAuditEventsJob,
  pruneAuditEventsSchedule,
  pruneJobsJob,
  pruneJobsSchedule,
  reconcileUsageJob,
  reconcileUsageSchedule,
  recoverAbandonedModelCallsJob,
  recoverAbandonedModelCallsSchedule,
  retiredRecoverAgentRunsJob
} from "./job-kinds";
import { ConversationRetentionWorkflow } from "./retention";
import { deletionActor } from "./subject-deletion";
import type { ChatServerOptions, ConversationRetentionOptions } from "./types";
import { createUsageAttributionBackfill, createUsageReconciliation } from "./usage-backfill";
import { ExecutionWorkspaceCleanupWorkflow } from "./workspace-cleanup";
import { completeWorkspaceDeletion, recordWorkspaceDeletionStalled } from "./workspace-deletion";

/** The job kinds the API process serves, with their schedules. */
export interface ChatServerJobs {
  handlers: RegisteredJobHandler[];
  schedules: JobSchedule[];
}

/** What a test sets to drive a handler with its own clock and limits. */
export interface ChatServerJobOptions {
  retention?: ConversationRetentionOptions;
  now?: () => Date;
}

export function createChatServerJobs(
  options: ChatServerOptions,
  jobOptions: ChatServerJobOptions = {}
): ChatServerJobs {
  const now = jobOptions.now ?? (() => new Date());
  const conversations = new ConversationWorkflow(options);
  const retention = new ConversationRetentionWorkflow(options, {
    now,
    ...jobOptions.retention
  });
  const usageAttributionBackfill = createUsageAttributionBackfill(options, now);
  const usageReconciliation = createUsageReconciliation(options, now);

  const handlers: RegisteredJobHandler[] = [
    defineJobHandler({
      kind: generateConversationTitleJob,
      slots: 4,
      run: (job, control) =>
        conversations.generateTitleForConversation(
          {
            conversationId: asConversationId(job.payload.conversationId),
            userId: asUserId(job.payload.userId),
            correlationId: job.correlationId
          },
          control
        )
    }),
    // A deletion that still waits throws, and the executor tries again after the backoff.
    defineJobHandler({
      kind: deleteAccountJob,
      slots: DELETION_SLOTS,
      async run(job, control) {
        await completeAccountDeletion(
          options,
          {
            userId: asUserId(job.payload.userId),
            requestedBy: job.payload.requestedBy,
            actor: await deletionActor(options, asUserId(job.payload.actorUserId)),
            correlationId: job.correlationId
          },
          (fn) => control.transaction(fn)
        );
      },
      onExhausted: (job, stores) =>
        recordAccountDeletionStalled(stores, options, {
          userId: asUserId(job.payload.userId),
          requestedBy: job.payload.requestedBy,
          correlationId: job.correlationId
        })
    }),
    defineJobHandler({
      kind: deleteWorkspaceJob,
      slots: DELETION_SLOTS,
      async run(job, control) {
        await completeWorkspaceDeletion(
          options,
          {
            collaborationWorkspaceId: asCollaborationWorkspaceId(
              job.payload.collaborationWorkspaceId
            ),
            actor: await deletionActor(options, asUserId(job.payload.actorUserId)),
            correlationId: job.correlationId
          },
          (fn) => control.transaction(fn)
        );
      },
      onExhausted: (job, stores) =>
        recordWorkspaceDeletionStalled(stores, options, {
          collaborationWorkspaceId: asCollaborationWorkspaceId(
            job.payload.collaborationWorkspaceId
          ),
          correlationId: job.correlationId
        })
    }),
    defineJobHandler({
      kind: expireConversationsJob,
      slots: 1,
      run: (_job, control) => retention.run(control.logger)
    }),
    defineJobHandler({
      kind: retiredRecoverAgentRunsJob,
      slots: 1,
      // No schedule names the kind, so no next tick follows the one this ends.
      run: () => Promise.resolve()
    }),
    defineJobHandler({
      kind: pruneAuditEventsJob,
      slots: 1,
      async run(job, control) {
        // The deletion and its record commit together, or neither does.
        await control.transaction(async (stores) => {
          const { deletedCount, createdBefore } = await stores.audit.deleteAuditEventsOlderThan({
            clientInstanceId: options.clientInstanceId,
            days: options.config.retention.auditDays
          });
          await stores.audit.appendAuditEvent({
            clientInstanceId: options.clientInstanceId,
            type: "audit.pruned",
            status: "success",
            correlationId: job.correlationId,
            metadata: {
              deletedCount,
              createdBefore,
              auditDays: options.config.retention.auditDays
            }
          });
        });
      }
    }),
    defineJobHandler({
      kind: pruneJobsJob,
      slots: 1,
      async run(_job, control) {
        const pruned = await control.transaction((stores) =>
          stores.jobs.pruneEndedJobs({ clientInstanceId: options.clientInstanceId })
        );
        if (pruned.completedCount + pruned.failedCount > 0)
          control.logger.info(pruned, "Pruned ended jobs");
      }
    }),
    defineJobHandler({
      kind: adoptLegacyJobsJob,
      slots: 1,
      async run(_job, control) {
        // An enqueue under a live dedupe key inserts nothing, so a tick may run twice.
        const previews = await options.stores.files.adoptArtifactPreviewJobs({
          clientInstanceId: options.clientInstanceId,
          limit: LEGACY_ADOPTION_BATCH_SIZE
        });
        const attachments =
          (await options.attachments?.adoptLegacyAttachments?.({
            limit: LEGACY_ADOPTION_BATCH_SIZE
          })) ?? 0;
        if (previews + attachments > 0)
          control.logger.info({ previews, attachments }, "Adopted rows without a job");
      }
    }),
    defineJobHandler({
      kind: backfillUsageAttributionJob,
      slots: 1,
      run: (_job, control) => usageAttributionBackfill.run(control)
    }),
    defineJobHandler({
      kind: recoverAbandonedModelCallsJob,
      slots: 1,
      async run(_job, control) {
        // Each release is one statement that changes a call only while it is still pending,
        // so a tick that was taken over releases nothing twice.
        const released = await options.usageGovernance.releaseAbandonedModelCalls({
          clientInstanceId: options.clientInstanceId,
          signal: control.signal
        });
        if (released > 0)
          control.logger.warn({ released }, "Released model calls that never ended");
      }
    }),
    defineJobHandler({
      kind: reconcileUsageJob,
      slots: 1,
      run: (_job, control) => usageReconciliation.run(control)
    })
  ];
  const schedules: JobSchedule[] = [
    expireConversationsSchedule,
    pruneAuditEventsSchedule,
    pruneJobsSchedule,
    adoptLegacyJobsSchedule,
    backfillUsageAttributionSchedule,
    recoverAbandonedModelCallsSchedule,
    reconcileUsageSchedule
  ];

  // A run executes in an Agent Run worker. Its upkeep is served here as well, so a run whose
  // worker was killed is failed after its lease time, and a run no worker takes is failed
  // after its queue limit, while no worker is up.
  const agentRunUpkeep = createAgentRunUpkeepJobs({
    clientInstanceId: options.clientInstanceId,
    stores: options.stores
  });
  handlers.push(...agentRunUpkeep.handlers);
  schedules.push(...agentRunUpkeep.schedules);

  const cleanup = options.executionWorkspaceCleanup;
  if (cleanup) {
    const workspaceCleanup = new ExecutionWorkspaceCleanupWorkflow(options, {
      now,
      ...cleanup.jobOptions
    });
    handlers.push(
      defineJobHandler({
        kind: cleanUpExecutionWorkspacesJob,
        slots: 1,
        async run() {
          await workspaceCleanup.cleanupDeletedConversationWorkspaces();
        }
      })
    );
    schedules.push(
      defineSchedule({
        kind: cleanUpExecutionWorkspacesJob,
        every: cleanup.jobOptions?.checkIntervalMs ?? DEFAULT_WORKSPACE_CLEANUP_INTERVAL_MS
      })
    );
  }

  return { handlers, schedules };
}

const DEFAULT_WORKSPACE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
// Deletions of accounts or of workspaces this process runs at once, per kind.
const DELETION_SLOTS = 2;
// Rows one tick of the adopt schedule gives a job, per kind. It keeps a tick inside its lease
// after an upgrade with a long backlog; the next tick, a minute later, takes the rest.
const LEGACY_ADOPTION_BATCH_SIZE = 500;
